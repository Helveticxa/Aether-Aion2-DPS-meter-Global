//! Raw packet recording and replay.
//!
//! The point of this module is turnaround. Reverse-engineering a protocol means
//! running the same bytes through a parser many times, and being in-game for
//! every attempt is the slow part -- especially on a service that launches once
//! and cannot be re-entered on demand.
//!
//! So: record a session's packets exactly as the capture layer saw them, then
//! replay them into the same channel the capturer feeds. Everything downstream --
//! reassembly, dispatch, parsing, aggregation -- runs identically to a live
//! session, because it is the same code path with the same input.
//!
//! The format is deliberately small and exact rather than clever. Each record is
//! one `CapturedPacket`:
//!
//! ```text
//! header:  magic "AETHERPC" | u16 version | u16 reserved
//! record:  f64 captured_at | [u8;4] src_ip | [u8;4] dst_ip
//!          u16 src_port    | u16 dst_port  | u32 sequence
//!          u32 payload_len | payload bytes
//! ```
//!
//! Little-endian throughout. A truncated trailing record is treated as the end
//! of the file rather than an error, because a recording is most likely to be
//! cut short by the app exiting mid-write.

use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::dps_meter::capture::capturer::CapturedPacket;

const MAGIC: &[u8; 8] = b"AETHERPC";
const FORMAT_VERSION: u16 = 1;
const FILE_HEADER_LEN: usize = 12;
const RECORD_HEADER_LEN: usize = 28;

/// Stop writing rather than fill the user's disk. A busy session is a few MB a
/// minute, so this is hours of capture.
const MAX_RECORDING_BYTES: u64 = 512 * 1024 * 1024;

/// Refuse absurd payload lengths when reading, so a corrupt file cannot make us
/// allocate wildly.
const MAX_PAYLOAD_LEN: u32 = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub recording: bool,
    pub path: Option<String>,
    pub packets: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFile {
    pub path: String,
    pub name: String,
    pub bytes: u64,
}

struct ActiveRecording {
    path: PathBuf,
    writer: BufWriter<File>,
    packets: u64,
    bytes: u64,
    /// Set once the cap is hit, so the warning is logged only the first time.
    capped: bool,
}

/// Records packets to disk while enabled. Cheap to call when it is not: one
/// uncontended mutex and an early return.
#[derive(Default)]
pub struct PacketRecorder {
    active: Mutex<Option<ActiveRecording>>,
}

impl PacketRecorder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Begin a recording in `dir`, named after the current time.
    pub fn start(&self, dir: &Path) -> Result<PathBuf, String> {
        let mut active = self.active.lock().map_err(|_| "recorder lock poisoned")?;
        if active.is_some() {
            return Err("A recording is already running.".to_string());
        }

        fs::create_dir_all(dir).map_err(|error| format!("Cannot create {dir:?}: {error}"))?;
        let path = dir.join(format!("session-{}.aetherpc", unix_millis()));

        let file = File::create(&path).map_err(|error| format!("Cannot create {path:?}: {error}"))?;
        let mut writer = BufWriter::new(file);

        writer.write_all(MAGIC).map_err(write_error)?;
        writer
            .write_all(&FORMAT_VERSION.to_le_bytes())
            .map_err(write_error)?;
        writer.write_all(&0u16.to_le_bytes()).map_err(write_error)?;

        *active = Some(ActiveRecording {
            path: path.clone(),
            writer,
            packets: 0,
            bytes: FILE_HEADER_LEN as u64,
            capped: false,
        });

        Ok(path)
    }

    /// Finish the current recording and return where it landed.
    pub fn stop(&self) -> Result<Option<RecordingStatus>, String> {
        let mut active = self.active.lock().map_err(|_| "recorder lock poisoned")?;
        let Some(mut recording) = active.take() else {
            return Ok(None);
        };

        recording.writer.flush().map_err(write_error)?;
        Ok(Some(RecordingStatus {
            recording: false,
            path: Some(recording.path.to_string_lossy().into_owned()),
            packets: recording.packets,
            bytes: recording.bytes,
        }))
    }

    /// Append one packet. Errors are swallowed on purpose: a failing recording
    /// must never take down live capture.
    pub fn record(&self, packet: &CapturedPacket) {
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        let Some(recording) = active.as_mut() else {
            return;
        };
        if recording.capped {
            return;
        }

        let record_len = (RECORD_HEADER_LEN + packet.data.len()) as u64;
        if recording.bytes + record_len > MAX_RECORDING_BYTES {
            recording.capped = true;
            let _ = recording.writer.flush();
            return;
        }

        if write_record(&mut recording.writer, packet).is_err() {
            recording.capped = true;
            return;
        }

        recording.packets += 1;
        recording.bytes += record_len;
    }

    pub fn status(&self) -> RecordingStatus {
        let Ok(active) = self.active.lock() else {
            return RecordingStatus {
                recording: false,
                path: None,
                packets: 0,
                bytes: 0,
            };
        };

        match active.as_ref() {
            Some(recording) => RecordingStatus {
                recording: !recording.capped,
                path: Some(recording.path.to_string_lossy().into_owned()),
                packets: recording.packets,
                bytes: recording.bytes,
            },
            None => RecordingStatus {
                recording: false,
                path: None,
                packets: 0,
                bytes: 0,
            },
        }
    }
}

