use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::dps_meter::models::combat::{
    BuffSummary, CombatInfos, CombatSnapshot, PlayerOverviewStat, SkillStats, TargetInfo,
};

const MAGIC: &[u8; 4] = b"DPSH";
const VERSION: u16 = 1;
const HISTORY_THRESHOLD: u64 = 1_000_000;
const MAX_RECORDS: usize = 500;

// =============================================================================
// Per-target history record
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub id: String,
    pub target_id: u32,
    pub total_damage: u64,
    pub target_info: Option<TargetInfo>,
    pub combat_infos: CombatInfos,
    pub player_skill_stats: HashMap<u32, HashMap<u32, SkillStats>>,
    pub player_stats: HashMap<u32, PlayerOverviewStat>,
    #[serde(default)]
    pub use_buffs_by_target: HashMap<u32, Vec<BuffSummary>>,
    pub created_at: u64,
}

/// A record as the history list shows it. The per-skill numbers and the buffs
/// are nine tenths of a record -- 15.7 MB of JSON for 324 fights, measured --
/// and the list sent all of it to its window on every open and after every
/// fight. The detail window asks for one whole record when a player is
/// clicked.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySummary {
    pub id: String,
    pub target_id: u32,
    pub total_damage: u64,
    pub target_info: Option<TargetInfo>,
    pub combat_infos: HistorySummaryInfos,
    pub player_stats: HashMap<u32, PlayerOverviewStat>,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySummaryInfos {
    pub main_actor_id: Option<u32>,
    pub main_actor_name: Option<String>,
}

impl From<&HistoryRecord> for HistorySummary {
    fn from(record: &HistoryRecord) -> Self {
        Self {
            id: record.id.clone(),
            target_id: record.target_id,
            total_damage: record.total_damage,
            target_info: record.target_info.clone(),
            combat_infos: HistorySummaryInfos {
                main_actor_id: record.combat_infos.main_actor_id,
                main_actor_name: record.combat_infos.main_actor_name.clone(),
            },
            player_stats: record.player_stats.clone(),
            created_at: record.created_at,
        }
    }
}

/// Replace `path` with `bytes` in one step: written beside it, then renamed
/// over it. Writing in place meant a crash or a power cut mid-write left a
/// file that failed its checksum, and the next fight saved over it -- every
/// earlier record gone.
pub(crate) fn write_atomically(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&temp, path)
}

// =============================================================================
// Store
// =============================================================================

pub struct HistoryStore {
    records: Mutex<VecDeque<HistoryRecord>>,
    dir: Mutex<Option<PathBuf>>,
}

impl HistoryStore {
    pub fn new() -> Self {
        Self {
            records: Mutex::new(VecDeque::new()),
            dir: Mutex::new(None),
        }
    }

    pub fn get_records(&self) -> Vec<HistoryRecord> {
        self.records.lock().unwrap().iter().cloned().collect()
    }

