import { invoke } from "@tauri-apps/api/core";

import categoriesJson from "@/games/aion2/data/maps/categories.json";
import sampleMarkersJson from "@/games/aion2/data/maps/markers.sample.json";
import zonesJson from "@/games/aion2/data/maps/zones.json";
import type { MapDataset, MapMarker, MapZone, MarkerCategory } from "@/games/aion2/lib/map-data";

const BUNDLED_ZONES = zonesJson as MapZone[];
const BUNDLED_CATEGORIES = categoriesJson as MarkerCategory[];
const BUNDLED_SAMPLE_MARKERS = sampleMarkersJson as MapMarker[];

/** What `load_map_dataset` returns when a survey exists on disk. */
type ExternalDataset = {
  zones?: MapZone[];
  categories?: MarkerCategory[];
  markers: MapMarker[];
};

/**
 * Prefer a survey on disk; fall back to the bundled sample.
 *
 * The real dataset is not going to arrive in a release build. It comes out of
 * the global client, and getting it right will take several passes of
 * extracting, looking at the map, and adjusting. Reading it from the app's data
 * directory means each of those passes is a file copy rather than a rebuild and
 * a reinstall.
 *
 * A missing or malformed file is not an error worth showing: the sample renders
 * instead, clearly labelled, and the map stays usable.
 */
export async function loadMapDataset(): Promise<MapDataset> {
  try {
    const external = await invoke<ExternalDataset | null>("load_map_dataset");
    if (external && Array.isArray(external.markers) && external.markers.length > 0) {
      return {
        zones: external.zones?.length ? external.zones : BUNDLED_ZONES,
        categories: external.categories?.length ? external.categories : BUNDLED_CATEGORIES,
        markers: external.markers,
        sample: false,
      };
    }
  } catch {
    // No survey on disk, or it could not be parsed. The sample covers both.
  }

  return {
    zones: BUNDLED_ZONES,
    categories: BUNDLED_CATEGORIES,
    markers: BUNDLED_SAMPLE_MARKERS,
    sample: true,
  };
}

const COLLECTED_KEY = "aion2-map-collected";

/**
 * Which markers the player has already found, per marker id.
 *
 * Kept in `localStorage` rather than anywhere shared: it is one person's
 * progress on one machine, it is worthless to anyone else, and losing it costs
 * nothing that cannot be re-clicked.
 */
export function loadCollected(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLECTED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((id) => typeof id === "string")) : new Set();
  } catch {
    return new Set();
  }
}

export function saveCollected(collected: Set<string>) {
  try {
    window.localStorage.setItem(COLLECTED_KEY, JSON.stringify([...collected]));
  } catch {
    // Private window, or site data blocked. Tracking degrades to this session.
  }
}
