//! Regional service profiles.
//!
//! AION2 runs separate services per region: Taiwan, Korea, and the global
//! service launching 2026-10-05. The capture layer is already region-agnostic --
//! it finds the device and port by scanning for the heartbeat magic rather than
//! by a hardcoded address -- but the *parsers* are not, because a server id is
//! used structurally to locate fields inside player-info packets.
//!
//! Upstream hardcoded Taiwan's exact server list (`1001..=1021`, `2001..=2021`).
//! On any other service that check rejects every candidate offset,
//! `find_server_id` returns `None`, and no player is ever named -- a silent,
//! total failure rather than an error. This module replaces that constant with
//! per-region profiles and a structural fallback that holds on services we have
//! not seen yet.
//!
//! It also records what we actually observe (server ids, server IPs).
//! Fingerprints for Korea and global are thin today; these observations are what
//! will fill them in from a real capture.
//!
//! The runtime lives in a process-global on purpose: it is one app-wide setting
//! plus an observation log, and threading it through every parser would enlarge
//! the diff against an upstream that is still actively developed.

use std::collections::BTreeSet;
use std::ops::RangeInclusive;
use std::sync::{LazyLock, RwLock};

use serde::{Deserialize, Serialize};

/// Which regional service to assume when interpreting packets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RegionId {
    /// Accept any structurally plausible server id. Works on every service,
    /// including ones whose id range we have not catalogued yet.
    #[default]
    Auto,
    Tw,
    Kr,
    Global,
}

/// Taiwan's catalogued servers -- matches the bundled `servers.json`, which is
/// also the only list we can resolve names from today.
const TW_SERVER_IDS: &[RangeInclusive<u32>] = &[1001..=1021, 2001..=2021];

/// Structural fallback for services we have not catalogued.
///
/// Server ids are `raceId * 1000 + index` (race 1 Elyos, race 2 Asmodian), as
/// confirmed by the bundled Taiwan server list. Allowing the full per-race band
/// keeps the disambiguation power the parser relies on -- an arbitrary `u16`
/// still fails -- without assuming how many servers a region runs.
const GENERIC_SERVER_IDS: &[RangeInclusive<u32>] = &[1001..=1999, 2001..=2999];

/// Korea's server block, taken from the (MIT) TK-open-public meter, which pinned
/// `206.127.156.0/24:13328`. This is the one region fingerprint we can state from
/// evidence; Taiwan's and global's IP blocks are still unknown.
const KR_IP_PREFIXES: &[[u8; 3]] = &[[206, 127, 156]];

impl RegionId {
    pub fn label(self) -> &'static str {
        match self {
            RegionId::Auto => "Auto",
            RegionId::Tw => "Taiwan",
            RegionId::Kr => "Korea",
            RegionId::Global => "Global",
        }
    }

    fn server_id_ranges(self) -> &'static [RangeInclusive<u32>] {
        match self {
            // Taiwan is the only catalogued list, so it can stay tight.
            RegionId::Tw => TW_SERVER_IDS,
            // Korea and global have no catalogue yet; a tight guess here would
            // reproduce exactly the silent failure this module exists to remove.
            RegionId::Auto | RegionId::Kr | RegionId::Global => GENERIC_SERVER_IDS,
        }
    }

    /// Whether `server_id` is plausible for this region.
    pub fn accepts_server_id(self, server_id: u32) -> bool {
        self.server_id_ranges()
            .iter()
            .any(|range| range.contains(&server_id))
    }
}

/// What the running capture has actually seen.
#[derive(Debug, Default)]
struct RegionRuntime {
    configured: RegionId,
    server_ids: BTreeSet<u32>,
    server_ips: BTreeSet<[u8; 4]>,
}

static RUNTIME: LazyLock<RwLock<RegionRuntime>> =
    LazyLock::new(|| RwLock::new(RegionRuntime::default()));

/// Snapshot for the UI and for diagnosing an unfamiliar service.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionStatus {
    /// What the user picked.
    pub configured: RegionId,
    /// What the traffic looks like, when we can tell. `None` means no
    /// fingerprint matched -- not that something is wrong.
    pub detected: Option<RegionId>,
    /// The profile actually applied to parsing.
    pub effective: RegionId,
    /// Whether server *names* can be resolved, i.e. every id seen is in the
    /// bundled Taiwan catalogue. False elsewhere until more lists are bundled.
    pub server_names_available: bool,
    pub observed_server_ids: Vec<u32>,
    pub observed_server_ips: Vec<String>,
}