    /// Every record, as the history list shows it.
    pub fn get_summaries(&self) -> Vec<HistorySummary> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .map(HistorySummary::from)
            .collect()
    }

    /// One whole record, for the detail window.
    pub fn get_record(&self, id: &str) -> Option<HistoryRecord> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .find(|record| record.id == id)
            .cloned()
    }

    pub fn clear_all(&self) -> usize {
        let mut stored = self.records.lock().unwrap();
        let count = stored.len();
        stored.clear();
        self.write_to_disk(&[]);
        count
    }

    pub fn delete_record(&self, id: &str) -> bool {
        let mut stored = self.records.lock().unwrap();
        let old_len = stored.len();
        stored.retain(|r| r.id != id);
        if stored.len() != old_len {
            let snapshot: Vec<HistoryRecord> = stored.iter().cloned().collect();
            self.write_to_disk(&snapshot);
            true
        } else {
            false
        }
    }

    pub fn delete_records(&self, ids: &[String]) -> usize {
        if ids.is_empty() {
            return 0;
        }

        let ids: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
        let mut stored = self.records.lock().unwrap();
        let old_len = stored.len();
        stored.retain(|record| !ids.contains(record.id.as_str()));
        let deleted = old_len - stored.len();

        if deleted > 0 {
            let snapshot: Vec<HistoryRecord> = stored.iter().cloned().collect();
            self.write_to_disk(&snapshot);
        }

        deleted
    }

    pub fn init_dir(&self, app_data_dir: PathBuf) {
        let dir = app_data_dir.join("history");
        let _ = std::fs::create_dir_all(&dir);
        *self.dir.lock().unwrap() = Some(dir);
    }

    /// Persist current snapshot as per-target history records, then clear.
    /// Returns what was saved, for the personal bests to learn from.
    pub fn save_and_clear(&self, snapshot: CombatSnapshot) -> Vec<HistoryRecord> {
        let records = Self::extract_records(snapshot);
        if !records.is_empty() {
            self.push(records.clone());
        }
        records
    }

    fn extract_records(snapshot: CombatSnapshot) -> Vec<HistoryRecord> {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        snapshot
            .by_target_player_stats
            .into_iter()
            .filter_map(|(target_id, player_stats)| {
                let total_damage: u64 = player_stats.values().map(|s| s.total_damage).sum();

                if total_damage <= HISTORY_THRESHOLD {
                    return None;
                }

                let target_info = snapshot.combat_infos.target_infos.get(&target_id).cloned();

                let skill_stats = snapshot
                    .by_target_player_skill_stats
                    .get(&target_id)
                    .cloned()
                    .unwrap_or_default();

                let relevant_buff_targets: HashSet<u32> = std::iter::once(target_id)
                    .chain(player_stats.keys().copied())
                    .collect();
                let use_buffs_by_target = snapshot
                    .use_buffs_by_target
                    .iter()
                    .filter_map(|(buff_target_id, buffs)| {
                        relevant_buff_targets
                            .contains(buff_target_id)
                            .then(|| (*buff_target_id, buffs.clone()))
                    })
                    .collect();

                let combat_infos = CombatInfos {
                    target_infos: target_info
                        .as_ref()
                        .map(|ti| {
                            let mut m = HashMap::new();
                            m.insert(target_id, ti.clone());
                            m
                        })
                        .unwrap_or_default(),
                    ..snapshot.combat_infos.clone()
                };

                Some(HistoryRecord {
                    id: format!("{}-{}", target_id, now_ms),
                    target_id,
                    total_damage,
                    target_info,
                    combat_infos,
                    player_stats,
                    player_skill_stats: skill_stats,
                    use_buffs_by_target,
                    created_at: now_ms,
                })
            })
            .collect()
    }

    fn push(&self, records: Vec<HistoryRecord>) {
        let mut stored = self.records.lock().unwrap();
        stored.extend(records);

        // Trim to max
        while stored.len() > MAX_RECORDS {
            stored.pop_front();
        }

        // Write to disk
        let snapshot: Vec<HistoryRecord> = stored.iter().cloned().collect();
        self.write_to_disk(&snapshot);
    }

    // =========================================================================
    // Disk I/O (lz4 compressed binary)
    // =========================================================================

    fn write_to_disk(&self, records: &[HistoryRecord]) {
        let dir = match self.dir.lock().unwrap().as_ref() {
            Some(d) => d.clone(),
            None => return,
        };

        let json = serde_json::to_vec(records).unwrap_or_default();
        let compressed = lz4_flex::compress_prepend_size(&json);

        let crc = crc32fast::hash(&compressed);

        let mut bytes = Vec::with_capacity(10 + compressed.len());
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&VERSION.to_le_bytes());
        bytes.extend_from_slice(&crc.to_le_bytes());
        bytes.extend_from_slice(&compressed);
        if let Err(error) = write_atomically(&dir.join("combat_history.bin"), &bytes) {
            eprintln!("[history] failed to write: {error}");
        }
    }

    /// A history file that cannot be read is moved aside rather than left
    /// where the next save would overwrite it: whatever is in it can still be
    /// recovered by hand.
    fn set_aside(file_path: &std::path::Path, reason: &str) {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let mut aside = file_path.as_os_str().to_owned();
        aside.push(format!(".unreadable-{stamp}"));
        let moved = std::fs::rename(file_path, PathBuf::from(&aside));
        eprintln!("[history] {reason}; kept as {aside:?} ({moved:?})");
    }

    pub fn load_from_disk(&self) {
        let dir = match self.dir.lock().unwrap().as_ref() {
            Some(d) => d.clone(),
            None => return,
        };

        let file_path = dir.join("combat_history.bin");
        let data = match std::fs::read(&file_path) {
            Ok(d) => d,
            Err(_) => return,
        };

        match Self::decode(&data) {
            Ok(records) => {
                let mut stored = self.records.lock().unwrap();
                stored.clear();
                stored.extend(records);
            }
            Err(reason) => Self::set_aside(&file_path, &reason),
        }
    }

    fn decode(data: &[u8]) -> Result<Vec<HistoryRecord>, String> {
        if data.len() < 10 {
            return Err("file too short".to_string());
        }
        if &data[0..4] != MAGIC {
            return Err("bad magic".to_string());
        }
        let version = u16::from_le_bytes([data[4], data[5]]);
        if version != VERSION {
            return Err(format!("unsupported version {version}"));
        }
        let expected_crc = u32::from_le_bytes([data[6], data[7], data[8], data[9]]);
        let compressed = &data[10..];
        if crc32fast::hash(compressed) != expected_crc {
            return Err("CRC mismatch".to_string());
        }
        let json = lz4_flex::decompress_size_prepended(compressed)
            .map_err(|error| format!("decompress failed: {error}"))?;
        serde_json::from_slice::<Vec<HistoryRecord>>(&json)
            .map_err(|error| format!("parse failed: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_in(dir: &std::path::Path) -> HistoryStore {
        let store = HistoryStore::new();
        *store.dir.lock().unwrap() = Some(dir.to_path_buf());
        store
    }

    fn record(id: &str) -> HistoryRecord {
        HistoryRecord {
            id: id.to_string(),
            target_id: 7,
            total_damage: 2_000_000,
            target_info: None,
            combat_infos: CombatInfos {
                actor_infos: HashMap::new(),
                target_infos: HashMap::new(),
                main_actor_id: Some(1),
                main_actor_name: Some("Rin".to_string()),
                last_target_by_main_actor: None,
                last_target: None,
                time_now: 0.0,
            },
            player_skill_stats: HashMap::from([(1, HashMap::from([(11_000_000, SkillStats::new())]))]),
            player_stats: HashMap::new(),
            use_buffs_by_target: HashMap::new(),
            created_at: 1,
        }
    }

    #[test]
    fn records_survive_a_restart_and_the_list_leaves_the_heavy_parts_out() {
        let dir = std::env::temp_dir().join(format!("aether-history-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = store_in(&dir);
        store.push(vec![record("a"), record("b")]);

        let reopened = store_in(&dir);
        reopened.load_from_disk();
        assert_eq!(reopened.get_records().len(), 2);
        assert!(reopened.get_record("b").is_some_and(|r| !r.player_skill_stats.is_empty()));
        let listed = serde_json::to_string(&reopened.get_summaries()).unwrap();
        assert!(!listed.contains("playerSkillStats") && !listed.contains("actorInfos"));
        assert!(listed.contains("\"mainActorName\":\"Rin\""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_file_is_kept_aside_not_overwritten() {
        let dir = std::env::temp_dir().join(format!("aether-history-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("combat_history.bin"), b"DPSH\x01\x00garbage-garbage").unwrap();

        let store = store_in(&dir);
        store.load_from_disk();
        assert!(store.get_records().is_empty());
        let kept = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().contains(".unreadable-"));
        assert!(kept);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
