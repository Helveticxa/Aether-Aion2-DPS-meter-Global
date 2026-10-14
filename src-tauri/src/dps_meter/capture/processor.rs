//! One game connection's byte stream, cut into packets and handed to the
//! parsers.
//!
//! A frame is `[length varint][optional F0..FE flag][opcode: 2 bytes][body]`,
//! and the varint counts four bytes more than the frame minus itself:
//!
//! ```text
//! frame length = varint value + varint length - 4
//! ```
//!
//! Upstream used `value - 3`, which agrees only while the varint is one byte
//! long, that is for frames under 128 bytes. Every larger frame was cut a byte
//! short, and the parser started the next one on that frame's last byte. When
//! that byte happened to be zero it was skipped as padding and nothing showed;
//! when it was not, a run of real packets was read as one bogus one -- and
//! inside a compressed bundle, the rest of the bundle was dropped. Measured on
//! global recordings that was a fifth to a quarter of all damage packets, and
//! the player-info packet sent on entering a dungeon, which is how the meter
//! learns your new id there.
//!
//! Frames that do not chain up mean the stream position is lost (a capture
//! drop, or joining a connection mid-packet). Recovery jumps straight to the
//! next heartbeat -- `0E 00 36`, an 11-byte frame the server sends twenty times
//! a second -- rather than stepping one byte per arriving packet, which used to
//! freeze the meter for seconds at a time.

use lz4_flex::block::decompress;
use std::sync::Arc;

use crate::dps_meter::capture::census;
use crate::dps_meter::capture::parser::context::ParserContext;
use crate::dps_meter::capture::parser::nickname;
use crate::dps_meter::capture::ping_tracker::PingTracker;
use crate::dps_meter::config::SharedDpsMeterConfig;
use crate::dps_meter::storage::data_storage::DataStorage;
use crate::plugins::logger::AppLogger;

/// Opcodes a parser here understands, for the census.
const KNOWN_PACKET_HEADERS: &[(u8, u8)] = &[
    (0x00, 0x36), // heartbeat
    (0x03, 0x36), // server time, read for ping
    (0x33, 0x36),
    (0x45, 0x36),
    (0x56, 0x36),
    (0x4A, 0x36), // the player's own entity
    (0x41, 0x36),
    (0x04, 0x38),
    (0x05, 0x38),
    (0x2A, 0x38),
    (0x2B, 0x38),
    (0x04, 0x8D),
    (0x00, 0x8D),
    (0xFF, 0xFF),
];

/// The heartbeat frame's first three bytes: its length (an 11-byte frame) and
/// opcode `00 36`.
pub const HEARTBEAT: [u8; 3] = [0x0E, 0x00, 0x36];

/// Larger than any frame seen in real traffic by a wide margin, and small
/// enough that a garbage length cannot make the parser wait for megabytes.
const MAX_FRAME_LEN: usize = 256 * 1024;
const MAX_BUNDLE_SIZE: usize = 5_000_000;

/// A frame is written in one piece, so its bytes arrive together. Still
/// waiting for the rest this long after it started, with data arriving all
/// the while, means its length was never real.
const STALLED_FRAME_SECS: f64 = 2.0;

/// Unparsed bytes kept before giving up on the position and resyncing.
const MAX_BUFFERED: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FrameHead {
    /// The varint is complete: the frame is `len` bytes, `header` of them the
    /// length itself.
    Sized { len: usize, header: usize },
    /// Not enough bytes yet to read the length.
    NeedMore,
    /// No frame can start here.
    Invalid,
}

/// Read the frame length at the start of `buf`.
pub(crate) fn read_frame_head(buf: &[u8]) -> FrameHead {
    let mut value: u64 = 0;
    for index in 0..5 {
        let Some(&byte) = buf.get(index) else {
            return FrameHead::NeedMore;
        };
        value |= u64::from(byte & 0x7F) << (7 * index);
        if byte & 0x80 == 0 {
            let header = index + 1;
            let len = (value + header as u64).saturating_sub(4) as usize;
            // Room for at least the opcode, and nothing absurd.
            if len < header + 2 || len > MAX_FRAME_LEN {
                return FrameHead::Invalid;
            }
            return FrameHead::Sized { len, header };
        }
    }
    FrameHead::Invalid
}

