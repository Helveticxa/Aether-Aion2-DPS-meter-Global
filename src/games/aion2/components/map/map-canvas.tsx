import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { MapBorder, MapMarker, MapZone, MarkerCategory } from "@/games/aion2/lib/map-data";
import { shapeIcon } from "@/games/aion2/lib/map-icons";
import {
  constrainView,
  fitView,
  normalise,
  zoomAt,
  type View,
} from "@/games/aion2/lib/map-projection";
import {
  BASE_SHARP_UNTIL,
  TILED_SHARP_UNTIL,
  TILE_FADE_IN_AT,
} from "@/games/aion2/lib/map-tiles";

/** The coordinate space the border paths are built in, via the SVG viewBox. */
const PLANE = 1000;

const ZOOM_STEP = 1.18;

export type MapCanvasProps = {
  zone: MapZone;
  /** Renders the high-resolution tile layer when the set is complete. */
  tileUrl?: ((col: number, row: number) => string) | null;
  markers: MapMarker[];
  borders: MapBorder[];
  categories: Map<string, MarkerCategory>;
  collected: Set<string>;
  onToggleCollected: (id: string) => void;
  showBorders?: boolean;
  compact?: boolean;
};

/**
 * Pan and zoom by transforming one plane, not by moving each marker.
 *
 * The first version recomputed every marker's screen position on every
 * pointermove. With a couple of dozen sample markers that was invisible; with
 * Verteron's 1,954 it would be a re-render per mouse event, and the map would
 * stutter exactly when someone is dragging across it.
 *
 * Markers sit at percentage positions inside the plane, so a pan is one
 * translate and costs nothing per marker.
 *
 * The plane is sized in real pixels rather than scaled from a fixed box, which
 * matters more than it sounds. A scaled, promoted layer is rasterised at its
 * *unscaled* size: a 1000px plane shown at 10x resampled the 4096px image, the
 * tiles and every glyph from a 1000px raster -- blurry, and a ~9500px layer to
 * composite, which is what made scrolling crawl. Real pixels cost a reflow per
 * zoom step instead, which is discrete and rare.
 */
