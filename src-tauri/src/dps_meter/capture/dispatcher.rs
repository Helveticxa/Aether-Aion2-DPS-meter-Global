//! Sorts captured packets into connections and feeds the game's to a parser.
//!
//! Every TCP direction is a flow. A new flow is probed: its bytes are kept
//! from the first one, and once it carries the game's heartbeat twice it is
//! the game's, and parsing starts from the top of what was kept. Keeping them
//! matters on a zone change: the game opens a new connection for every map and
//! dungeon, and the packets sent before its first heartbeat used to be thrown
//! away because nothing was listening yet.
//!
//! A flow that shows no heartbeat within the probe window, or starts like a
//! TLS record, is ignored from then on and costs nothing more than a lookup.
//!
//! A newly recognised game connection replacing the one before it is a zone
//! change. Entity ids are handed out per zone -- the same character is `9231`
//! in town and `802` in the dungeon -- so whatever the meter knew by id is
//! stale from that moment, and the fight in the old zone is over.

use std::collections::{HashMap, VecDeque};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, RwLock,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::dps_meter::capture::capturer::CapturedPacket;
use crate::dps_meter::capture::channel::Channel;
use crate::dps_meter::capture::ping_tracker::PingTracker;
use crate::dps_meter::capture::processor::{StreamProcessor, StreamStats, HEARTBEAT};
use crate::dps_meter::capture::recorder::PacketRecorder;
use crate::dps_meter::capture::tcp_reassembler::{TcpFlowKey, TcpReassembler};
use crate::dps_meter::config::SharedDpsMeterConfig;
use crate::dps_meter::storage::data_storage::DataStorage;
use crate::plugins::logger::AppLogger;

const TLS_CONTENT_TYPES: [u8; 4] = [0x14, 0x15, 0x16, 0x17];
const TLS_VERSIONS: [u8; 5] = [0x00, 0x01, 0x02, 0x03, 0x04];

/// Heartbeats a flow must show, within the window, to count as the game's.
/// The server sends about twenty a second; two rules out a stray match in
/// someone else's bytes.
const CONFIRM_HEARTBEATS: usize = 2;
const CONFIRM_WINDOW: Duration = Duration::from_secs(3);
/// How long a flow may go without a heartbeat before it is ignored.
const PROBE_WINDOW: Duration = Duration::from_secs(15);
/// Bytes kept from a flow while it is probed. A zone's opening burst before
/// the first heartbeat is a few hundred bytes to a few kilobytes.
const PROBE_BUFFER_LIMIT: usize = 256 * 1024;
/// The packets logged when capture starts, to show what it is seeing.
const LOGGED_PACKETS: usize = 4;
/// Game traffic counts as current while a heartbeat arrived this recently.
const GAME_TRAFFIC_RECENT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlowRole {
    Probing,
    Game,
    Ignored,
}

struct Flow {
    reassembler: TcpReassembler,
    role: FlowRole,
    first_seen: Instant,
    last_seen: Instant,
    /// What the flow carried while being probed.
    pending: Vec<u8>,
    /// `pending` holds the flow from its first byte. False once a gap or the
    /// buffer limit cut into it.
    pending_from_start: bool,
    heartbeats: VecDeque<Instant>,
    last_heartbeat: Option<Instant>,
    segments: u32,
    processor: Option<StreamProcessor>,
}

impl Flow {
    fn new(now: Instant) -> Self {
        Self {
            reassembler: TcpReassembler::default(),
            role: FlowRole::Probing,
            first_seen: now,
            last_seen: now,
            pending: Vec::new(),
            pending_from_start: true,
            heartbeats: VecDeque::new(),
            last_heartbeat: None,
            segments: 0,
            processor: None,
        }
    }
}

struct DispatcherState {
    data_storage: Arc<DataStorage>,
    config: SharedDpsMeterConfig,
    ping_tracker: Arc<PingTracker>,
    flows: HashMap<TcpFlowKey, Flow>,
    /// The game connection most recently recognised: the current zone. Kept
    /// after the connection itself is gone.
    active: Option<TcpFlowKey>,
    zone_changes: u64,
    logged_packets: usize,
}