/// Where a frame's payload (its opcode) starts: after the length, and after
/// the optional flag byte some frames carry there.
fn payload_offset(frame: &[u8], header: usize) -> Option<usize> {
    let first = *frame.get(header)?;
    let offset = header + usize::from((0xF0..0xFF).contains(&first));
    (offset + 2 <= frame.len()).then_some(offset)
}

/// The next heartbeat at or after `from`.
pub(crate) fn find_heartbeat(buf: &[u8], from: usize) -> Option<usize> {
    buf.get(from..)?
        .windows(HEARTBEAT.len())
        .position(|window| window == HEARTBEAT)
        .map(|index| from + index)
}

/// Whether frames read from the start of `buf` land exactly on `target`.
///
/// A connection seen from its first byte is framed from there. When it was
/// joined part way through, the first bytes are the tail of some packet and
/// will not chain up to the first heartbeat, so parsing starts at that
/// heartbeat instead.
pub(crate) fn frames_chain_to(buf: &[u8], target: usize) -> bool {
    let mut position = 0usize;
    while position < target {
        if buf[position] == 0x00 {
            position += 1;
            continue;
        }
        match read_frame_head(&buf[position..]) {
            FrameHead::Sized { len, .. } => position += len,
            FrameHead::NeedMore | FrameHead::Invalid => return false,
        }
    }
    position == target
}

/// Health of one stream, for diagnostics.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStats {
    pub frames: u64,
    pub resyncs: u64,
    pub dropped_bytes: u64,
    pub bad_bundles: u64,
}

pub struct StreamProcessor {
    pub(super) data_storage: Arc<DataStorage>,
    pub(super) logger: Arc<AppLogger>,
    pub(super) port: String,
    pub(super) config: SharedDpsMeterConfig,
    ping_tracker: Arc<PingTracker>,
    buffer: Vec<u8>,
    synced: bool,
    /// Capture time of the newest bytes, in seconds since the epoch. Hits are
    /// stamped with it rather than with the time they happen to be parsed, so
    /// a backlog read in one go -- or a replay -- keeps its real timing.
    pub(super) packet_time: f64,
    /// When the frame at the head of the buffer started waiting for the rest
    /// of its bytes.
    waiting_since: Option<f64>,
    stats: StreamStats,
}

impl StreamProcessor {
    pub fn new(
        data_storage: Arc<DataStorage>,
        logger: Arc<AppLogger>,
        port: String,
        config: SharedDpsMeterConfig,
        ping_tracker: Arc<PingTracker>,
    ) -> Self {
        Self {
            data_storage,
            logger,
            port,
            config,
            ping_tracker,
            buffer: Vec::new(),
            synced: false,
            packet_time: 0.0,
            waiting_since: None,
            stats: StreamStats::default(),
        }
    }

    /// Begin with what the connection carried before it was recognised as
    /// the game's. `from_start` says those bytes are the connection from its
    /// first byte, so the packets ahead of the first heartbeat -- the zone
    /// data sent on entering a map -- are read too when they frame cleanly.
    pub fn start(&mut self, pending: &[u8], from_start: bool, captured_at: f64) {
        let start = match find_heartbeat(pending, 0) {
            Some(heartbeat) if from_start && frames_chain_to(pending, heartbeat) => 0,
            Some(heartbeat) => heartbeat,
            None => 0,
        };
        self.stats.dropped_bytes += start as u64;
        self.synced = find_heartbeat(pending, 0).is_some();
        self.feed(&pending[start..], captured_at);
    }

