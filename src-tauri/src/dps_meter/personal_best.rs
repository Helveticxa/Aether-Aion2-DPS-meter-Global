//! Personal bests: your best DPS against each boss, per character.
//!
//! Kept apart from the history on purpose. History is capped and can be
//! deleted in one click; a personal best should survive both. It is learnt from
//! every fight the history saves, and seeded from the history already on disk
//! the first time it runs, so nobody starts from zero.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::dps_meter::history::HistoryRecord;

/// Fights shorter than this do not count: a boss finished off in a few seconds
/// gives a DPS figure no real fight can reach, and it would stand forever.
const MIN_FIGHT_SECS: f64 = 15.0;
const FILE_NAME: &str = "personal_bests.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalBest {
    pub character: String,
    pub mob_code: u32,
    pub target_name: Option<String>,
    pub dps: f64,
    pub total_damage: u64,
    pub duration_secs: f64,
    /// Milliseconds since the epoch.
    pub achieved_at: u64,
}

#[derive(Default)]
pub struct PersonalBestStore {
    bests: Mutex<HashMap<String, PersonalBest>>,
    path: Mutex<Option<PathBuf>>,
}

fn key(character: &str, mob_code: u32) -> String {
    format!("{character}|{mob_code}")
}

impl PersonalBestStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Load from `dir`, or build from `history` when nothing was saved yet.
    pub fn init(&self, dir: PathBuf, history: &[HistoryRecord]) {
        let path = dir.join(FILE_NAME);
        let loaded = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<PersonalBest>>(&bytes).ok());
        *self.path.lock().unwrap() = Some(path);

        match loaded {
            Some(list) => {
                let mut bests = self.bests.lock().unwrap();
                for best in list {
                    bests.insert(key(&best.character, best.mob_code), best);
                }
            }
            None => {
                self.record(history);
                self.write();
            }
        }
    }

    pub fn get(&self, character: &str, mob_code: u32) -> Option<PersonalBest> {
        self.bests
            .lock()
            .unwrap()
            .get(&key(character, mob_code))
            .cloned()
    }

    pub fn all(&self) -> Vec<PersonalBest> {
        let mut list: Vec<PersonalBest> = self.bests.lock().unwrap().values().cloned().collect();
        list.sort_by(|a, b| b.achieved_at.cmp(&a.achieved_at));
        list
    }

    /// Learn from saved fights. Returns whether any best improved, and writes
    /// the file when one did.
    pub fn record_and_save(&self, records: &[HistoryRecord]) -> bool {
        let changed = self.record(records);
        if changed {
            self.write();
        }
        changed
    }

    pub fn clear(&self) -> usize {
        let count = {
            let mut bests = self.bests.lock().unwrap();
            let count = bests.len();
            bests.clear();
            count
        };
        self.write();
        count
    }

    fn record(&self, records: &[HistoryRecord]) -> bool {
        let mut bests = self.bests.lock().unwrap();
        let mut changed = false;
        for candidate in records.iter().filter_map(candidate) {
            let slot = key(&candidate.character, candidate.mob_code);
            let better = bests
                .get(&slot)
                .map_or(true, |current| candidate.dps > current.dps);
            if better {
                bests.insert(slot, candidate);
                changed = true;
            }
        }
        changed
    }

    fn write(&self) {
        let Some(path) = self.path.lock().unwrap().clone() else {
            return;
        };
        let list = self.all();
        if let Ok(json) = serde_json::to_vec_pretty(&list) {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&path, json);
        }
    }
}

/// The best this record can stand for: your DPS against a boss, in a fight
/// long enough to mean something.
fn candidate(record: &HistoryRecord) -> Option<PersonalBest> {
    let target = record.target_info.as_ref()?;
    if !target.is_boss {
        return None;
    }
    let mob_code = target.target_mob_code?;
    let character = record.combat_infos.main_actor_name.as_deref()?.trim();
    if character.is_empty() {
        return None;
    }
    let you = record
        .player_stats
        .values()
        .find(|player| player.actor_name == character)?;
    if !(you.dps.is_finite() && you.dps > 0.0) {
        return None;
    }

    // Your own time on the target, and the fight's when yours is missing.
    let own = target
        .target_start_time
        .get(&you.actor_id)
        .zip(target.target_last_time.get(&you.actor_id))
        .map(|(start, end)| end - start);
    let team = || {
        let start = target.target_start_time.values().copied().fold(f64::MAX, f64::min);
        let end = target.target_last_time.values().copied().fold(f64::MIN, f64::max);
        (end > start).then_some(end - start)
    };
    let duration = own.filter(|d| *d > 0.0).or_else(team)?;
    if duration < MIN_FIGHT_SECS {
        return None;
    }

    Some(PersonalBest {
        character: character.to_string(),
        mob_code,
        target_name: target.target_name.clone(),
        dps: you.dps,
        total_damage: you.total_damage,
        duration_secs: duration,
        achieved_at: record.created_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dps_meter::models::combat::{CombatInfos, PlayerOverviewStat, TargetInfo};

    fn record(character: &str, mob: u32, is_boss: bool, dps: f64, secs: f64) -> HistoryRecord {
        let mut player_stats = HashMap::new();
        player_stats.insert(
            1,
            PlayerOverviewStat {
                actor_id: 1,
                actor_name: character.to_string(),
                actor_server_id: String::new(),
                actor_class: String::new(),
                combat_power: None,
                counts: 10,
                total_damage: (dps * secs) as u64,
                min_damage: 1,
                max_damage: 1,
                special_counts: HashMap::new(),
                dps,
                damage_share: 1.0,
                damage_contribution: 1.0,
            },
        );
        HistoryRecord {
            id: format!("{mob}-{dps}"),
            target_id: 99,
            total_damage: (dps * secs) as u64,
            target_info: Some(TargetInfo {
                id: 99,
                target_mob_code: Some(mob),
                target_name: Some("Kromede".into()),
                is_boss,
                current_hp: None,
                max_hp: None,
                target_start_time: HashMap::from([(1, 100.0)]),
                target_last_time: HashMap::from([(1, 100.0 + secs)]),
            }),
            combat_infos: CombatInfos {
                actor_infos: HashMap::new(),
                target_infos: HashMap::new(),
                main_actor_id: Some(1),
                main_actor_name: Some(character.to_string()),
                last_target_by_main_actor: None,
                last_target: None,
                time_now: 0.0,
            },
            player_skill_stats: HashMap::new(),
            player_stats,
            use_buffs_by_target: HashMap::new(),
            created_at: 1,
        }
    }

    #[test]
    fn keeps_the_best_per_character_and_boss() {
        let store = PersonalBestStore::new();
        assert!(store.record(&[record("Kapten", 7, true, 8_000.0, 60.0)]));
        assert!(!store.record(&[record("Kapten", 7, true, 7_000.0, 60.0)]), "a worse fight changes nothing");
        assert!(store.record(&[record("Kapten", 7, true, 9_000.0, 60.0)]));
        assert!(store.record(&[record("Rin", 7, true, 5_000.0, 60.0)]), "another character has their own");

        assert_eq!(store.get("Kapten", 7).map(|b| b.dps), Some(9_000.0));
        assert_eq!(store.get("Rin", 7).map(|b| b.dps), Some(5_000.0));
    }

    #[test]
    fn ordinary_mobs_and_short_fights_do_not_count() {
        let store = PersonalBestStore::new();
        assert!(!store.record(&[record("Kapten", 7, false, 8_000.0, 60.0)]));
        assert!(!store.record(&[record("Kapten", 7, true, 90_000.0, 4.0)]));
        assert!(store.get("Kapten", 7).is_none());
    }
}
