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

/**
 * The plane's intrinsic size. Any value works; it exists only so markers can be
 * positioned in percentages and never re-laid-out.
 */
const PLANE = 1000;

const ZOOM_STEP = 1.18;
/**
 * Past this the map image is being upscaled and turns to mush -- the sources are
 * 4096px, half the resolution of the largest zones. Markers stay crisp, being
 * vector, so the ceiling is set by the image rather than by the maths.
 */
const MAX_ZOOM = 12;

export type MapCanvasProps = {
  zone: MapZone;
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
 * Markers now sit at percentage positions inside a fixed-size plane, so their
 * layout never changes. A pan or a zoom writes one transform on the plane and
 * one CSS variable -- the browser composites it on the GPU, and the cost stops
 * depending on how many markers are on screen. `--inv` is the inverse scale,
 * which keeps the markers the same size on screen while the map grows under
 * them.
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
}: MapCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View | null>(null);
  const [hovered, setHovered] = useState<MapMarker | null>(null);
  const dragRef = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
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

  useEffect(() => {
    if (!dragRef.current) reset();
  }, [reset, zone.id]);

  const fitted = size.width > 0 ? fitView(size.width, size.height, padding).scale : 1;
  const limits = { min: fitted * 0.9, max: fitted * MAX_ZOOM };

  const handleWheel = (event: React.WheelEvent) => {
    if (!view) return;
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return;
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    const next = zoomAt(view, event.clientX - rect.left, event.clientY - rect.top, factor, limits);
    setView(constrainView(next, size.width, size.height));
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
        return { marker, left: `${u * 100}%`, top: `${v * 100}%` };
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

  const dotSize = compact ? 15 : 21;
  const glyphSize = compact ? 9 : 12;

  // Markers shrink as the map zooms out. Holding them at a constant screen size
  // turns a zone with two thousand of them into a single blob of overlapping
  // rings at fit; letting them grow into full glyphs only as you zoom in keeps
  // the overview readable and the detail available.
  const zoomRatio = view ? view.scale / fitted : 1;
  const markerSize = Math.min(dotSize, Math.max(dotSize * 0.5, dotSize * 0.5 * zoomRatio));
  const inverse = view ? ((markerSize / dotSize) * PLANE) / view.scale : 1;

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
          className="absolute top-0 left-0 origin-top-left will-change-transform"
          style={
            {
              width: PLANE,
              height: PLANE,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale / PLANE})`,
              "--inv": inverse,
            } as React.CSSProperties
          }
        >
          {zone.image ? (
            <img
              src={zone.image}
              alt={zone.name}
              className="pointer-events-none absolute inset-0 h-full w-full object-fill select-none"
              draggable={false}
            />
          ) : (
            <div className="absolute inset-0 bg-[#0e1526]" />
          )}

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
                  strokeWidth={inverse * 0.9}
                  strokeDasharray={`${inverse * 5} ${inverse * 4}`}
                />
              ))}
            </svg>
          )}

          {placed.map(({ marker, left, top }) => {
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
                className="absolute flex items-center justify-center rounded-full border-[1.5px] hover:z-10"
                style={{
                  left,
                  top,
                  width: dotSize,
                  height: dotSize,
                  marginLeft: -dotSize / 2,
                  marginTop: -dotSize / 2,
                  transform: "scale(var(--inv))",
                  color: tint,
                  borderColor: tint,
                  background: "rgba(8,12,22,0.85)",
                  opacity: isCollected ? 0.5 : 1,
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
          <div className="pointer-events-none absolute top-3 left-3 max-w-[70%] truncate rounded-lg bg-black/60 px-2.5 py-1.5 text-xs text-white/70 backdrop-blur-sm">
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
            <span className="rounded-lg bg-black/60 px-2 py-1 text-[11px] text-white/45 backdrop-blur-sm">
              {markers.length.toLocaleString()} shown · {view ? (view.scale / fitted).toFixed(1) : "1.0"}×
            </span>
            <button
              type="button"
              className="rounded-lg bg-black/60 px-2.5 py-1 text-[11px] text-white/70 backdrop-blur-sm transition hover:bg-black/80 hover:text-white"
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
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: shapeIcon(shape) }}
    />
  );
}
