use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, RwLock,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sysinfo::{get_current_pid, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Manager};

use crate::dps_meter::capture::capturer::{check_npcap_available, CapturedPacket, PcapCapturer};
use crate::dps_meter::capture::channel::Channel;
use crate::dps_meter::capture::dispatcher::{CaptureDispatcher, TcpReassemblyStatus};
use crate::dps_meter::capture::ping_tracker::PingTracker;
use crate::dps_meter::capture::recorder::{
    list_recordings, prune_recordings, replay_recording, PacketRecorder, RecordingFile,
    RecordingStatus,
};
use crate::dps_meter::capture::windivert_capturer::{check_windivert_status, WinDivertCapturer};
use crate::dps_meter::config::{CaptureBackendPriority, DpsMeterConfig, SharedDpsMeterConfig};
use crate::dps_meter::engine::calculator::DpsCalculator;
use crate::dps_meter::history::HistoryStore;
use crate::dps_meter::models::combat::{CombatSnapshot, PvpCombatStatsRow, PvpWatchInfoResponse};
use crate::dps_meter::models::diagnostics::{DpsMeterState, MemorySnapshot};
use crate::dps_meter::storage::data_storage::DataStorage;
use crate::plugins::logger::AppLogger;

const STALE_ASSEMBLER_IDLE_SECS: u64 = 30;
/// Replay reads from disk far faster than the dispatcher drains, so it waits
/// whenever the queue runs this deep. `try_send` drops the packet it is handed
/// when the channel is full, and a silently lossy replay is worse than a slow one.
const REPLAY_BACKPRESSURE_LIMIT: usize = 50_000;

/// Seconds since the epoch, for filenames that sort chronologically.
fn chrono_stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
const PACKET_CHANNEL_CAPACITY: isize = 2_000_000;

/// Automatic recordings: how long each runs, and how many are kept.
const AUTO_RECORDING_PREFIX: &str = "auto";
const AUTO_RECORDING_DURATION: Duration = Duration::from_secs(120);
const AUTO_RECORDINGS_KEPT: usize = 5;

/// How long the overlay stays up after Reset before hiding again, so the
/// click visibly did something.
const RESET_PEEK_SECS: u64 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum CaptureBackend {
    WinDivert,
    Npcap,
}

/// One automatic recording per meter session, started when game traffic
/// arrives from a server no fingerprint matches.
#[derive(Debug, Default)]
struct AutoRecordState {
    active_since: Option<Instant>,
    done: bool,
}

fn now_seconds() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

pub struct DpsMeter {
    app: AppHandle,
    config: SharedDpsMeterConfig,
    logger: Arc<AppLogger>,
    data_storage: Arc<DataStorage>,
    calculator: Arc<DpsCalculator>,
    ping_tracker: Arc<PingTracker>,
    packet_channel: Channel<CapturedPacket>,
    recorder: Arc<PacketRecorder>,
    recordings_dir: PathBuf,
    replaying: Arc<AtomicBool>,
    windivert_capturer: WinDivertCapturer,
    pcap_capturer: PcapCapturer,
    active_capture_backend: Arc<Mutex<Option<CaptureBackend>>>,
    dispatcher: CaptureDispatcher,
    running: Arc<AtomicBool>,
    snapshot_running: Arc<AtomicBool>,
    memory_snapshot_running: Arc<AtomicBool>,
    snapshot_thread: Mutex<Option<JoinHandle<()>>>,
    memory_snapshot_thread: Mutex<Option<JoinHandle<()>>>,
    last_emitted_total_damage: Arc<Mutex<Option<u64>>>,
    last_snapshot: Arc<Mutex<Option<CombatSnapshot>>>,
    history: Arc<HistoryStore>,
    /// Until when the overlay stays up regardless of the idle rule: after
    /// Start, after Reset, and from the show hotkey.
    peek_until: Arc<Mutex<Option<Instant>>>,
    auto_record: Arc<Mutex<AutoRecordState>>,
}

