import { invoke } from "@tauri-apps/api/core";

import type {
  MapBorder,
  MapDataset,
  MapMarker,
  MapZone,
  MarkerCategory,
} from "@/games/aion2/lib/map-data";

/** What `load_map_dataset` returns when a survey has been installed on disk. */
type ExternalDataset = {
  zones?: MapZone[];
  categories?: MarkerCategory[];
  markers: MapMarker[];
  borders?: MapBorder[];
};

/**
 * Load the map dataset, preferring one installed on disk.
 *
 * The bundled data is imported dynamically rather than at module scope: the
 * markers alone are half a megabyte, and nothing outside the map screen needs
 * it. This keeps it out of the main bundle and off the startup path.
 *
 * A dataset in the app's data directory wins, so the data can be corrected or
 * extended without rebuilding and reinstalling -- which matters because
 * refining it is an iterative job.
 */
export async function loadMapDataset(): Promise<MapDataset> {
  const [zones, categories, markers, borders] = await Promise.all([
    import("@/games/aion2/data/maps/zones.json").then((m) => m.default as MapZone[]),
    import("@/games/aion2/data/maps/categories.json").then((m) => m.default as MarkerCategory[]),
    import("@/games/aion2/data/maps/markers.json").then((m) => m.default as MapMarker[]),
    import("@/games/aion2/data/maps/borders.json").then((m) => m.default as MapBorder[]),
  ]);

  try {
    const external = await invoke<ExternalDataset | null>("load_map_dataset");
    if (external && Array.isArray(external.markers) && external.markers.length > 0) {
      return {
        zones: external.zones?.length ? external.zones : zones,
        categories: external.categories?.length ? external.categories : categories,
        markers: external.markers,
        borders: external.borders?.length ? external.borders : borders,
      };
    }
  } catch {
    // No dataset installed, or it could not be parsed. The bundle covers both.
  }

  return { zones, categories, markers, borders };
}

/**
 * What a first look shows: the landmarks you navigate by, not every gatherable
 * in the zone.
 *
 * An allow-list rather than a deny-list, so a category added to the dataset
 * later starts hidden instead of quietly crowding the map. Lives here rather
 * than in the map page because the overlay needs it too, and the two windows
 * must not disagree about what a fresh install shows.
 */
const SHOWN_BY_DEFAULT = new Set([
  "waystone",
  "bahan-monolith",
  "segel",
  "wilayah",
  "medan-perang",
  "desa",
  "kubus-tersembunyi",
]);

export function defaultHidden(categories: Array<{ id: string }>): string[] {
  return categories.filter((c) => !SHOWN_BY_DEFAULT.has(c.id)).map((c) => c.id);
}

const COLLECTED_KEY = "aion2-map-collected";
const HIDDEN_KEY = "aion2-map-hidden";

/**
 * Which markers the player has already found.
 *
 * Kept in `localStorage` rather than anywhere shared: it is one person's
 * progress on one machine, worthless to anyone else, and losing it costs
 * nothing that cannot be re-clicked.
 */
export function loadCollected(): Set<string> {
  return readSet(COLLECTED_KEY);
}

export function saveCollected(collected: Set<string>) {
  writeSet(COLLECTED_KEY, collected);
}

/**
 * Which categories are switched off.
 *
 * Persisted because the useful default is personal: someone farming ore wants
 * everything else hidden, and re-hiding twenty categories on every launch would
 * make the filter feel like a chore.
 */
export function loadHidden(fallback: string[]): Set<string> {
  try {
    if (window.localStorage.getItem(HIDDEN_KEY) === null) return new Set(fallback);
  } catch {
    return new Set(fallback);
  }
  return readSet(HIDDEN_KEY);
}

export function saveHidden(hidden: Set<string>) {
  writeSet(HIDDEN_KEY, hidden);
}

function readSet(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeSet(key: string, value: Set<string>) {
  try {
    window.localStorage.setItem(key, JSON.stringify([...value]));
  } catch {
    // Private window, or site data blocked. Degrades to this session.
  }
}
