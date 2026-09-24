// The same English catalogue the backend names targets from, so History and
// the live overlay always agree on what a mob is called.
import npcNamesData from "../../../../src-tauri/data/npc_names_en.json";
import dungeonsData from "@/games/aion2/data/dungeons.json";

type LocalizedText = Record<string, string | undefined>;

type DungeonEntry = {
  dungeon_id: string;
  name: LocalizedText;
  difficulty: LocalizedText;
  boss_ids: number[];
};

const npcNames = npcNamesData as Record<string, string>;
const dungeons = dungeonsData as DungeonEntry[];
const dungeonByMobCode = new Map<string, DungeonEntry>();

for (const dungeon of dungeons) {
  for (const bossId of dungeon.boss_ids) {
    dungeonByMobCode.set(String(bossId), dungeon);
  }
}

export function getNpcName(npcId: number | string): string | undefined {
  return npcNames[String(npcId)];
}

export function getNpcDisplayName(npcId: number | string): string {
  return getNpcName(npcId) ?? `Boss ${String(npcId)}`;
}

export function getDungeonByMobCode(mobCode: number | string): DungeonEntry | undefined {
  return dungeonByMobCode.get(String(mobCode));
}

export function getKnownBossMobCodes(): string[] {
  return Array.from(dungeonByMobCode.keys());
}

export function getDungeonNameByMobCode(
  mobCode: number | string,
  language = "en"
): string | undefined {
  const dungeon = getDungeonByMobCode(mobCode);
  if (!dungeon) {
    return undefined;
  }

  return dungeon.name[language] ?? dungeon.name.en;
}

export function getDungeonDifficultyByMobCode(
  mobCode: number | string,
  language = "en"
): string | undefined {
  const dungeon = getDungeonByMobCode(mobCode);
  if (!dungeon) {
    return undefined;
  }

  return dungeon.difficulty[language] ?? dungeon.difficulty.en;
}

export function getDungeonDisplayNameByMobCode(
  mobCode: number | string,
  language = "en"
): string {
  return getDungeonNameByMobCode(mobCode, language) ?? "Unknown dungeon";
}