impl DpsMeter {
    pub fn new(app: AppHandle, logger: Arc<AppLogger>) -> Self {
        let config = Arc::new(RwLock::new(DpsMeterConfig::default()));
        let data_storage = Arc::new(DataStorage::new(app.clone(), Arc::clone(&config)));
        let calculator = Arc::new(DpsCalculator::new(Arc::clone(&data_storage)));
        let ping_tracker = Arc::new(PingTracker::new());
        let packet_channel = Channel::new(PACKET_CHANNEL_CAPACITY);
        let recorder = Arc::new(PacketRecorder::new());
        let recordings_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("aether"))
            .join("recordings");
        let windivert_capturer =
            WinDivertCapturer::new(packet_channel.clone(), Arc::clone(&logger));
        let pcap_capturer = PcapCapturer::new(packet_channel.clone(), Arc::clone(&logger));
        let dispatcher = CaptureDispatcher::new(
            packet_channel.clone(),
            Arc::clone(&recorder),
            Arc::clone(&data_storage),
            Arc::clone(&logger),
            Arc::clone(&ping_tracker),
            Arc::clone(&config),
        );
        let history = Arc::new(HistoryStore::new());
        if let Ok(dir) = app.path().app_data_dir() {
            history.init_dir(dir);
            history.load_from_disk();
        }

        // Register main-actor callback: reset meter silently when player is identified.
        // Safe to register here — callback only fires after start_dps_meter(),
        // which can only happen after app.manage(meter) in lib.rs.
        let app_for_cb = app.clone();
        data_storage
            .main_actor_callback
            .lock()
            .unwrap()
            .replace(Box::new(move |actor_id, actor_name, sid| {
                let sid_str = sid.unwrap_or_default();
                eprintln!(
                    "[dps_meter] main actor detected: id={} name={} server={}",
                    actor_id, actor_name, sid_str
                );
                if let Some(meter) = app_for_cb.try_state::<DpsMeter>() {
                    meter.reset_dps_meter(false);
                }
            }));

