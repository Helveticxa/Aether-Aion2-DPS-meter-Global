use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
struct BossIdsFile {
    boss_ids: Vec<u32>,
}

pub fn load_boss_ids() -> HashSet<u32> {
    serde_json::from_str::<BossIdsFile>(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/data/boss_ids.json"
    )))
    .map(|file| file.boss_ids.into_iter().collect())
    .unwrap_or_default()
}

pub fn load_healing_skill_codes() -> HashSet<u32> {
    serde_json::from_str::<HashMap<String, Value>>(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/data/healing_skill_code.json"
    )))
    .map(|map| {
        map.into_keys()
            .filter_map(|key| key.parse::<u32>().ok())
            .collect()
    })
    .unwrap_or_default()
}

/// English NPC names, mob code -> name. Built by `scripts/build-npc-names.mjs`
/// (see there for sources); the Traditional Chinese catalogue it replaced read
/// as the app switching language whenever a target's name was shown.
pub fn load_npc_names() -> HashMap<u32, String> {
    serde_json::from_str::<HashMap<String, String>>(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/data/npc_names_en.json"
    )))
    .map(|map| {
        map.into_iter()
            .filter_map(|(key, name)| Some((key.parse::<u32>().ok()?, name)))
            .collect()
    })
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has_han(text: &str) -> bool {
        text.chars()
            .any(|c| ('\u{3400}'..='\u{4dbf}').contains(&c) || ('\u{4e00}'..='\u{9fff}').contains(&c))
    }

    #[test]
    fn npc_names_are_english_and_cover_the_bosses() {
        let names = load_npc_names();
        assert!(names.len() > 7_000, "catalogue shrank to {}", names.len());
        assert!(
            names.values().all(|name| !has_han(name)),
            "a Chinese name crept back into npc_names_en.json"
        );

        let bosses = load_boss_ids();
        let named = bosses.iter().filter(|code| names.contains_key(code)).count();
        assert!(
            named * 100 >= bosses.len() * 95,
            "only {named} of {} bosses have an English name",
            bosses.len()
        );
    }
}
