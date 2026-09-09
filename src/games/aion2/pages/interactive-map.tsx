import { invoke } from "@tauri-apps/api/core";
import { Eye, EyeOff, Loader2, Map as MapIcon, PictureInPicture2, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { MapCanvas } from "@/games/aion2/components/map/map-canvas";
import {
  countByCategory,
  groupCategories,
  type MapDataset,
  type MarkerCategory,
} from "@/games/aion2/lib/map-data";
import { loadCollected, loadMapDataset, saveCollected } from "@/games/aion2/lib/map-dataset";
import { cn } from "@/lib/utils";

const WORLD_LABELS: Record<string, string> = {
  elyos: "Elyos",
  asmodian: "Asmodian",
  abyss: "Abyss",
};

export default function InteractiveMapPage() {
  const [dataset, setDataset] = useState<MapDataset | null>(null);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [collected, setCollected] = useState<Set<string>>(() => loadCollected());
  const [query, setQuery] = useState("");
  const [openingOverlay, setOpeningOverlay] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadMapDataset().then((next) => {
      if (!alive) return;
      setDataset(next);
      setZoneId((current) => current ?? next.zones[0]?.id ?? null);
    });
    return () => {
      alive = false;
    };
  }, []);

  const zone = dataset?.zones.find((z) => z.id === zoneId) ?? dataset?.zones[0] ?? null;

  const categoryIndex = useMemo(() => {
    const index = new Map<string, MarkerCategory>();
    for (const category of dataset?.categories ?? []) index.set(category.id, category);
    return index;
  }, [dataset]);

  const zoneMarkers = useMemo(
    () => (zone ? (dataset?.markers.filter((m) => m.zone === zone.id) ?? []) : []),
    [dataset, zone]
  );

  const counts = useMemo(() => countByCategory(zoneMarkers), [zoneMarkers]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return zoneMarkers.filter((marker) => {
      if (hidden.has(marker.category)) return false;
      if (needle && !marker.name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [hidden, query, zoneMarkers]);

  const groups = useMemo(
    () => groupCategories(dataset?.categories ?? []),
    [dataset]
  );

  const toggleCollected = (id: string) => {
    setCollected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveCollected(next);
      return next;
    });
  };

  const toggleCategory = (id: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
      <aside className="flex w-[290px] shrink-0 flex-col gap-3 overflow-y-auto pr-1">
        <header className="flex items-center gap-2">
          <MapIcon className="size-4 text-cyan-300" />
          <h1 className="text-sm font-semibold tracking-wide">Interactive map</h1>
        </header>

        {dataset.sample && (
          <p className="rounded-lg border border-amber-300/25 bg-amber-300/[0.06] px-3 py-2 text-xs leading-relaxed text-amber-100/90">
            Showing <strong>sample markers</strong>. These coordinates were made up to exercise the
            interface — they are not surveyed positions. Real data arrives when the global client
            ships and can be extracted from it.
          </p>
        )}

        <section className="flex flex-col gap-2">
          {[...zonesByWorld.entries()].map(([world, zones]) => (
            <div key={world}>
              <p className="mb-1.5 text-[10px] font-semibold tracking-[0.18em] text-white/35 uppercase">
                {WORLD_LABELS[world] ?? world}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {zones.map((z) => (
                  <button
                    key={z.id}
                    type="button"
                    onClick={() => setZoneId(z.id)}
                    className={cn(
                      "rounded-lg px-2.5 py-1 text-xs font-medium transition",
                      z.id === zone.id
                        ? "bg-amber-200/85 text-neutral-900"
                        : "bg-white/6 text-white/70 hover:bg-white/12 hover:text-white"
                    )}
                  >
                    {z.name}
                  </button>
                ))}
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

        <div className="flex items-center justify-between text-[11px] text-white/45">
          <span>
            {shown.length.toLocaleString()} of {zoneMarkers.length.toLocaleString()} shown
          </span>
          <span>
            {foundHere.toLocaleString()} found
          </span>
        </div>

        <section className="flex flex-col gap-3">
          {[...groups.entries()].map(([group, categories]) => {
            const inZone = categories.filter((category) => (counts.get(category.id) ?? 0) > 0);
            if (inZone.length === 0) return null;

            return (
              <div key={group}>
                <p className="mb-1.5 text-[10px] font-semibold tracking-[0.18em] text-white/35 uppercase">
                  {group}
                </p>
                <div className="flex flex-col gap-0.5">
                  {inZone.map((category) => {
                    const isHidden = hidden.has(category.id);
                    return (
                      <button
                        key={category.id}
                        type="button"
                        onClick={() => toggleCategory(category.id)}
                        className={cn(
                          "flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition",
                          isHidden ? "text-white/30" : "text-white/80",
                          "hover:bg-white/6"
                        )}
                      >
                        <span
                          className="size-2.5 shrink-0 rounded-full border"
                          style={{
                            background: isHidden ? "transparent" : category.color,
                            borderColor: category.color,
                          }}
                        />
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
      </aside>

      <main className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{zone.name}</h2>
            <p className="text-xs text-white/40">
              {WORLD_LABELS[zone.world] ?? zone.world} ·{" "}
              {zone.image ? "map image loaded" : "no map image yet"}
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
            markers={shown}
            categories={categoryIndex}
            collected={collected}
            onToggleCollected={toggleCollected}
          />
        </div>
      </main>
    </div>
  );
}