        Self {
            app,
            config,
            logger,
            data_storage,
            calculator,
            ping_tracker,
            packet_channel,
            recorder,
            recordings_dir,
            replaying: Arc::new(AtomicBool::new(false)),
            windivert_capturer,
            pcap_capturer,
            active_capture_backend: Arc::new(Mutex::new(None)),
            dispatcher,
            running: Arc::new(AtomicBool::new(false)),
            snapshot_running: Arc::new(AtomicBool::new(false)),
            memory_snapshot_running: Arc::new(AtomicBool::new(false)),
            snapshot_thread: Mutex::new(None),
            memory_snapshot_thread: Mutex::new(None),
            last_emitted_total_damage: Arc::new(Mutex::new(None)),
            last_snapshot: Arc::new(Mutex::new(None)),
            history,
            peek_until: Arc::new(Mutex::new(None)),
            auto_record: Arc::new(Mutex::new(AutoRecordState::default())),
        }
    }

    /// Keep the overlay up for `secs` even with no fight to show.
    pub fn peek_overlay(&self, secs: u64) {
        *self.peek_until.lock().unwrap() = Some(Instant::now() + Duration::from_secs(secs));
        crate::plugins::aion2_focus::set_dps_idle_hidden_for_app(&self.app, false);
    }

    /// The capture backend in use, while the meter runs.
    pub fn capture_backend(&self) -> Option<CaptureBackend> {
        *self.active_capture_backend.lock().unwrap()
    }

    pub fn has_game_traffic(&self) -> bool {
        self.dispatcher.has_recent_ports()
    }

    pub fn main_actor_name(&self) -> Option<String> {
        self.data_storage.main_actor_name()
    }

    /// Whether an automatic recording is running right now.
    pub fn is_auto_recording(&self) -> bool {
        self.auto_record.lock().unwrap().active_since.is_some()
    }

    pub fn apply_config(&self, config: DpsMeterConfig) -> DpsMeterConfig {
        let config = config.normalized();
        *self.config.write().unwrap() = config.clone();
        crate::dps_meter::region::set_configured(config.region);
        self.logger.info(format!(
            "region profile applied: {}",
            config.region.label()
        ));
        self.logger.set_debug_enabled(config.output_debug_log);
        self.logger.info(format!(
            "config applied: dps_interval={}ms memory_interval={}ms max_packet_size_threshold={} stall_resync_delay={}ms full_processor_stall_resync_delay={}ms unknown_packet_stall_resync_delay={}ms capture_backend_priority={:?} boss_only={} pvp_mode_on={} pvp_overlay_position={:?} show_possible_boss={} my_muzhuang_only={} output_debug_log={}",
            config.dps_snapshot_interval_ms,
            config.memory_snapshot_interval_ms,
            config.max_packet_size_threshold,
            config.stall_resync_delay_ms,
            config.full_processor_stall_resync_delay_ms,
            config.unknown_packet_stall_resync_delay_ms,
            config.capture_backend_priority,
            config.boss_only,
            config.pvp_mode_on,
            config.pvp_overlay_position,
            config.show_possible_boss,
            config.my_muzhuang_only,
            config.output_debug_log
        ));
        config
    }

    pub fn current_config(&self) -> DpsMeterConfig {
        self.config.read().unwrap().clone()
    }

    pub fn start_dps_meter(&self) -> Result<(), String> {
        if self.running.swap(true, Ordering::SeqCst) {
            self.emit_running_status();
            return Ok(());
        }

        self.clear_runtime_state();
        *self.auto_record.lock().unwrap() = AutoRecordState::default();
        self.dispatcher.start();
        let capture_backend_priority = self.config.read().unwrap().capture_backend_priority.clone();
        let backend = match self.start_capture_backend(capture_backend_priority) {
            Ok(backend) => backend,
            Err(error) => {
                self.dispatcher.stop();
                self.running.store(false, Ordering::SeqCst);
                return Err(error);
            }
        };
        *self.active_capture_backend.lock().unwrap() = Some(backend);
        self.logger
            .info(format!("capture backend selected: {backend:?}"));
        self.start_snapshot_loop();
        self.start_memory_snapshot_loop();
        self.emit_running_status();
        self.logger.info("dps meter started");
        Ok(())
    }

    fn start_capture_backend(
        &self,
        priority: CaptureBackendPriority,
    ) -> Result<CaptureBackend, String> {
        match priority {
            CaptureBackendPriority::WinDivertFirst => match self.windivert_capturer.start() {
                Ok(()) => Ok(CaptureBackend::WinDivert),
                Err(windivert_error) => {
                    self.logger.info(format!(
                        "WinDivert initialization failed, falling back to Npcap: {windivert_error}"
                    ));
                    self.pcap_capturer
                        .start()
                        .map(|_| CaptureBackend::Npcap)
                        .map_err(|npcap_error| {
                            format!(
                                "No capture backend available; WinDivert: {windivert_error}; Npcap: {npcap_error}"
                            )
                        })
                }
            },
            CaptureBackendPriority::NpcapFirst => match self.pcap_capturer.start() {
                Ok(()) => Ok(CaptureBackend::Npcap),
                Err(npcap_error) => {
                    self.logger.info(format!(
                        "Npcap initialization failed, falling back to WinDivert: {npcap_error}"
                    ));
                    self.windivert_capturer
                        .start()
                        .map(|_| CaptureBackend::WinDivert)
                        .map_err(|windivert_error| {
                            format!(
                                "No capture backend available; Npcap: {npcap_error}; WinDivert: {windivert_error}"
                            )
                        })
                }
            },
        }
    }

    pub fn stop_dps_meter(&self) {
        if !self.running.swap(false, Ordering::SeqCst) {
            self.emit_running_status();
            return;
        }

        self.stop_snapshot_loop();
        self.stop_memory_snapshot_loop();
        self.stop_active_capturer();
        self.dispatcher.stop();
        if self.auto_record.lock().unwrap().active_since.take().is_some() {
            let _ = self.recorder.stop();
        }
        self.clear_runtime_state();
        crate::plugins::aion2_focus::set_dps_idle_hidden_for_app(&self.app, false);
        self.emit_running_status();
        self.logger.info("dps meter stopped");
    }

    /// Reset asked for by the player, from the overlay or the hotkey. The
    /// overlay stays up a moment so the click visibly did something.
    pub fn reset_from_user(&self) {
        self.reset_dps_meter(true);
        self.peek_overlay(RESET_PEEK_SECS);
    }

    /// Nothing of yours has happened for the idle timeout: the fight is over.
    /// It goes to history if you were in it; a meter holding only other
    /// people's fights nearby is cleared without a record.
    fn end_idle_fight(&self, was_in_fight: bool) {
        if was_in_fight {
            self.logger.info("idle timeout: fight saved and meter reset");
            self.reset_dps_meter(true);
        } else {
            self.clear_runtime_state_nopacket();
            self.emit_empty_snap();
        }
    }

    pub fn reset_dps_meter(&self, emit_empty: bool) {
        // Capture before clearing
        if let Some(snapshot) = self.get_dps_snapshot(0) {
            let target_count = snapshot.by_target_player_stats.len();
            eprintln!(
                "[dps_meter] reset: total_damage={} targets={} records_will_save={}",
                snapshot.total_damage,
                target_count,
                snapshot.total_damage > 0
            );
            if snapshot.total_damage > 0 {
                self.history.save_and_clear(snapshot);
                let _ = self.app.emit("history-updated", ());
            }
        } else {
            eprintln!("[dps_meter] reset: no snapshot available");
        }
        self.clear_runtime_state_nopacket();
        self.logger.info(format!(
            "dps meter runtime state reset (running={})",
            self.is_running()
        ));
        if emit_empty {
            self.emit_empty_snap();
        }
    }

    /// Register a callback that fires when the main actor is identified.
    /// Resets meter silently (no empty snapshot emit) and logs character identity.

    pub fn get_last_snapshot(&self) -> Option<CombatSnapshot> {
        self.last_snapshot.lock().unwrap().clone()
    }

    pub fn get_history(&self) -> Vec<crate::dps_meter::history::HistoryRecord> {
        self.history.get_records()
    }

    pub fn delete_all_history(&self) -> usize {
        self.history.clear_all()
    }

    pub fn delete_history_record(&self, id: &str) -> bool {
        self.history.delete_record(id)
    }

    pub fn delete_history_records(&self, ids: &[String]) -> usize {
        self.history.delete_records(ids)
    }

    fn emit_empty_snap(&self) {
        use crate::dps_meter::models::combat::CombatInfos;

        let empty = CombatSnapshot {
            total_damage: 0,
            by_target_player_skill_stats: HashMap::new(),
            by_target_player_stats: HashMap::new(),
            use_buffs_by_target: HashMap::new(),
            combat_infos: CombatInfos {
                actor_infos: HashMap::new(),
                target_infos: HashMap::new(),
                main_actor_id: None,
                main_actor_name: None,
                last_target_by_main_actor: None,
                last_target: None,
                time_now: 0.0,
            },
            last_target_info: None,
            last_target_all_players_overview_stats: Vec::new(),
            main_actor_received_player_overview_stats: Vec::new(),
            main_actor_dealt_player_overview_stats: Vec::new(),
        };
        let _ = self.app.emit("dps-snapshot", empty);
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn check_state(&self) -> DpsMeterState {
        let capture_backend_active = self.active_capture_backend.lock().unwrap().is_some();
        let mut capture_available = capture_backend_active;
        let mut capture_error = None;
        if !capture_backend_active {
            let windivert_status = check_windivert_status();
            capture_available = windivert_status.available;
            capture_error = windivert_status.error;
            if !capture_available {
                match check_npcap_available() {
                    Ok(()) => {
                        capture_available = true;
                        capture_error = None;
                    }
                    Err(npcap_error) => {
                        capture_error = Some(format!(
                            "{}; Npcap: {npcap_error}",
                            capture_error.unwrap_or_else(|| "WinDivert unavailable".to_string())
                        ));
                    }
                }
            }
        }
        let meter_running = self.is_running();
        let has_game_data = self.dispatcher.has_recent_ports();
        let player_identified = self.data_storage.main_actor_name().is_some();

        DpsMeterState {
            npcap_available: capture_available,
            npcap_error: capture_error,
            boss_only_filtered: self.data_storage.boss_only_filtered(),
            meter_running,
            has_game_data,
            player_identified,
        }
    }

    pub fn tcp_reassembly_status(&self) -> TcpReassemblyStatus {
        self.dispatcher.tcp_reassembly_status()
    }

    pub fn get_dps_snapshot(&self, target_damage_threshold: u64) -> Option<CombatSnapshot> {
        let cfg = self.config.read().unwrap();
        self.calculator.get_dps_snapshot(
            target_damage_threshold,
            cfg.hide_unknown_players,
            cfg.max_player_count,
        )
    }

    pub fn get_pvp_watch_info(&self, names: &[String]) -> PvpWatchInfoResponse {
        self.data_storage.get_pvp_watch_info(names)
    }

    pub fn get_pvp_combat_stats(&self) -> Vec<PvpCombatStatsRow> {
        self.data_storage.get_pvp_combat_stats()
    }

    pub fn clear_pvp_combat_stats(&self) {
        self.data_storage.clear_pvp_combat_stats();
    }

    fn start_snapshot_loop(&self) {
        if self.snapshot_running.swap(true, Ordering::SeqCst) {
            return;
        }

        let app = self.app.clone();
        let calculator = Arc::clone(&self.calculator);
        let config = Arc::clone(&self.config);

        let snapshot_running = Arc::clone(&self.snapshot_running);
        let last_emitted_total_damage = Arc::clone(&self.last_emitted_total_damage);
        let last_snapshot = Arc::clone(&self.last_snapshot);
        let data_storage = Arc::clone(&self.data_storage);
        let peek_until = Arc::clone(&self.peek_until);

        let handle = thread::spawn(move || {
            let mut idle_hidden: Option<bool> = None;

            while snapshot_running.load(Ordering::SeqCst) {
                let cfg = config.read().unwrap();
                let hide_unknown = cfg.hide_unknown_players;
                let max_count = cfg.max_player_count;
                let hide_when_idle = cfg.hide_when_idle;
                let idle_reset_secs = cfg.idle_reset_secs;
                drop(cfg);

                // A fight nobody has touched for the idle timeout is over.
                // Measured from your own last hit, so other people fighting
                // nearby cannot keep an old fight on screen forever.
                if idle_reset_secs > 0 {
                    if let Some(started) = data_storage.start_time() {
                        let activity = data_storage.activity_at();
                        let idle_for = now_seconds() - activity.unwrap_or(started);
                        if idle_for >= idle_reset_secs as f64 {
                            if let Some(meter) = app.try_state::<DpsMeter>() {
                                meter.end_idle_fight(activity.is_some());
                            }
                        }
                    }
                }

                // Between fights the overlay steps aside, and it is back for
                // the first hit of the next one.
                let peeking = peek_until
                    .lock()
                    .unwrap()
                    .is_some_and(|until| Instant::now() < until);
                let hidden = hide_when_idle && !peeking && data_storage.activity_at().is_none();
                if idle_hidden != Some(hidden) {
                    idle_hidden = Some(hidden);
                    crate::plugins::aion2_focus::set_dps_idle_hidden_for_app(&app, hidden);
                }

                if let Some(snapshot) = calculator.get_dps_snapshot(0, hide_unknown, max_count) {
                    // Cache non-empty snapshots for detail window fallback
                    if snapshot.total_damage > 0 {
                        *last_snapshot.lock().unwrap() = Some(snapshot.clone());
                    }
                    let should_emit = {
                        let mut last_damage = last_emitted_total_damage.lock().unwrap();
                        let changed = last_damage
                            .map(|previous| previous != snapshot.total_damage)
                            .unwrap_or(snapshot.total_damage > 0);
                        if changed {
                            *last_damage = Some(snapshot.total_damage);
                        }
                        changed
                    };

                    if should_emit {
                        let _ = app.emit("dps-snapshot", snapshot);
                    }
                }

                let interval_ms = config.read().unwrap().dps_snapshot_interval_ms;
                // logger.debug(format!("snapshot loop sleep {}ms", interval_ms));
                thread::sleep(Duration::from_millis(interval_ms));
            }
        });

        *self.snapshot_thread.lock().unwrap() = Some(handle);
    }

    fn stop_snapshot_loop(&self) {
        self.snapshot_running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.snapshot_thread.lock().unwrap().take() {
            let _ = handle.join();
        }
    }

    fn start_memory_snapshot_loop(&self) {
        if self.memory_snapshot_running.swap(true, Ordering::SeqCst) {
            return;
        }

        let app = self.app.clone();
        let config = Arc::clone(&self.config);
        let logger = Arc::clone(&self.logger);
        let data_storage = Arc::clone(&self.data_storage);
        let ping_tracker = Arc::clone(&self.ping_tracker);
        let packet_channel = self.packet_channel.clone();
        let windivert_capturer = self.windivert_capturer.clone();
        let pcap_capturer = self.pcap_capturer.clone();
        let active_capture_backend = Arc::clone(&self.active_capture_backend);
        let dispatcher = self.dispatcher.clone();
        let memory_snapshot_running = Arc::clone(&self.memory_snapshot_running);
        let recorder = Arc::clone(&self.recorder);
        let recordings_dir = self.recordings_dir.clone();
        let auto_record = Arc::clone(&self.auto_record);

        let handle = thread::spawn(move || {
            let pid = match get_current_pid() {
                Ok(pid) => pid,
                Err(error) => {
                    logger.error(format!("failed to resolve current pid: {error}"));
                    return;
                }
            };
            let mut system = System::new_all();

            while memory_snapshot_running.load(Ordering::SeqCst) {
                let removed_ports = dispatcher
                    .cleanup_stale_assemblers(Duration::from_secs(STALE_ASSEMBLER_IDLE_SECS));
                if !removed_ports.is_empty() {
                    logger.info(format!(
                        "cleaned stale assembler ports: {}",
                        removed_ports.join(", ")
                    ));
                }

                let auto_record_enabled = config.read().unwrap().auto_record_unknown_server;
                auto_record_tick(
                    &auto_record,
                    &recorder,
                    &recordings_dir,
                    &dispatcher,
                    &logger,
                    auto_record_enabled,
                );

                let (cap_device, cap_port) = match *active_capture_backend.lock().unwrap() {
                    Some(CaptureBackend::WinDivert) => (
                        windivert_capturer.target_device(),
                        windivert_capturer.target_port(),
                    ),
                    Some(CaptureBackend::Npcap) => {
                        (pcap_capturer.target_device(), pcap_capturer.target_port())
                    }
                    None => (None, None),
                };

                if let Some(snapshot) = build_memory_snapshot(
                    &mut system,
                    pid,
                    &data_storage,
                    &ping_tracker,
                    &packet_channel,
                    &dispatcher,
                    cap_device,
                    cap_port,
                ) {
                    let _ = app.emit("dps-memory", snapshot);
                }

                let interval_ms = config.read().unwrap().memory_snapshot_interval_ms;
                // logger.debug(format!("memory snapshot loop sleep {}ms", interval_ms));
                thread::sleep(Duration::from_millis(interval_ms));
            }
        });

        *self.memory_snapshot_thread.lock().unwrap() = Some(handle);
    }

    fn stop_memory_snapshot_loop(&self) {
        self.memory_snapshot_running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.memory_snapshot_thread.lock().unwrap().take() {
            let _ = handle.join();
        }
    }

    fn clear_runtime_state(&self) {
        self.data_storage.clear();
        self.calculator.reset_snapshot_state();
        self.packet_channel.clear();
        self.dispatcher.clear();
        self.ping_tracker.reset();
        *self.last_emitted_total_damage.lock().unwrap() = None;
        *self.last_snapshot.lock().unwrap() = None;
    }

    // ── Packet recording and replay ──
    //
    // Recording captures a session so a parser can be iterated against it
    // offline. That matters most for a service that launches once: capture the
    // global servers on day one, then work against those bytes for as long as it
    // takes, without needing to be in game.

    pub fn start_packet_recording(&self) -> Result<String, String> {
        let path = self.recorder.start(&self.recordings_dir)?;
        self.logger
            .info(format!("packet recording started: {}", path.display()));
        Ok(path.to_string_lossy().into_owned())
    }

    pub fn stop_packet_recording(&self) -> Result<Option<RecordingStatus>, String> {
        let stopped = self.recorder.stop()?;
        if let Some(status) = &stopped {
            self.logger.info(format!(
                "packet recording stopped: {} packets, {} bytes",
                status.packets, status.bytes
            ));
        }
        Ok(stopped)
    }

    pub fn packet_recording_status(&self) -> RecordingStatus {
        self.recorder.status()
    }

    pub fn list_packet_recordings(&self) -> Vec<RecordingFile> {
        list_recordings(&self.recordings_dir)
    }

    /// Write a diagnostics report next to the recordings.
    ///
    /// The clipboard is the convenient path, but this runs regardless: on launch
    /// day the report is worth having on disk even if the copy silently fails.
    pub fn save_diagnostics_report(&self, report: &str) -> Result<String, String> {
        std::fs::create_dir_all(&self.recordings_dir)
            .map_err(|error| format!("Cannot create {:?}: {error}", self.recordings_dir))?;
        let path = self
            .recordings_dir
            .join(format!("diagnostics-{}.txt", chrono_stamp()));
        std::fs::write(&path, report)
            .map_err(|error| format!("Cannot write {path:?}: {error}"))?;
        Ok(path.to_string_lossy().into_owned())
    }

    pub fn is_replaying(&self) -> bool {
        self.replaying.load(Ordering::SeqCst)
    }

    pub fn cancel_packet_replay(&self) {
        self.replaying.store(false, Ordering::SeqCst);
    }

    /// Feed a recording back through the live pipeline.
    ///
    /// Packets go into the same channel the capturer writes to, so reassembly,
    /// dispatch, parsing and aggregation all run exactly as they would live.
    pub fn replay_packet_recording(&self, path: String) -> Result<(), String> {
        if !self.is_running() {
            return Err(
                "Start the meter first -- replay feeds the same pipeline live capture uses."
                    .to_string(),
            );
        }
        if self.replaying.swap(true, Ordering::SeqCst) {
            return Err("A replay is already running.".to_string());
        }

        let channel = self.packet_channel.clone();
        let replaying = Arc::clone(&self.replaying);
        let logger = Arc::clone(&self.logger);
        let app = self.app.clone();

        thread::spawn(move || {
            let source = PathBuf::from(&path);
            let outcome = replay_recording(&source, |packet| {
                while channel.size() > REPLAY_BACKPRESSURE_LIMIT {
                    if !replaying.load(Ordering::SeqCst) {
                        return false;
                    }
                    thread::sleep(Duration::from_millis(2));
                }
                if !channel.try_send(packet) {
                    return false;
                }
                replaying.load(Ordering::SeqCst)
            });

            match outcome {
                Ok(count) => {
                    logger.info(format!("replayed {count} packets from {path}"));
                    let _ = app.emit("packet-replay-finished", count);
                }
                Err(error) => {
                    logger.info(format!("replay failed for {path}: {error}"));
                    let _ = app.emit("packet-replay-failed", error);
                }
            }

            replaying.store(false, Ordering::SeqCst);
        });

        Ok(())
    }

    fn clear_runtime_state_nopacket(&self) {
        self.data_storage.clear();
        self.calculator.reset_snapshot_state();
        *self.last_emitted_total_damage.lock().unwrap() = None;
        // Keep last_snapshot as fallback for detail window when combat ends
    }

    fn emit_running_status(&self) {
        let _ = self.app.emit("dps-meter-status", self.is_running());
    }

    fn stop_active_capturer(&self) {
        match self.active_capture_backend.lock().unwrap().take() {
            Some(CaptureBackend::WinDivert) => self.windivert_capturer.stop(),
            Some(CaptureBackend::Npcap) => self.pcap_capturer.stop(),
            None => {}
        }
    }
}