fn write_error(error: std::io::Error) -> String {
    format!("Recording write failed: {error}")
}

fn write_record<W: Write>(writer: &mut W, packet: &CapturedPacket) -> std::io::Result<()> {
    writer.write_all(&packet.captured_at.to_le_bytes())?;
    writer.write_all(&packet.src_ip)?;
    writer.write_all(&packet.dst_ip)?;
    writer.write_all(&packet.src_port.to_le_bytes())?;
    writer.write_all(&packet.dst_port.to_le_bytes())?;
    writer.write_all(&packet.sequence.to_le_bytes())?;
    writer.write_all(&(packet.data.len() as u32).to_le_bytes())?;
    writer.write_all(&packet.data)?;
    Ok(())
}

/// Stream a recording back, one packet at a time.
///
/// Returns the number of packets delivered. `on_packet` returning `false` stops
/// the replay early, which is how a cancel button reaches this loop.
pub fn replay_recording<F>(path: &Path, mut on_packet: F) -> Result<u64, String>
where
    F: FnMut(CapturedPacket) -> bool,
{
    let file = File::open(path).map_err(|error| format!("Cannot open {path:?}: {error}"))?;
    let mut reader = BufReader::new(file);

    let mut header = [0u8; FILE_HEADER_LEN];
    reader
        .read_exact(&mut header)
        .map_err(|_| "Not a recording: file is too short.".to_string())?;
    if &header[0..8] != MAGIC {
        return Err("Not a recording: wrong magic bytes.".to_string());
    }
    let version = u16::from_le_bytes([header[8], header[9]]);
    if version != FORMAT_VERSION {
        return Err(format!(
            "Recording format v{version} is not supported (expected v{FORMAT_VERSION})."
        ));
    }

    let mut delivered = 0u64;
    let mut record_header = [0u8; RECORD_HEADER_LEN];

    loop {
        match reader.read_exact(&mut record_header) {
            Ok(()) => {}
            // A recording cut short mid-write is expected, not an error.
            Err(_) => break,
        }

        let captured_at = f64::from_le_bytes(record_header[0..8].try_into().unwrap());
        let src_ip: [u8; 4] = record_header[8..12].try_into().unwrap();
        let dst_ip: [u8; 4] = record_header[12..16].try_into().unwrap();
        let src_port = u16::from_le_bytes([record_header[16], record_header[17]]);
        let dst_port = u16::from_le_bytes([record_header[18], record_header[19]]);
        let sequence = u32::from_le_bytes(record_header[20..24].try_into().unwrap());
        let payload_len = u32::from_le_bytes(record_header[24..28].try_into().unwrap());

        if payload_len > MAX_PAYLOAD_LEN {
            return Err(format!(
                "Recording is corrupt: payload length {payload_len} exceeds the {MAX_PAYLOAD_LEN} byte limit."
            ));
        }

        let mut data = vec![0u8; payload_len as usize];
        if reader.read_exact(&mut data).is_err() {
            break;
        }

        delivered += 1;
        if !on_packet(CapturedPacket {
            src_ip,
            src_port,
            dst_ip,
            dst_port,
            sequence,
            data,
            captured_at,
        }) {
            break;
        }
    }

    Ok(delivered)
}

