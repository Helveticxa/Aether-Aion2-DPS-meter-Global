//! Opcode census.
//!
//! When this build meets the global servers for the first time, one question
//! decides how much work follows: are the opcodes the same as the ones we
//! already parse? Korea and Taiwan agree on every opcode the three open
//! implementations handle, which is good evidence global will too -- but
//! evidence is not proof, and a silent mismatch looks exactly like an empty
//! meter.
//!
//! So count what actually arrives. Every dispatched packet is tallied by its
//! two-byte opcode, with payload sizes and whether the parser recognised it.
//! A minute of play then answers the question outright: familiar opcodes at
//! familiar sizes means the parsers should hold, and anything unknown is a
//! concrete list to work through rather than a guess.
//!
//! Disabled by default. This sits on the per-packet path, so when it is off the
//! cost is a single relaxed atomic load.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};

use serde::Serialize;

/// Guard against a pathological stream inventing endless opcodes.
const MAX_TRACKED_OPCODES: usize = 512;

static ENABLED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy)]
struct Entry {
    count: u64,
    known: bool,
    min_len: usize,
    max_len: usize,
}

static COUNTS: LazyLock<Mutex<HashMap<(u8, u8), Entry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpcodeStat {
    /// Rendered as it appears in the parsers, e.g. "04,38".
    pub opcode: String,
    pub count: u64,
    /// Whether a parser claims this opcode in this build.
    pub known: bool,
    pub min_len: usize,
    pub max_len: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CensusSnapshot {
    pub enabled: bool,
    pub total_packets: u64,
    pub known_packets: u64,
    pub unknown_packets: u64,
    /// Ordered by count, most frequent first.
    pub opcodes: Vec<OpcodeStat>,
}

pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Tally one dispatched packet. Called per packet, so it returns immediately
/// unless the census is switched on.
pub fn observe(opcode: (u8, u8), payload_len: usize, known: bool) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let Ok(mut counts) = COUNTS.lock() else {
        return;
    };

    if let Some(entry) = counts.get_mut(&opcode) {
        entry.count += 1;
        entry.min_len = entry.min_len.min(payload_len);
        entry.max_len = entry.max_len.max(payload_len);
        return;
    }

    if counts.len() >= MAX_TRACKED_OPCODES {
        return;
    }
    counts.insert(
        opcode,
        Entry {
            count: 1,
            known,
            min_len: payload_len,
            max_len: payload_len,
        },
    );
}

pub fn reset() {
    if let Ok(mut counts) = COUNTS.lock() {
        counts.clear();
    }
}

pub fn snapshot() -> CensusSnapshot {
    let enabled = is_enabled();
    let Ok(counts) = COUNTS.lock() else {
        return CensusSnapshot {
            enabled,
            total_packets: 0,
            known_packets: 0,
            unknown_packets: 0,
            opcodes: Vec::new(),
        };
    };

    let mut opcodes: Vec<OpcodeStat> = counts
        .iter()
        .map(|((first, second), entry)| OpcodeStat {
            opcode: format!("{first:02X},{second:02X}"),
            count: entry.count,
            known: entry.known,
            min_len: entry.min_len,
            max_len: entry.max_len,
        })
        .collect();
    opcodes.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.opcode.cmp(&b.opcode)));

    let known_packets = opcodes.iter().filter(|o| o.known).map(|o| o.count).sum();
    let unknown_packets = opcodes.iter().filter(|o| !o.known).map(|o| o.count).sum();

    CensusSnapshot {
        enabled,
        total_packets: known_packets + unknown_packets,
        known_packets,
        unknown_packets,
        opcodes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The census is process-global, so tests share it. Serialise them behind
    /// one lock and reset around each, rather than letting them interleave.
    static TEST_GUARD: Mutex<()> = Mutex::new(());

    fn with_census<T>(body: impl FnOnce() -> T) -> T {
        let _guard = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        set_enabled(true);
        let result = body();
        set_enabled(false);
        reset();
        result
    }

    #[test]
    fn counts_and_ranks_opcodes() {
        with_census(|| {
            observe((0x04, 0x38), 40, true);
            observe((0x04, 0x38), 60, true);
            observe((0x99, 0x99), 10, false);

            let snapshot = snapshot();
            assert_eq!(snapshot.total_packets, 3);
            assert_eq!(snapshot.known_packets, 2);
            assert_eq!(snapshot.unknown_packets, 1);

            let top = &snapshot.opcodes[0];
            assert_eq!(top.opcode, "04,38");
            assert_eq!(top.count, 2);
            assert_eq!(top.min_len, 40);
            assert_eq!(top.max_len, 60);
            assert!(top.known);

            let unknown = snapshot.opcodes.iter().find(|o| o.opcode == "99,99").unwrap();
            assert!(!unknown.known);
        });
    }

    #[test]
    fn records_nothing_while_disabled() {
        let _guard = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        set_enabled(false);

        observe((0x04, 0x38), 40, true);
        assert_eq!(snapshot().total_packets, 0);

        reset();
    }
}