export function MapCanvas({
  zone,
  markers,
  borders,
  categories,
  collected,
  onToggleCollected,
  showBorders = true,
  compact = false,
  tileUrl = null,
}: MapCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View | null>(null);
  const [hovered, setHovered] = useState<MapMarker | null>(null);
  const dragRef = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Measure once, directly. ResizeObserver delivery is tied to the rendering
    // lifecycle, so a window that is occluded, minimised or otherwise not
    // painting may not get a callback for a long time -- and if first paint
    // depends only on the observer, the map is simply blank until it does.
    const rect = host.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setSize({ width: rect.width, height: rect.height });
    }

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((current) => {
        // Minimising reports 0x0. Keeping the last good viewport is what lets
        // the view survive it -- but only once there *is* one: the observer's
        // first callback can also be 0x0, before layout, and discarding that
        // outright leaves the map with no size and nothing ever rendered.
        if (width <= 0 || height <= 0) return current;
        if (current.width === width && current.height === height) return current;
        return { width, height };
      });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const padding = compact ? 2 : 12;

  const reset = useCallback(() => {
    if (size.width > 0 && size.height > 0) {
      setView(fitView(size.width, size.height, padding));
    }
  }, [padding, size.height, size.width]);

  /**
   * Fit once per zone, and never again.
   *
   * This used to depend on `reset`, which depends on the viewport size -- so
   * every resize refit the map. Minimising and restoring the window is two
   * resizes, which is why a zoomed-in map came back at 1x as though it had
   * reloaded.
   */
  const fittedZone = useRef<string | null>(null);
  useEffect(() => {
    if (size.width <= 0 || size.height <= 0) return;
    if (fittedZone.current === zone.id) return;
    fittedZone.current = zone.id;
    setView(fitView(size.width, size.height, padding));
  }, [padding, size.height, size.width, zone.id]);

  /** A resize keeps the view; it only stops it drifting off screen. */
  useEffect(() => {
    if (size.width <= 0 || size.height <= 0) return;
    setView((current) => (current ? constrainView(current, size.width, size.height) : current));
  }, [size.height, size.width]);

  const fitted = size.width > 0 ? fitView(size.width, size.height, padding).scale : 1;

  // The zoom ceiling tracks the sharpness actually available rather than a
  // fixed number: letting someone zoom to 32x on a 4096px image only shows
  // them mush, and capping at 12x with tiles installed throws away detail
  // they have already downloaded.
  const maxZoom = tileUrl ? TILED_SHARP_UNTIL * 2 : BASE_SHARP_UNTIL * 1.5;
  const limits = { min: fitted * 0.9, max: fitted * maxZoom };

  const handleWheel = (event: React.WheelEvent) => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return;
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;

    // Built from the latest view rather than the one this render closed over.
    // Wheel events can arrive faster than React re-renders, and reading the
    // stale value made a burst of them collapse into a single step.
    setView((current) => {
      if (!current) return current;
      const next = zoomAt(current, anchorX, anchorY, factor, limits);
      return constrainView(next, size.width, size.height);
    });
  };

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!view) return;
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, view, moved: false };
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    setView(
      constrainView(
        { scale: drag.view.scale, x: drag.view.x + dx, y: drag.view.y + dy },
        size.width,
        size.height
      )
    );
  };

  const endDrag = (event: React.PointerEvent) => {
    (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
    // Cleared on the next tick so a click that ended a drag can still see it.
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.moved) {
      const host = hostRef.current;
      host?.setAttribute("data-dragged", "1");
      window.setTimeout(() => host?.removeAttribute("data-dragged"), 0);
    }
  };

  /** Positions depend only on the zone, so they survive every pan and zoom. */
  const placed = useMemo(
    () =>
      markers.map((marker) => {
        const { u, v } = normalise(zone.bounds, marker.x, marker.y);
        return { marker, u, v, left: `${u * 100}%`, top: `${v * 100}%` };
      }),
    [markers, zone.bounds]
  );

  const borderPaths = useMemo(
    () =>
      borders.map((border) => ({
        id: border.id,
        d: border.points
          .map(([x, y], index) => {
            const { u, v } = normalise(zone.bounds, x, y);
            return `${index === 0 ? "M" : "L"}${(u * PLANE).toFixed(1)} ${(v * PLANE).toFixed(1)}`;
          })
          .join(" "),
      })),
    [borders, zone.bounds]
  );

  const zoomRatio = view ? view.scale / fitted : 1;

  // Markers shrink as the map zooms out. Holding them at a constant screen size
  // turns a zone with two thousand of them into a single blob at fit; letting
  // them grow into full glyphs only as you zoom in keeps the overview readable
  // and the detail available.
  //
  // The plane is now sized in real pixels, so these are screen pixels directly
  // -- no counter-scale to undo a transform.
  const maxDot = compact ? 15 : 22;
  const markerSize = Math.min(maxDot, Math.max(maxDot * 0.45, maxDot * 0.45 * zoomRatio));
  const glyphSize = Math.round(markerSize * 0.95);

  /** Once tiles cover the zone, the 4096px base underneath is dead weight. */
  const tilesCover = Boolean(tileUrl) && zoomRatio >= TILE_FADE_IN_AT;

  /**
   * Markers outside the viewport, dropped once zoomed in.
   *
   * At fit everything is on screen and culling would only cost work, so this
   * starts at 1.5x. Past that most of a zone is off screen, and keeping those
   * elements mounted means the browser lays out, paints and composites content
   * nobody can see -- which is felt as sluggishness in everything sharing the
   * window, not just the map.
   *
   * The margin is a full viewport on each side, so an ordinary pan moves
   * through already-mounted markers instead of reconciling the list every
   * frame.
   */
  const visible = useMemo(() => {
    if (!view || zoomRatio < 1.5) return placed;

    const marginX = size.width;
    const marginY = size.height;
    const u0 = (-marginX - view.x) / view.scale;
    const v0 = (-marginY - view.y) / view.scale;
    const u1 = (size.width + marginX - view.x) / view.scale;
    const v1 = (size.height + marginY - view.y) / view.scale;

    return placed.filter((p) => p.u >= u0 && p.u <= u1 && p.v >= v0 && p.v <= v1);
  }, [placed, size.height, size.width, view, zoomRatio]);

  /** Border strokes are in viewBox units, so they undo the viewBox scale. */
  const borderStroke = view ? (PLANE / view.scale) * 1.1 : 1;

  /**
   * Which tiles intersect the viewport.
   *
   * A zone is up to 64 tiles; rendering all of them would have the browser
   * decode sixty-odd megabytes of image for a view that shows four. Padding by
   * one tile means a pan reveals a loaded neighbour rather than an empty
   * square.
   */
  const visibleTiles = useMemo(() => {
    const grid = zone.tileGrid;
    if (!tileUrl || !view || !grid || zoomRatio < TILE_FADE_IN_AT) return [];

    const pad = 1 / grid;
    const u0 = (0 - view.x) / view.scale - pad;
    const v0 = (0 - view.y) / view.scale - pad;
    const u1 = (size.width - view.x) / view.scale + pad;
    const v1 = (size.height - view.y) / view.scale + pad;

    const out: Array<{ col: number; row: number }> = [];
    for (let row = 0; row < grid; row += 1) {
      for (let col = 0; col < grid; col += 1) {
        const left = col / grid;
        const top = row / grid;
        if (left + pad < u0 || left > u1 || top + pad < v0 || top > v1) continue;
        out.push({ col, row });
      }
    }
    return out;
  }, [size.height, size.width, tileUrl, view, zone.tileGrid, zoomRatio]);

  return (
    <div
      ref={hostRef}
      className="group relative h-full w-full cursor-grab overflow-hidden rounded-xl bg-[#0b1020] active:cursor-grabbing"
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {view && (
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            width: view.scale,
            height: view.scale,
            transform: `translate(${view.x}px, ${view.y}px)`,
          }}
        >
          {zone.image && !tilesCover ? (
            <img
              src={zone.image}
              alt={zone.name}
              className="pointer-events-none absolute inset-0 h-full w-full object-fill select-none"
              draggable={false}
            />
          ) : tilesCover ? null : (
            <div className="absolute inset-0 bg-[#0e1526]" />
          )}

          {/* High-resolution layer, drawn over the base rather than replacing
              it: if a tile is slow or missing, the base still shows through
              instead of leaving a hole. */}
          {tileUrl &&
            visibleTiles.map(({ col, row }) => (
              <img
                key={`${col}-${row}`}
                src={tileUrl(col, row)}
                alt=""
                loading="lazy"
                draggable={false}
                className="pointer-events-none absolute select-none"
                style={{
                  left: `${(col / zone.tileGrid) * 100}%`,
                  top: `${(row / zone.tileGrid) * 100}%`,
                  width: `${100 / zone.tileGrid}%`,
                  height: `${100 / zone.tileGrid}%`,
                }}
              />
            ))}

          {showBorders && borderPaths.length > 0 && (
            <svg
              viewBox={`0 0 ${PLANE} ${PLANE}`}
              className="pointer-events-none absolute inset-0 h-full w-full"
              aria-hidden
            >
              {borderPaths.map((border) => (
                <path
                  key={border.id}
                  d={border.d}
                  fill="none"
                  stroke="rgba(255,255,255,0.34)"
                  strokeWidth={borderStroke}
                  strokeDasharray={`${borderStroke * 5} ${borderStroke * 4}`}
                />
              ))}
            </svg>
          )}

          {visible.map(({ marker, left, top }) => {
            const category = categories.get(marker.category);
            const isCollected = collected.has(marker.id);
            // Found markers go neutral rather than merely fading: the map
            // should read as what is left, and a dimmed version of the same
            // colour still competes for attention.
            const tint = isCollected ? "#7c8798" : (category?.color ?? "#9aa4b2");

            return (
              <button
                key={marker.id}
                type="button"
                className="absolute flex items-center justify-center hover:z-10"
                style={{
                  left,
                  top,
                  width: markerSize,
                  height: markerSize,
                  marginLeft: -markerSize / 2,
                  marginTop: -markerSize / 2,
                  color: tint,
                  // No disc behind the glyph. The disc was carrying legibility
                  // over a busy map, so a dark outline takes that job instead --
                  // it follows the glyph rather than boxing it in.
                  filter: "drop-shadow(0 0 1.2px rgba(0,0,0,0.95)) drop-shadow(0 1px 1.5px rgba(0,0,0,0.7))",
                  opacity: isCollected ? 0.45 : 1,
                }}
                title={marker.name}
                onPointerEnter={() => setHovered(marker)}
                onPointerLeave={() => setHovered((current) => (current === marker ? null : current))}
                onClick={(event) => {
                  event.stopPropagation();
                  // A click that ended a pan should not also toggle a marker.
                  if (hostRef.current?.hasAttribute("data-dragged")) return;
                  onToggleCollected(marker.id);
                }}
              >
                <MarkerGlyph shape={category?.shape} size={glyphSize} />
              </button>
            );
          })}
        </div>
      )}

      {!compact && (
        <>
          <div className="pointer-events-none absolute top-3 left-3 max-w-[70%] truncate rounded-lg bg-black/75 px-2.5 py-1.5 text-xs text-white/70">
            {hovered ? (
              <span>
                <span className="text-white">{hovered.name}</span>
                <span className="text-white/40">
                  {" · "}
                  {categories.get(hovered.category)?.label ?? hovered.category}
                </span>
              </span>
            ) : (
              <span>Drag to pan · scroll to zoom · click a marker to mark it found</span>
            )}
          </div>

          <div className="absolute right-3 bottom-3 flex items-center gap-1.5">
            <span className="rounded-lg bg-black/75 px-2 py-1 text-[11px] text-white/45">
              {markers.length.toLocaleString()} shown · {view ? (view.scale / fitted).toFixed(1) : "1.0"}×
            </span>
            <button
              type="button"
              className="rounded-lg bg-black/75 px-2.5 py-1 text-[11px] text-white/70 transition hover:bg-black/90 hover:text-white"
              onClick={reset}
            >
              Reset view
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Markup comes from `map-icons`, which is authored source rather than data, so
 * setting it as HTML is safe. Doing it here keeps that judgement in one place.
 */
export function MarkerGlyph({ shape, size = 12 }: { shape?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: shapeIcon(shape) }}
    />
  );
}
