import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Eye,
  EyeOff,
  HardDriveDownload,
  Loader2,
  Map as MapIcon,
  PictureInPicture2,
  Search,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { MapCanvas, MarkerGlyph } from "@/games/aion2/components/map/map-canvas";
import {
  countByCategory,
  groupCategories,
  type MapDataset,
  type MarkerCategory,
} from "@/games/aion2/lib/map-data";
import {
  loadCollected,
  loadHidden,
  loadMapDataset,
  saveCollected,
  saveHidden,
} from "@/games/aion2/lib/map-dataset";
import { formatBytes, useMapTiles } from "@/games/aion2/lib/map-tiles";
import { cn } from "@/lib/utils";

const WORLD_LABELS: Record<string, string> = {
  elyos: "Elyos",
  asmodian: "Asmodian",
  abyss: "Abyss",
};

/**
 * NPCs are a third of every marker in the game and are almost never what
 * someone opens a map to find, so they start hidden. The choice is remembered
 * after that.
 */
const HIDDEN_BY_DEFAULT = ["npc"];

export default function InteractiveMapPage() {
  const [dataset, setDataset] = useState<MapDataset | null>(null);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => loadHidden(HIDDEN_BY_DEFAULT));
  const [collected, setCollected] = useState<Set<string>>(() => loadCollected());
  const [query, setQuery] = useState("");
  const [showFound, setShowFound] = useState(true);
  const [showBorders, setShowBorders] = useState(true);
  const [openingOverlay, setOpeningOverlay] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadMapDataset().then((next) => {
      if (!alive) return;
      setDataset(next);
      // Land on the first zone that actually has markers.
      setZoneId(
        (current) =>
          current ??
          next.zones.find((z) => next.markers.some((m) => m.zone === z.id))?.id ??
          next.zones[0]?.id ??
          null
      );
    });
    return () => {
      alive = false;
    };
  }, []);

  const zone = dataset?.zones.find((z) => z.id === zoneId) ?? dataset?.zones[0] ?? null;
  const tiles = useMapTiles(zone);

  const categoryIndex = useMemo(() => {
    const index = new Map<string, MarkerCategory>();
    for (const category of dataset?.categories ?? []) index.set(category.id, category);
    return index;
  }, [dataset]);

  const zoneMarkers = useMemo(
    () => (zone ? (dataset?.markers.filter((m) => m.zone === zone.id) ?? []) : []),
    [dataset, zone]
  );

  const zoneBorders = useMemo(
    () => (zone ? (dataset?.borders.filter((b) => b.zone === zone.id) ?? []) : []),
    [dataset, zone]
  );

  const counts = useMemo(() => countByCategory(zoneMarkers), [zoneMarkers]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return zoneMarkers.filter((marker) => {
      if (hidden.has(marker.category)) return false;
      if (!showFound && collected.has(marker.id)) return false;
      if (needle && !marker.name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [collected, hidden, query, showFound, zoneMarkers]);

  const groups = useMemo(() => groupCategories(dataset?.categories ?? []), [dataset]);

  const updateHidden = (next: Set<string>) => {
    setHidden(next);
    saveHidden(next);
  };

  const toggleCategory = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    updateHidden(next);
  };

  const toggleGroup = (categories: MarkerCategory[]) => {
    const ids = categories.map((c) => c.id);
    const allHidden = ids.every((id) => hidden.has(id));
    const next = new Set(hidden);
    for (const id of ids) {
      if (allHidden) next.delete(id);
      else next.add(id);
    }
    updateHidden(next);
  };

  const toggleCollected = (id: string) => {
    setCollected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveCollected(next);
      return next;
    });
  };

  const foundHere = zoneMarkers.filter((m) => collected.has(m.id)).length;

  const openOverlay = async () => {
    if (!zone) return;
    setOpeningOverlay(true);
    try {
      await invoke("create_map_overlay", { zoneId: zone.id });
    } catch (error) {
      toast.error("Could not open the map overlay", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOpeningOverlay(false);
    }
  };

  if (!dataset || !zone) {
    return (
      <div className="flex h-full w-full items-center justify-center text-white/50">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading map data
      </div>
    );
  }

  const zonesByWorld = new Map<string, typeof dataset.zones>();
  for (const z of dataset.zones) {
    const list = zonesByWorld.get(z.world);
    if (list) list.push(z);
    else zonesByWorld.set(z.world, [z]);
  }

  return (
    <div className="flex h-full w-full gap-4 overflow-hidden p-4 text-white">
      <aside className="flex w-[288px] shrink-0 flex-col gap-2.5 overflow-hidden">
        <header className="flex items-center gap-2">
          <MapIcon className="size-4 text-cyan-300" />
          <h1 className="text-sm font-semibold tracking-wide">Interactive map</h1>
        </header>

        <section className="flex flex-col gap-1.5">
          {[...zonesByWorld.entries()].map(([world, zones]) => (
            <div key={world}>
              <p className="mb-1 text-[10px] font-semibold tracking-[0.18em] text-white/35 uppercase">
                {WORLD_LABELS[world] ?? world}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {zones.map((z) => {
                  const empty = !dataset.markers.some((m) => m.zone === z.id);
                  return (
                    <button
                      key={z.id}
                      type="button"
                      onClick={() => setZoneId(z.id)}
                      title={empty ? "No markers for this zone in the dataset" : undefined}
                      className={cn(
                        "rounded-lg px-2.5 py-1 text-xs font-medium transition",
                        z.id === zone.id
                          ? "bg-amber-200/85 text-neutral-900"
                          : empty
                            ? "bg-white/4 text-white/25 hover:bg-white/8"
                            : "bg-white/6 text-white/70 hover:bg-white/12 hover:text-white"
                      )}
                    >
                      {z.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </section>

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-white/35" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search markers in this zone"
            className="w-full rounded-lg border border-white/10 bg-white/5 py-1.5 pr-2.5 pl-8 text-xs text-white placeholder:text-white/35 focus:border-cyan-300/40 focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-3 text-[11px] text-white/55">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={showFound}
              onChange={(event) => setShowFound(event.target.checked)}
              className="size-3 accent-cyan-400"
            />
            Show found
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={showBorders}
              onChange={(event) => setShowBorders(event.target.checked)}
              className="size-3 accent-cyan-400"
            />
            Region borders
          </label>
        </div>

        <div className="flex items-center justify-between text-[11px] text-white/45">
          <span>
            {shown.length.toLocaleString()} of {zoneMarkers.length.toLocaleString()} shown
          </span>
          <span>{foundHere.toLocaleString()} found</span>
        </div>

        <section className="-mr-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
          {[...groups.entries()].map(([group, categories]) => {
            const inZone = categories.filter((category) => (counts.get(category.id) ?? 0) > 0);
            if (inZone.length === 0) return null;
            const allHidden = inZone.every((category) => hidden.has(category.id));

            return (
              <div key={group}>
                <button
                  type="button"
                  onClick={() => toggleGroup(inZone)}
                  className="mb-1 flex w-full items-center justify-between text-[10px] font-semibold tracking-[0.18em] text-white/35 uppercase transition hover:text-white/70"
                >
                  {group}
                  <span className="tracking-normal normal-case">
                    {allHidden ? "show all" : "hide all"}
                  </span>
                </button>

                <div className="flex flex-col gap-0.5">
                  {inZone.map((category) => {
                    const isHidden = hidden.has(category.id);
                    return (
                      <button
                        key={category.id}
                        type="button"
                        onClick={() => toggleCategory(category.id)}
                        className={cn(
                          "flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition hover:bg-white/6",
                          isHidden ? "text-white/30" : "text-white/80"
                        )}
                      >
                        <span
                          className="flex size-5 shrink-0 items-center justify-center"
                          style={{ color: isHidden ? "#4d5563" : category.color }}
                        >
                          <MarkerGlyph shape={category.shape} size={17} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-left">{category.label}</span>
                        <span className="text-white/35">{counts.get(category.id)}</span>
                        {isHidden ? (
                          <EyeOff className="size-3 text-white/25" />
                        ) : (
                          <Eye className="size-3 text-white/25" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </section>

        {/* High-resolution tiles are optional and per zone: all eight would be
            about 52 MB against a 30 MB installer, so they are fetched for the
            zones someone actually uses. */}
        <section className="shrink-0 rounded-lg border border-white/8 bg-white/[0.03] px-2.5 py-2">
          {tiles.ready ? (
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="flex items-center gap-1.5 text-cyan-200/80">
                <Sparkles className="size-3" />
                Full resolution ({formatBytes(tiles.status?.bytes ?? 0)})
              </span>
              <button
                type="button"
                className="text-white/35 underline decoration-white/15 underline-offset-2 transition hover:text-white/70"
                onClick={() => void tiles.remove()}
              >
                remove
              </button>
            </div>
          ) : tiles.downloading ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[11px] text-white/60">
                <span className="flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" />
                  Downloading tiles
                </span>
                <span className="text-white/35">
                  {tiles.progress?.done ?? 0} / {tiles.progress?.total ?? 0}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-cyan-300/80 transition-[width]"
                  style={{
                    width: `${Math.round(((tiles.progress?.done ?? 0) / Math.max(1, tiles.progress?.total ?? 1)) * 100)}%`,
                  }}
                />
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="flex w-full items-center gap-2 text-left text-[11px] text-white/60 transition hover:text-white"
              onClick={() => void tiles.download()}
            >
              <HardDriveDownload className="size-3.5 shrink-0 text-cyan-300/70" />
              <span className="min-w-0 flex-1">
                <span className="block">Download full-resolution map</span>
                <span className="block text-[10px] text-white/30">
                  {zone.tileGrid * zone.tileGrid} tiles · sharp to {Math.round(16)}× instead of 8×
                </span>
              </span>
            </button>
          )}
        </section>

        {/* The marker database is not ours. Saying so where the map is used,
            not only in the README. */}
        <footer className="shrink-0 border-t border-white/8 pt-2 text-[10px] leading-snug text-white/30">
          Marker data and maps from{" "}
          <button
            type="button"
            className="text-white/50 underline decoration-white/20 underline-offset-2 transition hover:text-cyan-200"
            onClick={() => void openUrl("https://aion2hub.com/maps")}
          >
            AION2 Hub
          </button>
        </footer>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{zone.name}</h2>
            <p className="text-xs text-white/40">
              {WORLD_LABELS[zone.world] ?? zone.world} · {zoneMarkers.length.toLocaleString()}{" "}
              markers · {zoneBorders.length} regions
            </p>
          </div>

          <button
            type="button"
            onClick={() => void openOverlay()}
            disabled={openingOverlay}
            className="flex h-9 shrink-0 items-center gap-2 rounded-lg bg-white/90 px-3 text-xs font-semibold text-neutral-900 transition hover:bg-white disabled:opacity-60"
          >
            {openingOverlay ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <PictureInPicture2 className="size-3.5" />
            )}
            Open minimap overlay
          </button>
        </div>

        <div className="min-h-0 flex-1">
          <MapCanvas
            zone={zone}
            tileUrl={tiles.ready ? tiles.urlFor : null}
            markers={shown}
            borders={zoneBorders}
            categories={categoryIndex}
            collected={collected}
            onToggleCollected={toggleCollected}
            showBorders={showBorders}
          />
        </div>
      </main>
    </div>
  );
}