    pub fn feed(&mut self, data: &[u8], captured_at: f64) {
        self.packet_time = if captured_at > 0.0 {
            captured_at
        } else {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_secs_f64())
                .unwrap_or_default()
        };
        self.buffer.extend_from_slice(data);
        if self.buffer.len() > MAX_BUFFERED {
            self.logger.info(format!(
                "[{}] stream buffer overflowed at {} bytes, resyncing",
                self.port,
                self.buffer.len()
            ));
            self.stats.dropped_bytes += self.buffer.len() as u64;
            self.buffer.clear();
            self.synced = false;
            self.waiting_since = None;
            return;
        }
        self.drain();
    }

    /// The position in the stream is no longer trustworthy -- bytes were lost
    /// under it. Parsing resumes at the next heartbeat.
    pub fn desync(&mut self) {
        self.synced = false;
        self.waiting_since = None;
    }

    pub fn buffered(&self) -> usize {
        self.buffer.len()
    }

    pub fn stats(&self) -> StreamStats {
        self.stats
    }

    fn drain(&mut self) {
        let buffer = std::mem::take(&mut self.buffer);
        let mut position = 0usize;

        loop {
            if !self.synced {
                match find_heartbeat(&buffer, position) {
                    Some(heartbeat) => {
                        self.stats.dropped_bytes += (heartbeat - position) as u64;
                        self.stats.resyncs += 1;
                        position = heartbeat;
                        self.synced = true;
                    }
                    None => {
                        // Keep the last two bytes: they may be the start of a
                        // heartbeat whose third byte has not arrived.
                        let keep_from = buffer.len().saturating_sub(HEARTBEAT.len() - 1).max(position);
                        self.stats.dropped_bytes += (keep_from - position) as u64;
                        position = keep_from;
                        break;
                    }
                }
            }

            while buffer.get(position) == Some(&0x00) {
                position += 1;
            }
            if position >= buffer.len() {
                break;
            }

            match read_frame_head(&buffer[position..]) {
                FrameHead::Sized { len, header } => {
                    if position + len > buffer.len() {
                        let since = *self.waiting_since.get_or_insert(self.packet_time);
                        if self.packet_time - since > STALLED_FRAME_SECS {
                            self.lose_position(&mut position);
                            continue;
                        }
                        break;
                    }
                    self.waiting_since = None;
                    self.handle_frame(&buffer[position..position + len], header);
                    position += len;
                }
                FrameHead::NeedMore => break,
                FrameHead::Invalid => self.lose_position(&mut position),
            }
        }

        let mut buffer = buffer;
        buffer.drain(..position.min(buffer.len()));
        self.buffer = buffer;
    }

    fn lose_position(&mut self, position: &mut usize) {
        self.synced = false;
        self.waiting_since = None;
        self.stats.dropped_bytes += 1;
        *position += 1;
    }

    fn handle_frame(&mut self, frame: &[u8], header: usize) {
        self.stats.frames += 1;
        let Some(offset) = payload_offset(frame, header) else {
            return;
        };
        let payload = &frame[offset..];
        if payload[0] == 0xFF && payload[1] == 0xFF {
            self.unwrap_bundle(payload, 0);
        } else {
            self.parse_packet(payload, false);
        }
    }

    /// A compressed bundle: `FF FF`, the decompressed size as u32 LE, then an
    /// LZ4 block holding ordinary frames -- or further bundles.
    fn unwrap_bundle(&mut self, payload: &[u8], depth: u8) {
        if payload.len() < 7 || depth > 4 {
            return;
        }
        let size = u32::from_le_bytes([payload[2], payload[3], payload[4], payload[5]]) as usize;
        if size == 0 || size > MAX_BUNDLE_SIZE {
            self.stats.bad_bundles += 1;
            return;
        }
        let Ok(inner) = decompress(&payload[6..], size) else {
            self.stats.bad_bundles += 1;
            return;
        };

        let mut position = 0usize;
        while position < inner.len() {
            if inner[position] == 0x00 {
                position += 1;
                continue;
            }
            let FrameHead::Sized { len, header } = read_frame_head(&inner[position..]) else {
                self.stats.bad_bundles += 1;
                return;
            };
            if position + len > inner.len() {
                self.stats.bad_bundles += 1;
                return;
            }
            let frame = &inner[position..position + len];
            if let Some(offset) = payload_offset(frame, header) {
                let inner_payload = &frame[offset..];
                if inner_payload[0] == 0xFF && inner_payload[1] == 0xFF {
                    self.unwrap_bundle(inner_payload, depth + 1);
                } else {
                    self.parse_packet(inner_payload, true);
                }
            }
            position += len;
        }
    }

    /// Dispatch one packet by opcode. `payload` starts at the opcode.
    fn parse_packet(&mut self, payload: &[u8], is_compressed_bundle: bool) -> bool {
        // Tallied before dispatch, so unrecognised opcodes are counted too --
        // those are the ones worth knowing about on an unfamiliar service.
        let opcode = (payload[0], payload[1]);
        census::observe(opcode, payload.len(), KNOWN_PACKET_HEADERS.contains(&opcode));

        match opcode {
            (0x03, 0x36) => {
                self.ping_tracker.on_server_time(payload, self.packet_time);
                true
            }
            (0x33, 0x36) => {
                nickname::parse_main(&self.parser_context(), payload, is_compressed_bundle)
            }
            (0x45, 0x36) => {
                nickname::parse_other(&self.parser_context(), payload, is_compressed_bundle)
            }
            (0x56, 0x36) => {
                nickname::parse_main_combat_power(&self.parser_context(), payload, is_compressed_bundle)
            }
            (0x4A, 0x36) => nickname::parse_own_entity(&self.parser_context(), payload),
            (0x41, 0x36) => self.parse_summon_packet(payload, is_compressed_bundle),
            (0x04, 0x38) => self.parse_damage_packet(payload, is_compressed_bundle),
            (0x05, 0x38) => self.parse_dot_packet(payload, is_compressed_bundle),
            (0x2A, 0x38) | (0x2B, 0x38) => self.parse_buff_packet(payload, is_compressed_bundle),
            (0x04, 0x8D) => self.parse_summon_packet_048d(payload, is_compressed_bundle),
            (0x00, 0x8D) => self.parse_remain_hp_packet(payload, is_compressed_bundle),
            _ => false,
        }
    }

    fn parser_context(&self) -> ParserContext<'_> {
        ParserContext::new(&self.data_storage, &self.logger, &self.port)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame of `body_len` bytes after a two-byte opcode, with its length
    /// written the way the game writes it.
    fn frame(opcode: [u8; 2], body_len: usize) -> Vec<u8> {
        let mut header_len = 1;
        loop {
            let total = header_len + 2 + body_len;
            let value = total + 4 - header_len;
            let mut varint = Vec::new();
            let mut rest = value;
            loop {
                let byte = (rest & 0x7F) as u8;
                rest >>= 7;
                if rest == 0 {
                    varint.push(byte);
                    break;
                }
                varint.push(byte | 0x80);
            }
            if varint.len() == header_len {
                let mut out = varint;
                out.extend_from_slice(&opcode);
                out.extend(std::iter::repeat(0xAB).take(body_len));
                return out;
            }
            header_len = varint.len();
        }
    }

    fn heartbeat() -> Vec<u8> {
        let mut out = HEARTBEAT.to_vec();
        out.extend_from_slice(&[0x93, 0x05, 0x94, 0x33, 0xA1, 0x01, 0x00, 0x00]);
        out
    }

    #[test]
    fn the_heartbeat_is_an_eleven_byte_frame() {
        assert_eq!(read_frame_head(&heartbeat()), FrameHead::Sized { len: 11, header: 1 });
    }

    #[test]
    fn two_byte_lengths_count_the_whole_frame() {
        // The off-by-one that cost a quarter of all damage: a 280-byte frame
        // whose length reads 9A 02 (282), taken from a global recording.
        assert_eq!(read_frame_head(&[0x9A, 0x02, 0x11, 0x36]), FrameHead::Sized { len: 280, header: 2 });
        for body in [0usize, 100, 124, 125, 126, 200, 5_000, 20_000, 200_000] {
            let bytes = frame([0x04, 0x38], body);
            match read_frame_head(&bytes) {
                FrameHead::Sized { len, .. } => assert_eq!(len, bytes.len(), "body {body}"),
                other => panic!("body {body}: {other:?}"),
            }
        }
    }

    #[test]
    fn a_length_cut_off_mid_varint_waits_for_more() {
        assert_eq!(read_frame_head(&[0x9A]), FrameHead::NeedMore);
        assert_eq!(read_frame_head(&[]), FrameHead::NeedMore);
    }

    #[test]
    fn frames_chain_to_the_first_heartbeat_from_a_connection_start() {
        let mut stream = frame([0x11, 0x36], 277);
        stream.extend(frame([0x15, 0x36], 79));
        let heartbeat_at = stream.len();
        stream.extend(heartbeat());

        assert_eq!(find_heartbeat(&stream, 0), Some(heartbeat_at));
        assert!(frames_chain_to(&stream, heartbeat_at));
        // Joined mid-packet: the tail of something does not chain.
        assert!(!frames_chain_to(&stream[5..], heartbeat_at - 5));
    }
}