impl DispatcherState {
    fn clear(&mut self) {
        self.flows.clear();
        self.active = None;
        self.logged_packets = 0;
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpReassemblyFlowStatus {
    pub connection: String,
    pub source: String,
    pub destination: String,
    pub next_sequence: Option<u32>,
    pub pending_segments: usize,
    pub held_bytes: usize,
    pub retransmits: u64,
    pub gap_skips: u64,
    pub idle_ms: u64,
    pub is_combat_flow: bool,
    pub is_game_flow: bool,
    pub stream: Option<StreamStats>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpReassemblyStatus {
    pub combat_connection: Option<String>,
    pub total_flows: usize,
    pub total_pending_segments: usize,
    pub total_held_bytes: usize,
    pub total_retransmits: u64,
    pub total_gap_skips: u64,
    pub zone_changes: u64,
    pub flows: Vec<TcpReassemblyFlowStatus>,
}

#[derive(Clone)]
pub struct CaptureDispatcher {
    channel: Channel<CapturedPacket>,
    recorder: Arc<PacketRecorder>,
    logger: Arc<AppLogger>,
    running: Arc<AtomicBool>,
    thread: Arc<Mutex<Option<JoinHandle<()>>>>,
    combat_port: Arc<RwLock<Option<String>>>,
    state: Arc<Mutex<DispatcherState>>,
}

impl CaptureDispatcher {
    pub fn new(
        channel: Channel<CapturedPacket>,
        recorder: Arc<PacketRecorder>,
        data_storage: Arc<DataStorage>,
        logger: Arc<AppLogger>,
        ping_tracker: Arc<PingTracker>,
        config: SharedDpsMeterConfig,
    ) -> Self {
        let state = Arc::new(Mutex::new(DispatcherState {
            data_storage,
            config,
            ping_tracker,
            flows: HashMap::new(),
            active: None,
            zone_changes: 0,
            logged_packets: 0,
        }));

        Self {
            channel,
            recorder,
            logger,
            running: Arc::new(AtomicBool::new(false)),
            thread: Arc::new(Mutex::new(None)),
            combat_port: Arc::new(RwLock::new(None)),
            state,
        }
    }

    pub fn start(&self) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }

        let channel = self.channel.clone();
        let recorder = Arc::clone(&self.recorder);
        let logger = Arc::clone(&self.logger);
        let running = Arc::clone(&self.running);
        let combat_port = Arc::clone(&self.combat_port);
        let state = Arc::clone(&self.state);

        let handle = thread::spawn(move || {
            while running.load(Ordering::SeqCst) {
                let Some(packet) = channel.receive(Some(Duration::from_secs(1))) else {
                    continue;
                };

                // Tapped here, before reassembly, so a recording holds exactly
                // what capture produced -- replay then re-runs the real pipeline.
                recorder.record(&packet);

                let mut state = state.lock().unwrap();
                dispatch(&mut state, packet, &logger, &combat_port);
            }
        });

        *self.thread.lock().unwrap() = Some(handle);
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.thread.lock().unwrap().take() {
            let _ = handle.join();
        }
        *self.combat_port.write().unwrap() = None;
    }

    pub fn clear(&self) {
        *self.combat_port.write().unwrap() = None;
        self.state.lock().unwrap().clear();
    }

    /// The connection of the current zone, as `src:port->dst:port`.
    pub fn current_combat_port(&self) -> Option<String> {
        self.combat_port.read().unwrap().clone()
    }

    /// Whether the game's heartbeat has been seen recently on any connection.
    pub fn has_recent_ports(&self) -> bool {
        let now = Instant::now();
        self.state.lock().unwrap().flows.values().any(|flow| {
            flow.role == FlowRole::Game
                && flow
                    .last_heartbeat
                    .is_some_and(|at| now.saturating_duration_since(at) <= GAME_TRAFFIC_RECENT)
        })
    }

    /// Forget flows nobody has used for `max_idle`. Returns the game
    /// connections among them.
    pub fn cleanup_stale_assemblers(&self, max_idle: Duration) -> Vec<String> {
        let now = Instant::now();
        let mut state = self.state.lock().unwrap();
        let mut removed = Vec::new();
        state.flows.retain(|key, flow| {
            let stale = now.saturating_duration_since(flow.last_seen) > max_idle;
            if stale && flow.role == FlowRole::Game {
                removed.push(connection_key(key));
            }
            !stale
        });
        // `active` itself is kept: a connection that comes up after a long
        // loading screen is still a new zone.
        if let Some(active) = state.active {
            if !state.flows.contains_key(&active) {
                *self.combat_port.write().unwrap() = None;
            }
        }
        removed
    }

    /// Unparsed bytes held per game connection.
    pub fn assembler_buffer_sizes(&self) -> HashMap<String, usize> {
        let state = self.state.lock().unwrap();
        state
            .flows
            .iter()
            .filter_map(|(key, flow)| {
                let processor = flow.processor.as_ref()?;
                Some((connection_key(key), processor.buffered()))
            })
            .collect()
    }

    pub fn tcp_reassembly_status(&self) -> TcpReassemblyStatus {
        let now = Instant::now();
        let state = self.state.lock().unwrap();
        let mut flows: Vec<TcpReassemblyFlowStatus> = state
            .flows
            .iter()
            .filter(|(_, flow)| flow.role != FlowRole::Ignored)
            .map(|(key, flow)| TcpReassemblyFlowStatus {
                connection: connection_key(key),
                source: format!("{}:{}", format_ipv4(key.src_ip), key.src_port),
                destination: format!("{}:{}", format_ipv4(key.dst_ip), key.dst_port),
                next_sequence: flow.reassembler.next_sequence(),
                pending_segments: flow.reassembler.pending_segments(),
                held_bytes: flow.reassembler.held_bytes(),
                retransmits: flow.reassembler.retransmits(),
                gap_skips: flow.reassembler.gap_skips(),
                idle_ms: now
                    .saturating_duration_since(flow.last_seen)
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64,
                is_combat_flow: state.active == Some(*key),
                is_game_flow: flow.role == FlowRole::Game,
                stream: flow.processor.as_ref().map(StreamProcessor::stats),
            })
            .collect();
        flows.sort_by(|left, right| {
            right
                .is_combat_flow
                .cmp(&left.is_combat_flow)
                .then_with(|| right.is_game_flow.cmp(&left.is_game_flow))
                .then_with(|| left.idle_ms.cmp(&right.idle_ms))
        });

        TcpReassemblyStatus {
            combat_connection: state.active.as_ref().map(connection_key),
            total_flows: flows.len(),
            total_pending_segments: flows.iter().map(|flow| flow.pending_segments).sum(),
            total_held_bytes: flows.iter().map(|flow| flow.held_bytes).sum(),
            total_retransmits: flows.iter().map(|flow| flow.retransmits).sum(),
            total_gap_skips: flows.iter().map(|flow| flow.gap_skips).sum(),
            zone_changes: state.zone_changes,
            flows,
        }
    }
}

impl Drop for CaptureDispatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

fn dispatch(
    state: &mut DispatcherState,
    mut packet: CapturedPacket,
    logger: &Arc<AppLogger>,
    combat_port: &RwLock<Option<String>>,
) {
    let now = Instant::now();
    let key = TcpFlowKey {
        src_ip: packet.src_ip,
        src_port: packet.src_port,
        dst_ip: packet.dst_ip,
        dst_port: packet.dst_port,
    };

    if state.logged_packets < LOGGED_PACKETS {
        state.logged_packets += 1;
        logger.info(format!(
            "dispatcher packet {} payload_len={}",
            connection_key(&key),
            packet.data.len()
        ));
    }

    let flow = state.flows.entry(key).or_insert_with(|| Flow::new(now));
    flow.last_seen = now;
    if flow.role == FlowRole::Ignored {
        return;
    }

    let gaps_before = flow.reassembler.gap_skips();
    let aligned = flow
        .reassembler
        .feed(packet.sequence, std::mem::take(&mut packet.data));
    if flow.reassembler.gap_skips() != gaps_before {
        // Bytes were lost under the parser: its position means nothing now.
        if let Some(processor) = flow.processor.as_mut() {
            processor.desync();
        }
        flow.pending_from_start = false;
    }
    if aligned.is_empty() {
        return;
    }
    let data = if aligned.len() == 1 {
        aligned.into_iter().next().unwrap_or_default()
    } else {
        aligned.concat()
    };

    let heartbeats = count_heartbeats(&data);
    if heartbeats > 0 {
        flow.last_heartbeat = Some(now);
    }

    match flow.role {
        FlowRole::Game => {
            if heartbeats > 0 {
                // Carrying the heartbeat identifies this host as the game
                // server, which is what region detection keys off.
                crate::dps_meter::region::observe_server_ip(packet.src_ip);
            }
            if let Some(processor) = flow.processor.as_mut() {
                processor.feed(&data, packet.captured_at);
            }
        }
        FlowRole::Probing => {
            flow.segments += 1;
            if flow.segments <= 4 && looks_like_tls_payload(&data) {
                flow.role = FlowRole::Ignored;
                flow.pending = Vec::new();
                return;
            }

            if flow.pending.len() + data.len() > PROBE_BUFFER_LIMIT {
                flow.pending.clear();
                flow.pending_from_start = false;
            }
            flow.pending.extend_from_slice(&data);

            for _ in 0..heartbeats.min(CONFIRM_HEARTBEATS) {
                flow.heartbeats.push_back(now);
            }
            while flow
                .heartbeats
                .front()
                .is_some_and(|at| now.saturating_duration_since(*at) > CONFIRM_WINDOW)
            {
                flow.heartbeats.pop_front();
            }

            if flow.heartbeats.len() >= CONFIRM_HEARTBEATS {
                confirm_game_flow(state, key, packet.captured_at, logger, combat_port);
            } else if now.saturating_duration_since(flow.first_seen) > PROBE_WINDOW {
                flow.role = FlowRole::Ignored;
                flow.pending = Vec::new();
            }
        }
        FlowRole::Ignored => {}
    }
}

/// `key` carries the game's heartbeat: start parsing it, and if it replaces
/// another game connection, the player has changed zone.
fn confirm_game_flow(
    state: &mut DispatcherState,
    key: TcpFlowKey,
    captured_at: f64,
    logger: &Arc<AppLogger>,
    combat_port: &RwLock<Option<String>>,
) {
    match state.active {
        Some(previous) if previous != key => {
            state.zone_changes += 1;
            logger.info(format!(
                "zone change: game connection {} replaces {}",
                connection_key(&key),
                connection_key(&previous)
            ));
        }
        _ => logger.info(format!("game connection {}", connection_key(&key))),
    }
    // Before this connection's first packet is parsed: its opening burst
    // carries the player's id in this zone. Also on the first connection of a
    // session, since an id remembered from earlier belongs to some other zone.
    if state.active != Some(key) {
        state.data_storage.begin_zone();
    }
    state.active = Some(key);
    *combat_port.write().unwrap() = Some(connection_key(&key));

    let mut processor = StreamProcessor::new(
        Arc::clone(&state.data_storage),
        Arc::clone(logger),
        connection_key(&key),
        Arc::clone(&state.config),
        Arc::clone(&state.ping_tracker),
    );
    let Some(flow) = state.flows.get_mut(&key) else {
        return;
    };
    flow.role = FlowRole::Game;
    let pending = std::mem::take(&mut flow.pending);
    processor.start(&pending, flow.pending_from_start, captured_at);
    flow.processor = Some(processor);
    flow.heartbeats.clear();
}

fn count_heartbeats(data: &[u8]) -> usize {
    data.windows(HEARTBEAT.len())
        .filter(|window| *window == HEARTBEAT)
        .count()
}

fn looks_like_tls_payload(data: &[u8]) -> bool {
    data.len() >= 3
        && TLS_CONTENT_TYPES.contains(&data[0])
        && data[1] == 0x03
        && TLS_VERSIONS.contains(&data[2])
}

fn connection_key(key: &TcpFlowKey) -> String {
    format!(
        "{}:{}->{}:{}",
        format_ipv4(key.src_ip),
        key.src_port,
        format_ipv4(key.dst_ip),
        key.dst_port
    )
}

fn format_ipv4(ip: [u8; 4]) -> String {
    format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dps_meter::config::DpsMeterConfig;

    struct Harness {
        state: DispatcherState,
        logger: Arc<AppLogger>,
        combat_port: RwLock<Option<String>>,
        sequences: HashMap<(u16, u16), u32>,
    }

    impl Harness {
        fn new() -> Self {
            let config = Arc::new(RwLock::new(DpsMeterConfig::default()));
            Self {
                state: DispatcherState {
                    data_storage: Arc::new(DataStorage::new(Arc::clone(&config))),
                    config,
                    ping_tracker: Arc::new(PingTracker::new()),
                    flows: HashMap::new(),
                    active: None,
                    zone_changes: 0,
                    logged_packets: LOGGED_PACKETS,
                },
                logger: Arc::new(AppLogger::for_tests()),
                combat_port: RwLock::new(None),
                sequences: HashMap::new(),
            }
        }

        /// Server port `from` sends `data` to client port `to`.
        fn send(&mut self, from: u16, to: u16, data: Vec<u8>) {
            let sequence = self.sequences.entry((from, to)).or_insert(1_000);
            let packet = CapturedPacket {
                src_ip: [127, 0, 0, 1],
                src_port: from,
                dst_ip: [127, 0, 0, 1],
                dst_port: to,
                sequence: *sequence,
                captured_at: 1_791_866_700.0,
                data: data.clone(),
            };
            *sequence = sequence.wrapping_add(data.len() as u32);
            dispatch(&mut self.state, packet, &self.logger, &self.combat_port);
        }
    }

    fn varint(mut value: usize) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let byte = (value & 0x7F) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                return out;
            }
            out.push(byte | 0x80);
        }
    }

    /// `payload` (opcode onwards) framed with its length the way the game
    /// writes it: the varint counts four more than the frame minus itself.
    fn frame(payload: &[u8]) -> Vec<u8> {
        let mut header_len = 1;
        loop {
            let length = varint(payload.len() + 4);
            if length.len() == header_len {
                let mut out = length;
                out.extend_from_slice(payload);
                return out;
            }
            header_len = length.len();
        }
    }

    fn heartbeat() -> Vec<u8> {
        vec![0x0E, 0x00, 0x36, 0x93, 0x05, 0x94, 0x33, 0xA1, 0x01, 0x00, 0x00]
    }

    /// The player's own info packet, `33 36`, padded past 128 bytes the way
    /// the real one is (2,302 bytes in the recording), so that its length
    /// takes two bytes.
    fn own_player(actor_id: u32, name: &str) -> Vec<u8> {
        let mut payload = vec![0x33, 0x36];
        payload.extend(varint(actor_id as usize));
        payload.extend_from_slice(&[0x5F, 0x91, 0xC1, 0x28, 0x37]);
        payload.push(name.len() as u8);
        payload.extend_from_slice(name.as_bytes());
        payload.extend_from_slice(&1101u16.to_le_bytes());
        payload.push(30);
        payload.extend(std::iter::repeat(0x5A).take(400));
        frame(&payload)
    }

    #[test]
    fn frames_are_built_like_the_game_builds_them() {
        assert_eq!(frame(&[0x00, 0x36, 0x93, 0x05, 0x94, 0x33, 0xA1, 0x01, 0x00, 0x00]), heartbeat());
    }

    #[test]
    fn a_new_zone_connection_is_read_from_its_first_byte() {
        let mut h = Harness::new();

        // Town: heartbeats, then the player's id there.
        h.send(60311, 57425, heartbeat());
        h.send(60311, 57425, heartbeat());
        h.send(60311, 57425, own_player(9231, "Rin"));
        assert_eq!(h.state.data_storage.main_actor_id(), Some(9231));

        // Dungeon: a new connection whose player info comes before its first
        // heartbeat -- the packet the meter used to miss.
        h.send(60311, 63929, own_player(802, "Rin"));
        h.send(60311, 63929, heartbeat());
        h.send(60311, 63929, heartbeat());

        assert_eq!(h.state.zone_changes, 1);
        assert_eq!(h.state.data_storage.main_actor_id(), Some(802));
        assert_eq!(h.state.data_storage.main_actor_name().as_deref(), Some("Rin"));
    }

    #[test]
    fn a_zone_change_forgets_the_old_id_until_the_new_one_arrives() {
        let mut h = Harness::new();
        h.send(60311, 57425, heartbeat());
        h.send(60311, 57425, heartbeat());
        h.send(60311, 57425, own_player(9231, "Rin"));

        h.send(60311, 63929, heartbeat());
        h.send(60311, 63929, heartbeat());
        // Until the new zone says who you are, every hit counts as yours
        // rather than none of them.
        assert_eq!(h.state.data_storage.main_actor_id(), None);
        assert_eq!(h.state.data_storage.main_actor_name().as_deref(), Some("Rin"));
    }

    #[test]
    fn a_large_frame_split_across_segments_is_waited_for() {
        let mut h = Harness::new();
        h.send(1111, 2222, heartbeat());
        h.send(1111, 2222, heartbeat());

        let packet = own_player(77, "Rin");
        let (head, tail) = packet.split_at(50);
        h.send(1111, 2222, head.to_vec());
        assert_eq!(h.state.data_storage.main_actor_id(), None);
        h.send(1111, 2222, tail.to_vec());
        assert_eq!(h.state.data_storage.main_actor_id(), Some(77));
    }

    #[test]
    fn traffic_without_a_heartbeat_is_never_parsed() {
        let mut h = Harness::new();
        for _ in 0..10 {
            h.send(443, 5000, own_player(5, "Nobody"));
        }
        assert_eq!(h.state.data_storage.main_actor_id(), None);
        assert!(h.state.active.is_none());
    }

    #[test]
    fn a_lost_position_recovers_at_the_next_heartbeat() {
        let mut h = Harness::new();
        h.send(1111, 2222, heartbeat());
        h.send(1111, 2222, heartbeat());
        // Garbage that declares an impossible length, then real traffic.
        h.send(1111, 2222, vec![0xFF, 0xFF, 0xFF, 0xFF, 0x7F, 0x13, 0x37]);
        let mut rest = heartbeat();
        rest.extend(own_player(4242, "Mira"));
        h.send(1111, 2222, rest);
        assert_eq!(h.state.data_storage.main_actor_id(), Some(4242));
    }

    /// Replays real recordings through the pipeline and reports what it read.
    ///
    /// ```text
    /// $env:AETHER_RECORDINGS = "$env:APPDATA/com.helveticxa.aether/recordings"
    /// cargo test --lib replay_recordings -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn replay_recordings() {
        let Ok(dir) = std::env::var("AETHER_RECORDINGS") else {
            eprintln!("AETHER_RECORDINGS not set");
            return;
        };
        let mut files: Vec<_> = std::fs::read_dir(&dir)
            .expect("recordings dir")
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.extension().is_some_and(|ext| ext == "aetherpc"))
            .collect();
        files.sort();

        for path in files {
            let mut h = Harness::new();
            let ids = Arc::new(Mutex::new(Vec::new()));
            let seen = Arc::clone(&ids);
            h.state
                .data_storage
                .main_actor_listener
                .lock()
                .unwrap()
                .replace(Box::new(move |payload| {
                    seen.lock().unwrap().push((payload.actor_id, payload.actor_name.clone()));
                }));
            let zones = Arc::new(Mutex::new(Vec::new()));
            let storage = Arc::clone(&h.state.data_storage);
            let reports = Arc::clone(&zones);
            h.state
                .data_storage
                .zone_change_callback
                .lock()
                .unwrap()
                .replace(Box::new(move || {
                    reports.lock().unwrap().push(accuracy(&storage));
                    storage.clear();
                }));

            let started = Instant::now();
            let packets = crate::dps_meter::capture::recorder::replay_recording(&path, |packet| {
                dispatch(&mut h.state, packet, &h.logger, &h.combat_port);
                true
            })
            .expect("replay");
            let elapsed = started.elapsed();
            zones.lock().unwrap().push(accuracy(&h.state.data_storage));

            // What one overlay update costs at the end of the recording: the
            // snapshot is rebuilt and sent while a fight is on.
            let calculator =
                crate::dps_meter::engine::calculator::DpsCalculator::new(Arc::clone(&h.state.data_storage));
            let built = Instant::now();
            let mut size = 0usize;
            for _ in 0..20 {
                if let Some(snapshot) = calculator.get_dps_snapshot(0, false, 10) {
                    size = serde_json::to_vec(&snapshot).map(|json| json.len()).unwrap_or(0);
                }
            }
            println!(
                "snapshot: {:.2} ms to build and serialise, {} KB",
                built.elapsed().as_secs_f64() * 1000.0 / 20.0,
                size / 1024
            );
            // The overlay can be checked against what a real session produces.
            if let (Ok(out), Some(snapshot)) = (
                std::env::var("AETHER_SNAPSHOT_DIR"),
                calculator.get_dps_snapshot(0, false, 10),
            ) {
                let name = path.file_stem().unwrap().to_string_lossy().to_string();
                let file = std::path::Path::new(&out).join(format!("{name}.snapshot.json"));
                std::fs::write(&file, serde_json::to_vec(&snapshot).unwrap()).unwrap();
            }

            println!(
                "\n=== {} : {packets} packets in {:.1} ms ({:.0} packets/s)",
                path.file_name().unwrap().to_string_lossy(),
                elapsed.as_secs_f64() * 1000.0,
                packets as f64 / elapsed.as_secs_f64().max(1e-9)
            );
            println!("zone changes {}, identities {:?}", h.state.zone_changes, ids.lock().unwrap());
            for (key, flow) in &h.state.flows {
                if let Some(processor) = flow.processor.as_ref() {
                    println!("  game flow {} {:?}", connection_key(key), processor.stats());
                }
            }
            for (zone, rows) in zones.lock().unwrap().iter().enumerate() {
                for row in rows {
                    println!("  zone {zone}: {row}");
                }
            }
        }
    }

    /// Damage dealt to each target that lost real health, against the health
    /// it lost.
    fn accuracy(storage: &DataStorage) -> Vec<String> {
        let stats = storage.get_dps_stats_snapshot();
        let hp = storage.mob_id_hp_snapshot();
        let codes = storage.mob_id_code_snapshot();
        let mut rows: Vec<(u32, String)> = stats
            .iter()
            .filter_map(|(target, actors)| {
                let (current, max) = *hp.get(target)?;
                let lost = max.saturating_sub(current);
                if lost < 500_000 {
                    return None;
                }
                let dealt: u64 = actors
                    .values()
                    .flat_map(|skills| skills.values())
                    .map(|skill| skill.total_damage)
                    .sum();
                let code = codes.get(target).copied();
                let name = code.and_then(|code| storage.mob_name(code)).unwrap_or_default();
                Some((
                    lost,
                    format!(
                        "target {target} {name} lost {lost} dealt {dealt} = {:.1}%",
                        dealt as f64 * 100.0 / f64::from(lost)
                    ),
                ))
            })
            .collect();
        rows.sort_by(|a, b| b.0.cmp(&a.0));
        rows.into_iter().map(|(_, row)| row).collect()
    }
}
