use std::collections::HashMap;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DpsMeterState {
    pub npcap_available: bool,
    pub npcap_error: Option<String>,
    pub meter_running: bool,
    pub has_game_data: bool,
    pub player_identified: bool,
    /// Hits discarded because the target was not a boss while Boss only was on.
    ///
    /// Without this the meter is simply empty, with nothing on screen to say
    /// that a setting is the reason -- which is exactly how a whole play
    /// session was lost to a default nobody had looked at.
    pub boss_only_filtered: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    pub cpu_percent: f32,
    pub rss_mb: f64,
    pub vms_mb: f64,
    pub memory_percent: f32,
    /// Whole-machine load, which is what someone glancing at an overlay while
    /// playing actually wants to know -- Aether costs a fraction of a percent,
    /// so its own figure never tells you anything.
    pub system_cpu_percent: f32,
    pub system_memory_used_mb: f64,
    pub system_memory_total_mb: f64,
    pub cap_device: Option<String>,
    pub cap_port: Option<String>,
    pub packet_sizes: HashMap<String, usize>,
    pub ping_ms: Option<f64>,
    pub main_actor_name: Option<String>,
}
