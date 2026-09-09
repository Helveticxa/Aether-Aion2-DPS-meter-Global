import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { MapMarker, MapZone, MarkerCategory } from "@/games/aion2/lib/map-data";
import {
  constrainView,
  fitView,
  fromScreen,
  normalise,
  toScreen,
  zoomAt,
  type View,
} from "@/games/aion2/lib/map-projection";

/**
 * Markers are DOM nodes, culled to what is on screen.
 *
 * A zone can hold thousands of them -- creature spawns alone run into four
 * figures -- and rendering every one as an element is what makes a map like
 * this crawl. Culling to the viewport keeps the node count proportional to
 * what is actually visible rather than to the dataset, and the cap below is
 * the backstop for a fully zoomed-out view of a dense zone.
 */
const MAX_RENDERED_MARKERS = 1200;

const ZOOM_STEP = 1.18;

export type MapCanvasProps = {
  zone: MapZone;
  markers: MapMarker[];
  categories: Map<string, MarkerCategory>;
  collected: Set<string>;
  onToggleCollected: (id: string) => void;
  /** Rendered smaller, without labels or the grid legend. */
  compact?: boolean;
};

export function MapCanvas({
  zone,
  markers,
  categories,
  collected,
  onToggleCollected,
  compact = false,
}: MapCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View | null>(null);
  const [hovered, setHovered] = useState<MapMarker | null>(null);
  const dragRef = useRef<{ x: number; y: number; view: View } | null>(null);

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

  const reset = useCallback(() => {
    if (size.width > 0 && size.height > 0) {
      setView(fitView(size.width, size.height, compact ? 4 : 24));
    }
  }, [compact, size.height, size.width]);

  // Refit when the viewport resizes or the zone changes, but never while the
  // user is mid-gesture.
  useEffect(() => {
    if (!dragRef.current) reset();
  }, [reset, zone.id]);

  const limits = view
    ? { min: fitView(size.width, size.height, compact ? 4 : 24).scale * 0.8, max: 20000 }
    : { min: 1, max: 20000 };

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
    (event.target as Element).setPointerCapture?.(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, view };
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next: View = {
      scale: drag.view.scale,
      x: drag.view.x + (event.clientX - drag.x),
      y: drag.view.y + (event.clientY - drag.y),
    };
    setView(constrainView(next, size.width, size.height));
  };

  const endDrag = (event: React.PointerEvent) => {
    (event.target as Element).releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
  };

  // Cull first, then cap. Slicing an unculled list would drop markers that are
  // on screen in favour of ones that are not.
  const visible: Array<{ marker: MapMarker; x: number; y: number }> = [];
  if (view) {
    const pad = 24;
    for (const marker of markers) {
      const point = toScreen(view, normalise(zone.bounds, marker.x, marker.y));
      if (
        point.x < -pad ||
        point.y < -pad ||
        point.x > size.width + pad ||
        point.y > size.height + pad
      ) {
        continue;
      }
      visible.push({ marker, x: point.x, y: point.y });
      if (visible.length >= MAX_RENDERED_MARKERS) break;
    }
  }

  const culled = view ? markers.length - visible.length : 0;
  const dotSize = compact ? 7 : 11;

  return (
    <div
      ref={hostRef}
      className="relative h-full w-full cursor-grab overflow-hidden rounded-xl bg-[#0b1020] active:cursor-grabbing"
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {view && (
        <>
          <div
            className="absolute origin-top-left"
            style={{
              width: view.scale,
              height: view.scale,
              transform: `translate(${view.x}px, ${view.y}px)`,
            }}
          >
            {zone.image ? (
              <img
                src={zone.image}
                alt={zone.name}
                className="pointer-events-none h-full w-full object-fill select-none"
                draggable={false}
              />
            ) : (
              <CalibrationGrid compact={compact} />
            )}
          </div>

          {visible.map(({ marker, x, y }) => {
            const category = categories.get(marker.category);
            const isCollected = collected.has(marker.id);
            return (
              <button
                key={marker.id}
                type="button"
                className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border transition-transform hover:scale-125"
                style={{
                  left: x,
                  top: y,
                  width: dotSize,
                  height: dotSize,
                  background: isCollected ? "transparent" : (category?.color ?? "#9aa4b2"),
                  borderColor: category?.color ?? "#9aa4b2",
                  opacity: isCollected ? 0.45 : 1,
                }}
                title={marker.name}
                onPointerEnter={() => setHovered(marker)}
                onPointerLeave={() => setHovered((current) => (current === marker ? null : current))}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleCollected(marker.id);
                }}
              />
            );
          })}
        </>
      )}

      {!compact && (
        <>
          <div className="pointer-events-none absolute top-3 left-3 rounded-lg bg-black/55 px-2.5 py-1.5 text-xs text-white/70 backdrop-blur-sm">
            {hovered ? (
              <span>
                <span className="text-white">{hovered.name}</span>
                <span className="text-white/40">
                  {" "}
                  · {categories.get(hovered.category)?.label ?? hovered.category} ·{" "}
                  {Math.round(hovered.x)}, {Math.round(hovered.y)}
                </span>
              </span>
            ) : (
              <span>Drag to pan · scroll to zoom · click a marker to mark it found</span>
            )}
          </div>

          <div className="absolute right-3 bottom-3 flex items-center gap-1.5">
            {culled > 0 && (
              <span className="rounded-lg bg-black/55 px-2 py-1 text-[11px] text-white/50 backdrop-blur-sm">
                {culled.toLocaleString()} off screen
              </span>
            )}
            <button
              type="button"
              className="rounded-lg bg-black/55 px-2.5 py-1 text-[11px] text-white/70 backdrop-blur-sm transition hover:bg-black/70 hover:text-white"
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
 * Stands in for a zone image that has not been added yet.
 *
 * Deliberately readable rather than decorative: the grid is the zone's world
 * bounds in tenths, so marker positions can be sanity-checked against known
 * coordinates before any image exists.
 */
function CalibrationGrid({ compact }: { compact: boolean }) {
  const lines = Array.from({ length: 11 }, (_, index) => index / 10);
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
      <rect width="100" height="100" fill="#0e1526" />
      {lines.map((t) => (
        <g key={t} stroke="#1e2b45" strokeWidth={t === 0 || t === 1 ? 0.5 : 0.2}>
          <line x1={t * 100} y1={0} x2={t * 100} y2={100} />
          <line x1={0} y1={t * 100} x2={100} y2={t * 100} />
        </g>
      ))}
      {!compact && (
        <text x="50" y="52" textAnchor="middle" fill="#31415f" fontSize="4">
          no map image for this zone yet
        </text>
      )}
    </svg>
  );
}

export { fromScreen };
