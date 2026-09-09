import type { WorldBounds } from "@/games/aion2/lib/map-data";

/**
 * World coordinates to screen pixels, and back.
 *
 * Two steps, kept separate on purpose:
 *
 *   world  ->  normalised (0..1 inside the zone's bounds)  ->  screen
 *
 * The first step depends only on the zone, the second only on how the user has
 * panned and zoomed. So the full map and the overlay minimap share the zone
 * half and differ only in the view half -- which is why this is a module and
 * not two copies of the same arithmetic.
 *
 * Y is flipped in the first step: world Y grows north, screen Y grows down.
 */

export type Normalised = { u: number; v: number };
export type Screen = { x: number; y: number };

/** How the normalised square is placed on screen. */
export type View = {
  /** Pixels across the full normalised square. */
  scale: number;
  /** Screen position of the square's top-left corner. */
  x: number;
  y: number;
};

export const IDENTITY_VIEW: View = { scale: 1, x: 0, y: 0 };

export function normalise(bounds: WorldBounds, x: number, y: number): Normalised {
  const width = bounds.maxX - bounds.minX || 1;
  const height = bounds.maxY - bounds.minY || 1;
  return {
    u: (x - bounds.minX) / width,
    v: 1 - (y - bounds.minY) / height,
  };
}

export function denormalise(bounds: WorldBounds, u: number, v: number) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  return {
    x: bounds.minX + u * width,
    y: bounds.minY + (1 - v) * height,
  };
}

export function toScreen(view: View, point: Normalised): Screen {
  return { x: view.x + point.u * view.scale, y: view.y + point.v * view.scale };
}

export function fromScreen(view: View, x: number, y: number): Normalised {
  return { u: (x - view.x) / view.scale, v: (y - view.y) / view.scale };
}

/** The view that fits the whole square inside a viewport, centred. */
export function fitView(viewportWidth: number, viewportHeight: number, padding = 0): View {
  const scale = Math.max(1, Math.min(viewportWidth, viewportHeight) - padding * 2);
  return {
    scale,
    x: (viewportWidth - scale) / 2,
    y: (viewportHeight - scale) / 2,
  };
}

/**
 * Zoom about a fixed screen point, so the spot under the cursor stays put.
 * Without the anchor correction, zooming drifts towards the top-left and the
 * map feels broken even though the maths is "right".
 */
export function zoomAt(view: View, anchorX: number, anchorY: number, factor: number, limits: { min: number; max: number }): View {
  const scale = clamp(view.scale * factor, limits.min, limits.max);
  const applied = scale / view.scale;
  return {
    scale,
    x: anchorX - (anchorX - view.x) * applied,
    y: anchorY - (anchorY - view.y) * applied,
  };
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Keep at least a sliver of the map on screen.
 *
 * Hard-clamping to the viewport edges fights the user at high zoom; letting the
 * map go entirely off-screen loses it with no way back. Allowing it to leave
 * all but a margin does neither.
 */
export function constrainView(view: View, viewportWidth: number, viewportHeight: number, margin = 80): View {
  return {
    scale: view.scale,
    x: clamp(view.x, margin - view.scale, viewportWidth - margin),
    y: clamp(view.y, margin - view.scale, viewportHeight - margin),
  };
}