impl Drop for DpsMeter {
    fn drop(&mut self) {
        self.stop_snapshot_loop();
        self.stop_memory_snapshot_loop();
        self.windivert_capturer.stop();
        self.pcap_capturer.stop();
        self.dispatcher.stop();
        self.clear_runtime_state();
    }
}

/// Start or finish the session's automatic recording.
///
/// A server no fingerprint matches is exactly the case where a recording is
/// worth having -- global on launch day, or any service we have not seen --
/// and it is also the case where nobody thinks to press Record in time. So the
/// first two minutes of game traffic are kept, once per session, and only the
/// newest few are kept on disk. A recording started by hand is never touched.
fn auto_record_tick(
    state: &Mutex<AutoRecordState>,
    recorder: &PacketRecorder,
    dir: &std::path::Path,
    dispatcher: &CaptureDispatcher,
    logger: &AppLogger,
    enabled: bool,
) {
    let mut state = state.lock().unwrap();

    if let Some(since) = state.active_since {
        if since.elapsed() >= AUTO_RECORDING_DURATION || !enabled {
            state.active_since = None;
            state.done = true;
            match recorder.stop() {
                Ok(Some(status)) => logger.info(format!(
                    "auto recording finished: {} packets, {} bytes",
                    status.packets, status.bytes
                )),
                Ok(None) => {}
                Err(error) => logger.info(format!("auto recording stop failed: {error}")),
            }
            prune_recordings(dir, AUTO_RECORDING_PREFIX, AUTO_RECORDINGS_KEPT);
        }
        return;
    }

    if state.done
        || !enabled
        || recorder.status().recording
        || !dispatcher.has_recent_ports()
        || crate::dps_meter::region::status().detected.is_some()
    {
        return;
    }

    match recorder.start_named(dir, AUTO_RECORDING_PREFIX) {
        Ok(path) => {
            state.active_since = Some(Instant::now());
            logger.info(format!(
                "auto recording started (server not recognised): {}",
                path.display()
            ));
        }
        Err(error) => {
            state.done = true;
            logger.info(format!("auto recording could not start: {error}"));
        }
    }
}