/// Recordings on disk, newest first.
pub fn list_recordings(dir: &Path) -> Vec<RecordingFile> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension()?.to_str()? != "aetherpc" {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            let modified = metadata.modified().ok()?;
            Some((path, metadata.len(), modified))
        })
        .collect();

    files.sort_by(|a, b| b.2.cmp(&a.2));

    files
        .into_iter()
        .map(|(path, bytes, _)| RecordingFile {
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: path.to_string_lossy().into_owned(),
            bytes,
        })
        .collect()
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(sequence: u32, data: &[u8]) -> CapturedPacket {
        CapturedPacket {
            src_ip: [10, 0, 0, 1],
            src_port: 13328,
            dst_ip: [192, 168, 1, 2],
            dst_port: 51000,
            sequence,
            data: data.to_vec(),
            captured_at: 1_700_000_000.5,
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aether-recorder-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn round_trips_packets_byte_for_byte() {
        let dir = temp_dir("roundtrip");
        let recorder = PacketRecorder::new();
        let path = recorder.start(&dir).expect("start");

        let written = vec![
            packet(1, &[0x0E, 0x00, 0x36]),
            packet(2, &[]),
            packet(3, &[0x04, 0x38, 0xFF, 0x01]),
        ];
        for p in &written {
            recorder.record(p);
        }
        recorder.stop().expect("stop");

        let mut read_back = Vec::new();
        let count = replay_recording(&path, |p| {
            read_back.push(p);
            true
        })
        .expect("replay");

        assert_eq!(count, 3);
        assert_eq!(read_back.len(), 3);
        for (original, restored) in written.iter().zip(read_back.iter()) {
            assert_eq!(original.sequence, restored.sequence);
            assert_eq!(original.data, restored.data);
            assert_eq!(original.src_ip, restored.src_ip);
            assert_eq!(original.dst_ip, restored.dst_ip);
            assert_eq!(original.src_port, restored.src_port);
            assert_eq!(original.dst_port, restored.dst_port);
            assert_eq!(original.captured_at, restored.captured_at);
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn replay_stops_when_the_callback_asks_it_to() {
        let dir = temp_dir("cancel");
        let recorder = PacketRecorder::new();
        let path = recorder.start(&dir).expect("start");
        for i in 0..10 {
            recorder.record(&packet(i, &[i as u8]));
        }
        recorder.stop().expect("stop");

        let mut seen = 0;
        let delivered = replay_recording(&path, |_| {
            seen += 1;
            seen < 4
        })
        .expect("replay");

        assert_eq!(seen, 4);
        assert_eq!(delivered, 4);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_truncated_recording_reads_up_to_the_cut() {
        let dir = temp_dir("truncated");
        let recorder = PacketRecorder::new();
        let path = recorder.start(&dir).expect("start");
        recorder.record(&packet(1, &[1, 2, 3]));
        recorder.record(&packet(2, &[4, 5, 6]));
        recorder.stop().expect("stop");

        // Simulate the app dying mid-write: lop off part of the last record.
        let full = fs::read(&path).expect("read");
        fs::write(&path, &full[..full.len() - 4]).expect("truncate");

        let mut seen = 0;
        let delivered = replay_recording(&path, |_| {
            seen += 1;
            true
        })
        .expect("replay");

        assert_eq!(seen, 1, "the intact record should still be readable");
        assert_eq!(delivered, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_file_that_is_not_a_recording() {
        let dir = temp_dir("badmagic");
        fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("nonsense.aetherpc");
        fs::write(&path, b"definitely not a recording").expect("write");

        let error = replay_recording(&path, |_| true).expect_err("should refuse");
        assert!(error.contains("magic"), "unexpected error: {error}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_to_start_twice() {
        let dir = temp_dir("double");
        let recorder = PacketRecorder::new();
        recorder.start(&dir).expect("first start");
        assert!(recorder.start(&dir).is_err(), "second start must fail");
        recorder.stop().expect("stop");

        let _ = fs::remove_dir_all(&dir);
    }
}
