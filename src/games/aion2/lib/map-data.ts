/**
 * The interactive map's data model.
 *
 * Markers are stored in **world coordinates** -- the numbers the game itself
 * uses -- and each zone carries the world rectangle its image covers. Screen
 * position is derived, never stored.
 *
 * That choice is the whole point of this file. When the global client ships we
 * extract coordinates from it directly, and they drop in unchanged: no
 * re-measuring against a particular image, no drift if the image is replaced
 * with a sharper one, and the same numbers work for the full map and the
 * overlay minimap. Storing pixel positions would have tied the dataset to one
 * screenshot forever.
 */

export type World = "elyos" | "asmodian" | "abyss";

/** The world-space rectangle a zone image covers. */
export type WorldBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type MapZone = {
  id: string;
  /**
   * The source map code, e.g. `World_L_A`. Also the tile directory and the
   * tile filename prefix.
   */
  code: string;
  name: string;
  world: World;
  bounds: WorldBounds;
  /**
   * Side of the high-resolution tile grid. Tiles are 1024px each, so a grid of
   * 8 reconstructs the zone at its native 8192px -- twice the bundled image.
   */
  tileGrid: number;
  /**
   * Path to the zone image, served from `public/`. Absent until a map has been
   * added -- the viewer draws a calibration grid instead, so a zone with
   * markers but no image is still usable.
   */
  image?: string;
};

export type MarkerCategory = {
  id: string;
  /** Heading it sits under in the filter panel. */
  group: string;
  label: string;
  /** CSS colour for the marker and the filter swatch. */
  color: string;
  /**
   * Which glyph to draw. Categories share shapes -- every herb is a leaf --
   * and are told apart by colour within a shape. See `map-icons`.
   */
  shape: string;
};

export type MapMarker = {
  id: string;
  zone: string;
  category: string;
  name: string;
  x: number;
  y: number;
  note?: string;
};

/** One closed region outline, in world coordinates. */
export type MapBorder = {
  id: string;
  zone: string;
  points: Array<[number, number]>;
};

export type MapDataset = {
  zones: MapZone[];
  categories: MarkerCategory[];
  markers: MapMarker[];
  borders: MapBorder[];
};

export function groupCategories(categories: MarkerCategory[]): Map<string, MarkerCategory[]> {
  const groups = new Map<string, MarkerCategory[]>();
  for (const category of categories) {
    const list = groups.get(category.group);
    if (list) list.push(category);
    else groups.set(category.group, [category]);
  }
  return groups;
}

export function countByCategory(markers: MapMarker[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const marker of markers) {
    counts.set(marker.category, (counts.get(marker.category) ?? 0) + 1);
  }
  return counts;
}
