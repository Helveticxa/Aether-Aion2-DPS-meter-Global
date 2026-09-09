/**
 * A distinct glyph for every marker category.
 *
 * Colour alone makes a map a memory test: fifteen dots differing only in hue
 * means checking the legend every time. Shape is read before colour, so each
 * category gets a silhouette that is identifiable on its own -- the colour then
 * reinforces rather than carries.
 *
 * The rule that shaped these: **no two may share a silhouette.** Sealed Dungeon
 * started as the Dungeon arch with a padlock added and was redrawn as a bare
 * padlock, because at 14px an arch-with-something is just an arch.
 *
 * Drawn here rather than taken from anywhere. The reference sites serve the
 * game client's own marker textures (`UI/Resource/Texture/Icon/UT_Marker_*`);
 * these are original, and follow lucide's conventions -- 24x24, 2px stroke,
 * round caps -- because lucide is what the rest of the app uses.
 *
 * Values are inner SVG markup, authored in this file and never from input, so
 * injecting them as HTML is safe.
 */

export const MARKER_ICONS: Record<string, string> = {
  // --- Locations -----------------------------------------------------------

  /** Two rooftops of unequal height. */
  settlement: '<path d="M2 21v-6.5L6 11l4 3.5V21"/><path d="M11 21v-9l5.5-4L22 12v9"/><path d="M1 21h22"/>',

  /** Pennant on a pole. */
  region: '<path d="M6 22V3"/><path d="M6 4h13l-3 4 3 4H6"/>',

  /** Crenellated wall with a gate. */
  stronghold:
    '<path d="M3 21V10h3V7h3v3h6V7h3v3h3v11"/><path d="M10 21v-4a2 2 0 0 1 4 0v4"/><path d="M2 21h20"/>',

  /** Barred archway. */
  dungeon: '<path d="M4 21V11a8 8 0 0 1 16 0v10"/><path d="M9 21v-8"/><path d="M15 21v-8"/>',

  /** A padlock -- deliberately not an arch, so it cannot be confused with one. */
  "sealed-dungeon":
    '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v3"/>',

  /** Portal oval, torn down the middle. */
  rift: '<ellipse cx="12" cy="12" rx="6.5" ry="9.5"/><path d="M12.5 3.5 10 11l3.5 1.2L11 20.5"/>',

  /** Tapered standing stone on a plinth. */
  monolith: '<path d="M9.5 20V6l2.5-4 2.5 4v14"/><path d="M7 20h10"/><path d="M5 23h14"/>',

  /**
   * Cut gem: girdle line and two facets converging on the point.
   *
   * The first attempt was a tapered column with a lid line, which rendered as a
   * waste bin. A gem needs the girdle to read at all.
   */
  kibelisk: '<path d="M12 21 3 9l3-6h12l3 6z"/><path d="M3 9h18"/><path d="M8.5 9 12 21l3.5-12"/>',

  /** Rising air. */
  updraft:
    '<path d="M3 8h7a2.5 2.5 0 1 0-2.5-2.5"/><path d="M3 13h11a3 3 0 1 1-3 3"/><path d="M3 18h6a2.5 2.5 0 1 0-2.5 2.5"/>',

  // --- Collectibles --------------------------------------------------------

  /**
   * A mote of aether.
   *
   * This was a feather, which at marker size was a leaf -- and Gathering is
   * already a leaf. Two categories that differ only by hue is the exact failure
   * these icons exist to prevent, so it became a four-point star instead: no
   * other glyph here has concave sides.
   */
  "empyrean-trace":
    '<path d="M12 2c.4 5.4 4.2 9.2 9.6 9.6-5.4.4-9.2 4.2-9.6 9.6-.4-5.4-4.2-9.2-9.6-9.6C7.8 11.2 11.6 7.4 12 2z"/>',

  /** Isometric box. */
  "hidden-cube": '<path d="M12 2.2 3.5 7v10l8.5 4.8 8.5-4.8V7z"/><path d="M3.5 7 12 12l8.5-5"/><path d="M12 12v9.8"/>',

  // --- Gathering -----------------------------------------------------------

  /** Stem with two opposed leaves. */
  gathering:
    '<path d="M12 21V9.5"/><path d="M12 13.5c0-4 3-7 7.5-7 0 4-3 7-7.5 7z"/><path d="M12 17.5c0-3-2.5-5.5-6-5.5 0 3 2.5 5.5 6 5.5z"/>',

  // --- Creatures -----------------------------------------------------------

  /** A crown reads as "named" instantly, where a skull needs detail to. */
  boss: '<path d="M3.5 18.5 2.5 6l5.5 4.5L12 3l4 7.5L21.5 6l-1 12.5z"/><path d="M3.5 21.5h17"/>',

  /** Rank chevrons. */
  elite: '<path d="m5 20 7-7 7 7"/><path d="m5 13 7-7 7 7"/>',

  /** Head and shoulders. */
  npc: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c0-4.2 3.4-6.5 7.5-6.5s7.5 2.3 7.5 6.5"/>',
};

/** Falls back to a plain dot so an unknown category still renders. */
export function markerIcon(categoryId: string): string {
  return MARKER_ICONS[categoryId] ?? '<circle cx="12" cy="12" r="6"/>';
}

export const ICON_SVG_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round"';

/** A complete `<svg>` string, for the overlay's plain-DOM rendering. */
export function markerIconSvg(categoryId: string, className = ""): string {
  const cls = className ? ` class="${className}"` : "";
  return `<svg${cls} ${ICON_SVG_ATTRS}>${markerIcon(categoryId)}</svg>`;
}
