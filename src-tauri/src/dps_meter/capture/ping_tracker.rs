//! Ping, from the server-time packet (`03 36`).
//!
//! The packet echoes a timestamp the client sent, at payload offset 4. On the
//! Taiwan and Korea clients that was wall-clock time in .NET ticks-as-ms. The
//! global client sends its performance counter instead, in milliseconds plus
//! a fixed 2^24-second offset -- Unreal's convention. Read as wall-clock time
//! that is decades off and was thrown away, so ping never showed on global.
//!
//! The counter is this machine's own `QueryPerformanceCounter`, shared by the
//! game and by us, so ping is simply the counter when the packet arrived minus
//! the counter it carries.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const CLIENT_TIME_OFFSET: usize = 4;
const DOTNET_EPOCH_OFFSET_MS: i64 = 62_135_596_800_000;
/// 2^24 seconds, in milliseconds.
const UNREAL_COUNTER_OFFSET_MS: i64 = 16_777_216 * 1000;
const MIN_PING_MS: f64 = 1.0;
const MAX_PING_MS: f64 = 1000.0;
const MAX_HISTORY: usize = 10_000;

#[derive(Debug, Default)]
struct PingTrackerInner {
    last_ping_ms: Option<f64>,
    history: VecDeque<(u64, f64)>,
}

#[derive(Debug, Default)]
pub struct PingTracker {
    inner: Mutex<PingTrackerInner>,
}

impl PingTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// A server-time packet arrived; `payload` starts at its opcode and
    /// `captured_at` is when it was captured, in seconds since the epoch.
    pub fn on_server_time(&self, payload: &[u8], captured_at: f64) {
        let Some(bytes) = payload.get(CLIENT_TIME_OFFSET..CLIENT_TIME_OFFSET + 8) else {
            return;
        };
        let client_value = i64::from_le_bytes(bytes.try_into().unwrap_or_default());
        let arrival_unix_ms = captured_at * 1000.0;

        let Some(ping_ms) = counter_ping(client_value, arrival_unix_ms)
            .filter(|ms| plausible(*ms))
            .or_else(|| Some(legacy_ping(client_value, arrival_unix_ms)).filter(|ms| plausible(*ms)))
        else {
            return;
        };

        let mut inner = self.inner.lock().unwrap();
        inner.last_ping_ms = Some(ping_ms);
        inner.history.push_back((current_time_ms(), ping_ms));
        while inner.history.len() > MAX_HISTORY {
            inner.history.pop_front();
        }
    }

    pub fn current_ping_ms(&self) -> Option<f64> {
        self.inner.lock().unwrap().last_ping_ms
    }

    pub fn reset(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.history.clear();
    }
}

fn plausible(ms: f64) -> bool {
    (MIN_PING_MS..=MAX_PING_MS).contains(&ms)
}

/// Global client: the performance counter at send, against ours at arrival.
fn counter_ping(client_value: i64, arrival_unix_ms: f64) -> Option<f64> {
    let now_counter_ms = performance_counter_ms()?;
    let now_unix_ms = current_time_ms() as f64;
    // The packet was captured a little before now; step the counter back by
    // the same amount.
    let arrival_counter_ms = now_counter_ms - (now_unix_ms - arrival_unix_ms);
    let sent_counter_ms = (client_value - UNREAL_COUNTER_OFFSET_MS) as f64;
    Some((arrival_counter_ms - sent_counter_ms).round())
}

/// Taiwan and Korea clients: wall-clock time since 0001-01-01.
fn legacy_ping(client_value: i64, arrival_unix_ms: f64) -> f64 {
    let sent_unix_ms = client_value - DOTNET_EPOCH_OFFSET_MS;
    (arrival_unix_ms - sent_unix_ms as f64).round()
}

#[cfg(windows)]
fn performance_counter_ms() -> Option<f64> {
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

    let mut counter = 0i64;
    let mut frequency = 0i64;
    unsafe {
        QueryPerformanceCounter(&mut counter).ok()?;
        QueryPerformanceFrequency(&mut frequency).ok()?;
    }
    (frequency > 0).then(|| (counter / frequency) as f64 * 1000.0 + (counter % frequency) as f64 * 1000.0 / frequency as f64)
}

#[cfg(not(windows))]
fn performance_counter_ms() -> Option<f64> {
    None
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server_time(client_value: i64) -> Vec<u8> {
        let mut payload = vec![0x03, 0x36, 0x00, 0x00];
        payload.extend_from_slice(&client_value.to_le_bytes());
        payload.extend_from_slice(&[0u8; 8]);
        payload
    }

    #[test]
    fn global_counter_time_reads_as_a_ping() {
        let Some(now_counter) = performance_counter_ms() else {
            return;
        };
        let tracker = PingTracker::new();
        let sent = now_counter as i64 - 42 + UNREAL_COUNTER_OFFSET_MS;
        tracker.on_server_time(&server_time(sent), current_time_ms() as f64 / 1000.0);
        let ping = tracker.current_ping_ms().expect("ping");
        assert!((40.0..=60.0).contains(&ping), "ping {ping}");
    }

    #[test]
    fn legacy_wall_clock_time_still_reads() {
        let now = current_time_ms() as i64;
        let tracker = PingTracker::new();
        tracker.on_server_time(&server_time(now - 80 + DOTNET_EPOCH_OFFSET_MS), now as f64 / 1000.0);
        assert_eq!(tracker.current_ping_ms(), Some(80.0));
    }

    #[test]
    fn nonsense_is_ignored() {
        let tracker = PingTracker::new();
        tracker.on_server_time(&server_time(12345), current_time_ms() as f64 / 1000.0);
        assert_eq!(tracker.current_ping_ms(), None);
    }
}