fn build_memory_snapshot(
    system: &mut System,
    pid: sysinfo::Pid,
    data_storage: &Arc<DataStorage>,
    ping_tracker: &Arc<PingTracker>,
    packet_channel: &Channel<CapturedPacket>,
    dispatcher: &CaptureDispatcher,
    cap_device: Option<String>,
    cap_port: Option<String>,
) -> Option<MemorySnapshot> {
    system.refresh_memory();
    system.refresh_cpu_usage();
    let _ = system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    let process = system.process(pid)?;

    let total_memory = system.total_memory().max(1) as f64;
    let rss_bytes = process.memory() as f64;
    let vms_bytes = process.virtual_memory() as f64;
    let logical_cpu_count = system.cpus().len().max(1) as f32;
    let normalized_cpu_percent = (process.cpu_usage() / logical_cpu_count).clamp(0.0, 100.0);
    let mut packet_sizes: HashMap<String, usize> = dispatcher.assembler_buffer_sizes();
    let channel_size = packet_channel.size();
    if channel_size > 0 {
        packet_sizes.insert("channel".to_string(), channel_size);
    }

    let cpus = system.cpus();
    let system_cpu_percent = if cpus.is_empty() {
        0.0
    } else {
        cpus.iter().map(|cpu| cpu.cpu_usage()).sum::<f32>() / cpus.len() as f32
    };

    Some(MemorySnapshot {
        cpu_percent: normalized_cpu_percent,
        rss_mb: rss_bytes / (1024.0 * 1024.0),
        vms_mb: vms_bytes / (1024.0 * 1024.0),
        memory_percent: ((rss_bytes / total_memory) * 100.0) as f32,
        system_cpu_percent: system_cpu_percent.clamp(0.0, 100.0),
        system_memory_used_mb: system.used_memory() as f64 / (1024.0 * 1024.0),
        system_memory_total_mb: total_memory / (1024.0 * 1024.0),
        cap_device,
        cap_port: dispatcher.current_combat_port().or(cap_port),
        packet_sizes,
        ping_ms: ping_tracker.current_ping_ms(),
        main_actor_name: data_storage.main_actor_name(),
    })
}