pub fn set_configured(region: RegionId) {
    if let Ok(mut runtime) = RUNTIME.write() {
        runtime.configured = region;
    }
}

pub fn configured() -> RegionId {
    RUNTIME
        .read()
        .map(|runtime| runtime.configured)
        .unwrap_or_default()
}

/// The region whose rules parsing should follow.
///
/// An explicit choice always wins. `Auto` uses the permissive profile rather
/// than a guess, so a service we have never seen still parses.
pub fn effective() -> RegionId {
    configured()
}

/// Region-aware replacement for upstream's hardcoded Taiwan check.
pub fn accepts_server_id(server_id: u32) -> bool {
    effective().accepts_server_id(server_id)
}

pub fn observe_server_id(server_id: u32) {
    if let Ok(mut runtime) = RUNTIME.write() {
        runtime.server_ids.insert(server_id);
    }
}

pub fn observe_server_ip(ip: [u8; 4]) {
    if let Ok(mut runtime) = RUNTIME.write() {
        // A session talks to a handful of hosts, but never trust that blindly
        // with an unfamiliar service.
        if runtime.server_ips.len() < 32 {
            runtime.server_ips.insert(ip);
        }
    }
}

pub fn reset_observations() {
    if let Ok(mut runtime) = RUNTIME.write() {
        runtime.server_ids.clear();
        runtime.server_ips.clear();
    }
}

pub fn status() -> RegionStatus {
    let Ok(runtime) = RUNTIME.read() else {
        return RegionStatus {
            configured: RegionId::Auto,
            detected: None,
            effective: RegionId::Auto,
            server_names_available: false,
            observed_server_ids: Vec::new(),
            observed_server_ips: Vec::new(),
        };
    };

    let detected = detect(&runtime);
    let server_names_available = !runtime.server_ids.is_empty()
        && runtime
            .server_ids
            .iter()
            .all(|id| RegionId::Tw.accepts_server_id(*id));

    RegionStatus {
        configured: runtime.configured,
        detected,
        effective: if runtime.configured == RegionId::Auto {
            detected.unwrap_or(RegionId::Auto)
        } else {
            runtime.configured
        },
        server_names_available,
        observed_server_ids: runtime.server_ids.iter().copied().collect(),
        observed_server_ips: runtime.server_ips.iter().map(format_ipv4).collect(),
    }
}

/// Identify the service from what we have seen.
///
/// Only claims a region on evidence. Korea is identifiable by its server block;
/// Taiwan and global are not yet, so this returns `None` for them rather than
/// guessing from a server-id range they may well share.
fn detect(runtime: &RegionRuntime) -> Option<RegionId> {
    if runtime
        .server_ips
        .iter()
        .any(|ip| KR_IP_PREFIXES.contains(&[ip[0], ip[1], ip[2]]))
    {
        return Some(RegionId::Kr);
    }
    None
}

fn format_ipv4(ip: &[u8; 4]) -> String {
    format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taiwan_profile_matches_the_bundled_catalogue() {
        assert!(RegionId::Tw.accepts_server_id(1001));
        assert!(RegionId::Tw.accepts_server_id(2021));
        assert!(!RegionId::Tw.accepts_server_id(1022));
    }

    #[test]
    fn auto_accepts_ids_outside_taiwans_catalogue() {
        // The regression this module exists to prevent: a server id outside
        // Taiwan's list, which upstream silently rejected -- leaving every
        // player on that service unnamed.
        assert!(!RegionId::Tw.accepts_server_id(1042));
        assert!(RegionId::Auto.accepts_server_id(1042));
        assert!(RegionId::Global.accepts_server_id(1042));
    }

    #[test]
    fn plausibility_still_rejects_arbitrary_values() {
        for id in [0u32, 1, 999, 1000, 2000, 3001, 65535] {
            assert!(!RegionId::Auto.accepts_server_id(id), "accepted {id}");
        }
    }

    #[test]
    fn korea_is_detected_from_its_server_block() {
        let mut runtime = RegionRuntime::default();
        runtime.server_ips.insert([206, 127, 156, 40]);
        assert_eq!(detect(&runtime), Some(RegionId::Kr));

        let mut elsewhere = RegionRuntime::default();
        elsewhere.server_ips.insert([1, 2, 3, 4]);
        assert_eq!(detect(&elsewhere), None);
    }
}
