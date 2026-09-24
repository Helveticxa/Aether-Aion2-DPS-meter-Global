use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

use crate::dps_meter::region::RegionId;

pub const DEFAULT_DPS_SNAPSHOT_INTERVAL_MS: u64 = 100;
pub const DEFAULT_MEMORY_SNAPSHOT_INTERVAL_MS: u64 = 2000;
pub const DEFAULT_MAX_PACKET_SIZE_THRESHOLD: u64 = 8 * 1024;
pub const DEFAULT_STALL_RESYNC_DELAY_MS: u64 = 1000;
pub const DEFAULT_FULL_PROCESSOR_STALL_RESYNC_DELAY_MS: u64 = 200;
pub const DEFAULT_UNKNOWN_PACKET_STALL_RESYNC_DELAY_MS: u64 = 10;
pub const TRAINING_DUMMY_MOB_CODE: [u32; 2] = [2_400_032, 2_400_035];
pub const DEFAULT_HIDE_KNOWN_PLAYERS: bool = false;
pub const DEFAULT_MAX_PLAYER_COUNT: usize = 10;
/// Five minutes: long enough to read the result of a fight, short enough that
/// the next one starts clean.
pub const DEFAULT_IDLE_RESET_SECS: u64 = 300;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CaptureBackendPriority {
    WinDivertFirst,
    NpcapFirst,
}

