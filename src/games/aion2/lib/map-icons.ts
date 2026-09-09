/**
 * A glyph per marker *shape*, not per category.
 *
 * The dataset carries 25 categories but only twelve kinds of thing: eleven of
 * the materials are herbs, and inventing eleven distinguishable herb glyphs
 * would produce eleven glyphs nobody can tell apart -- failing the very test
 * these icons exist to pass. So shape says what kind of thing it is, and colour
 * says which one, with the palette arranged so that same-shaped categories land
 * far apart on the hue wheel. No two categories render alike.
 *
 * Drawn here rather than taken. The reference site serves the game client's own
 * marker textures under `UI/Resource/Texture/Icon/UT_Marker_*`; these follow
 * lucide's conventions -- 24x24, 2px stroke, round caps -- because lucide is
 * what the rest of the app uses.
 *
 * Values are inner SVG markup, authored in this file and never from input, so
 * injecting them as HTML is safe.
 */

export const SHAPE_ICONS: Record<string, string> = {
  /** Teleport ring. Concentric, so it reads as a portal rather than a dot. */
  ring: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/>',

  /** Seal: rhombus with an inner mark. */
  diamond: '<path d="M12 2.5 21.5 12 12 21.5 2.5 12z"/><path d="M12 8.5 15.5 12 12 15.5 8.5 12z"/>',

  /** Isometric box. */
  cube: '<path d="M12 2.2 3.5 7v10l8.5 4.8 8.5-4.8V7z"/><path d="M3.5 7 12 12l8.5-5"/><path d="M12 12v9.8"/>',

  /**
   * A mote of aether, for monolith material.
   *
   * This was a feather, which at marker size is a leaf -- and leaf is already
   * taken by every herb in the set. Nothing else here has concave sides.
   */
  feather:
    '<path d="M12 2c.4 5.4 4.2 9.2 9.6 9.6-5.4.4-9.2 4.2-9.6 9.6-.4-5.4-4.2-9.2-9.6-9.6C7.8 11.2 11.6 7.4 12 2z"/>',

  /** Stem with two opposed leaves. */
  leaf: '<path d="M12 21V9.5"/><path d="M12 13.5c0-4 3-7 7.5-7 0 4-3 7-7.5 7z"/><path d="M12 17.5c0-3-2.5-5.5-6-5.5 0 3 2.5 5.5 6 5.5z"/>',

  /** Ore: angular chunks, deliberately irregular against the gem's symmetry. */
  ore: '<path d="M3 13.5 8 5.5l5.5 2.5L11 15z"/><path d="M11 15l2.5-7 6.5 3-2 7z"/><path d="M3 13.5 11 15l-1.5 4.5L5 18z"/>',

  /** Cut gem: girdle line and facets converging on the point. */
  gem: '<path d="M12 21 3 9l3-6h12l3 6z"/><path d="M3 9h18"/><path d="M8.5 9 12 21l3.5-12"/>',

  /** Timber seen end-on, with growth rings. */
  log: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><ellipse cx="7.5" cy="12" rx="2.6" ry="4.6"/><path d="M7.5 12h.01"/>',

  /** Pennant on a pole. */
  flag: '<path d="M6 22V3"/><path d="M6 4h13l-3 4 3 4H6"/>',

  /** Two rooftops of unequal height. */
  house: '<path d="M2 21v-6.5L6 11l4 3.5V21"/><path d="M11 21v-9l5.5-4L22 12v9"/><path d="M1 21h22"/>',

  /** Head and shoulders. */
  person: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c0-4.2 3.4-6.5 7.5-6.5s7.5 2.3 7.5 6.5"/>',

  /** Fallback. */
  circle: '<circle cx="12" cy="12" r="6.5"/>',
};

export function shapeIcon(shape: string | undefined): string {
  return SHAPE_ICONS[shape ?? "circle"] ?? SHAPE_ICONS.circle;
}

export const ICON_SVG_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round"';

/** A complete `<svg>` string, for the overlay's plain-DOM rendering. */
export function shapeIconSvg(shape: string | undefined, size = 11): string {
  return `<svg width="${size}" height="${size}" ${ICON_SVG_ATTRS}>${shapeIcon(shape)}</svg>`;
}
