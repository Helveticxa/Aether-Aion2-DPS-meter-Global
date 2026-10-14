// Defaults for the Kina calculator, from the bundled game data, and the
// calculator's own storage. Everything typed into the page lives here, on this
// PC only.
import kinaData from "@/games/aion2/data/kina.json";
import {
  newCharacter,
  restoreState,
  type Dungeon,
  type KinaState,
  type Rules,
} from "@/games/aion2/lib/kina";

const STORAGE_KEY = "aether.kina.v2";

export const KINA_DATA_UPDATED: string = kinaData.updated;
export const KINA_DATA_SOURCE: string = kinaData.source;

export function defaultDungeons(): Dungeon[] {
  return kinaData.dungeons.map((dungeon) => ({ ...dungeon }));
}

export function defaultRules(): Rules {
  return {
    ...kinaData.rules,
    materials: kinaData.rules.materials.map((material) => ({ ...material })),
    playTiers: kinaData.rules.playTiers.map((tier) => ({ ...tier })),
  };
}

export function defaultState(): KinaState {
  return {
    version: 2,
    characters: [newCharacter(0)],
    dungeons: defaultDungeons(),
    rules: defaultRules(),
  };
}

export function loadKinaState(): KinaState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return restoreState(raw ? JSON.parse(raw) : null, defaultState());
  } catch {
    return defaultState();
  }
}

export function saveKinaState(state: KinaState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // A full or blocked storage loses this session's edits, nothing more.
  }
}