impl Default for CaptureBackendPriority {
    fn default() -> Self {
        Self::NpcapFirst
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PvpOverlayPosition {
    Bottom,
    Right,
    Free,
}

impl Default for PvpOverlayPosition {
    fn default() -> Self {
        Self::Bottom
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DpsMeterConfig {
    #[serde(default = "default_dps_snapshot_interval_ms")]
    pub dps_snapshot_interval_ms: u64,
    #[serde(default = "default_memory_snapshot_interval_ms")]
    pub memory_snapshot_interval_ms: u64,
    #[serde(default = "default_max_packet_size_threshold")]
    pub max_packet_size_threshold: u64,
    #[serde(default = "default_stall_resync_delay_ms")]
    pub stall_resync_delay_ms: u64,
    #[serde(default = "default_full_processor_stall_resync_delay_ms")]
    pub full_processor_stall_resync_delay_ms: u64,
    #[serde(default = "default_unknown_packet_stall_resync_delay_ms")]
    pub unknown_packet_stall_resync_delay_ms: u64,
    #[serde(default)]
    pub boss_only: bool,
    #[serde(default)]
    pub pvp_mode_on: bool,
    #[serde(default)]
    pub pvp_overlay_position: PvpOverlayPosition,
    #[serde(default)]
    pub show_possible_boss: bool,
    #[serde(default)]
    pub my_muzhuang_only: bool,
    #[serde(default)]
    pub output_debug_log: bool,
    #[serde(default = "default_hide_unknown_players")]
    pub hide_unknown_players: bool,
    #[serde(default = "default_max_player_count")]
    pub max_player_count: usize,
    #[serde(default)]
    pub capture_backend_priority: CaptureBackendPriority,
    /// Which regional service to assume. Always `Auto` since 2.2.0: it parses
    /// on every service, so a choice here could only ever make things worse.
    #[serde(default)]
    pub region: RegionId,
    /// Keep the DPS overlay hidden until you are in a fight.
    #[serde(default = "default_true")]
    pub hide_when_idle: bool,
    /// Seconds without a hit of yours before the fight is saved to history
    /// and the meter starts over. 0 never resets.
    #[serde(default = "default_idle_reset_secs")]
    pub idle_reset_secs: u64,
    /// Record the first minutes of a session on a server no fingerprint
    /// matches, so an unfamiliar protocol can be studied without a replay
    /// having been started by hand.
    #[serde(default = "default_true")]
    pub auto_record_unknown_server: bool,
}

impl Default for DpsMeterConfig {
    fn default() -> Self {
        Self {
            dps_snapshot_interval_ms: DEFAULT_DPS_SNAPSHOT_INTERVAL_MS,
            memory_snapshot_interval_ms: DEFAULT_MEMORY_SNAPSHOT_INTERVAL_MS,
            max_packet_size_threshold: DEFAULT_MAX_PACKET_SIZE_THRESHOLD,
            stall_resync_delay_ms: DEFAULT_STALL_RESYNC_DELAY_MS,
            full_processor_stall_resync_delay_ms: DEFAULT_FULL_PROCESSOR_STALL_RESYNC_DELAY_MS,
            unknown_packet_stall_resync_delay_ms: DEFAULT_UNKNOWN_PACKET_STALL_RESYNC_DELAY_MS,
            boss_only: false,
            pvp_mode_on: false,
            pvp_overlay_position: PvpOverlayPosition::Bottom,
            show_possible_boss: false,
            my_muzhuang_only: false,
            output_debug_log: false,
            hide_unknown_players: false,
            max_player_count: 10,
            capture_backend_priority: CaptureBackendPriority::default(),
            region: RegionId::default(),
            hide_when_idle: true,
            idle_reset_secs: DEFAULT_IDLE_RESET_SECS,
            auto_record_unknown_server: true,
        }
    }
}

impl DpsMeterConfig {
    pub fn normalized(mut self) -> Self {
        if self.dps_snapshot_interval_ms == 0 {
            self.dps_snapshot_interval_ms = DEFAULT_DPS_SNAPSHOT_INTERVAL_MS;
        }
        if self.memory_snapshot_interval_ms == 0 {
            self.memory_snapshot_interval_ms = DEFAULT_MEMORY_SNAPSHOT_INTERVAL_MS;
        }
        self.dps_snapshot_interval_ms = self.dps_snapshot_interval_ms.clamp(50, 10_000);
        self.memory_snapshot_interval_ms = self.memory_snapshot_interval_ms.clamp(100, 10_000);
        self.max_packet_size_threshold =
            normalize_max_packet_size_threshold(self.max_packet_size_threshold);
        self.stall_resync_delay_ms = self.stall_resync_delay_ms.clamp(50, 2000);
        self.full_processor_stall_resync_delay_ms =
            self.full_processor_stall_resync_delay_ms.min(2000);
        self.unknown_packet_stall_resync_delay_ms =
            self.unknown_packet_stall_resync_delay_ms.min(500);
        // A region stored by an older build must not linger where nothing
        // shows it any more.
        self.region = RegionId::Auto;
        if self.idle_reset_secs != 0 {
            self.idle_reset_secs = self.idle_reset_secs.clamp(60, 3_600);
        }
        self
    }
}

pub type SharedDpsMeterConfig = Arc<RwLock<DpsMeterConfig>>;

fn default_dps_snapshot_interval_ms() -> u64 {
    DEFAULT_DPS_SNAPSHOT_INTERVAL_MS
}

fn default_memory_snapshot_interval_ms() -> u64 {
    DEFAULT_MEMORY_SNAPSHOT_INTERVAL_MS
}

fn default_max_packet_size_threshold() -> u64 {
    DEFAULT_MAX_PACKET_SIZE_THRESHOLD
}

fn default_stall_resync_delay_ms() -> u64 {
    DEFAULT_STALL_RESYNC_DELAY_MS
}

fn default_full_processor_stall_resync_delay_ms() -> u64 {
    DEFAULT_FULL_PROCESSOR_STALL_RESYNC_DELAY_MS
}

fn default_unknown_packet_stall_resync_delay_ms() -> u64 {
    DEFAULT_UNKNOWN_PACKET_STALL_RESYNC_DELAY_MS
}

fn default_max_player_count() -> usize {
    DEFAULT_MAX_PLAYER_COUNT
}

fn default_hide_unknown_players() -> bool {
    DEFAULT_HIDE_KNOWN_PLAYERS
}

fn default_true() -> bool {
    true
}

fn default_idle_reset_secs() -> u64 {
    DEFAULT_IDLE_RESET_SECS
}

fn normalize_max_packet_size_threshold(value: u64) -> u64 {
    if matches!(value, 2048 | 4096 | 8192 | 16384) {
        value
    } else {
        DEFAULT_MAX_PACKET_SIZE_THRESHOLD
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_region_is_brought_back_to_auto() {
        let config = DpsMeterConfig {
            region: RegionId::Tw,
            ..DpsMeterConfig::default()
        }
        .normalized();
        assert_eq!(config.region, RegionId::Auto);
    }

    #[test]
    fn idle_reset_is_kept_in_a_sane_range_and_zero_means_never() {
        let at = |secs| {
            DpsMeterConfig {
                idle_reset_secs: secs,
                ..DpsMeterConfig::default()
            }
            .normalized()
            .idle_reset_secs
        };
        assert_eq!(at(0), 0);
        assert_eq!(at(5), 60);
        assert_eq!(at(300), 300);
        assert_eq!(at(86_400), 3_600);
    }

    #[test]
    fn an_older_config_without_the_idle_fields_gets_the_defaults() {
        let config: DpsMeterConfig = serde_json::from_str("{}").expect("parse");
        assert!(config.hide_when_idle);
        assert_eq!(config.idle_reset_secs, DEFAULT_IDLE_RESET_SECS);
        assert!(config.auto_record_unknown_server);
    }
}
