import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

import type { MapZone } from "@/games/aion2/lib/map-data";

export type TileStatus = {
  zoneCode: string;
  expected: number;
  present: number;
  bytes: number;
};

type TileProgress = {
  zoneCode: string;
  done: number;
  total: number;
  failed: number;
};

/**
 * Where the base image stops being sharp.
 *
 * The bundled JPEG is 4096px against a world up to 8192 units, so it runs out
 * of detail around 8x. Tiles are 1024px each on a grid that reconstructs the
 * full 8192px -- twice the linear resolution, and the most the source has.
 */
export const BASE_SHARP_UNTIL = 8;
export const TILED_SHARP_UNTIL = 16;

/** Start swapping tiles in a little before the base actually softens. */
export const TILE_FADE_IN_AT = 3;

/**
 * Status plus tile directory, or null when neither can be read.
 *
 * A plain function rather than only a hook: the overlay minimap is vanilla JS
 * and cannot call one, and both viewers must agree on what "has tiles" means.
 */
export async function fetchTiles(
  code: string,
  grid: number
): Promise<{ status: TileStatus; dir: string } | null> {
  try {
    const [status, dir] = await Promise.all([
      invoke<TileStatus>("map_tiles_status", { zoneCode: code, grid }),
      invoke<string>("map_tiles_dir", { zoneCode: code }),
    ]);
    return { status, dir };
  } catch {
    return null;
  }
}

/** A complete set only; a half-tiled map reads as a rendering bug. */
export function tilesComplete(status: TileStatus | null): boolean {
  return Boolean(status && status.expected > 0 && status.present === status.expected);
}

export function tileUrlBuilder(dir: string, code: string) {
  return (col: number, row: number) => {
    const name = `${code}_${String(col).padStart(2, "0")}_${String(row).padStart(2, "0")}.webp`;
    return convertFileSrc(`${dir}\\${name}`);
  };
}

export type MapTiles = {
  status: TileStatus | null;
  /** Complete enough to render. */
  ready: boolean;
  downloading: boolean;
  progress: TileProgress | null;
  download: () => Promise<void>;
  remove: () => Promise<void>;
  /** Builds the asset URL for one tile, or null before the directory is known. */
  urlFor: ((col: number, row: number) => string) | null;
};

/**
 * Manages one zone's high-resolution tiles.
 *
 * They are optional and per-zone on purpose: all eight zones would be about
 * 52 MB, against an installer that is 30 MB today. A zone someone actually
 * uses is worth fetching once; the rest are not worth shipping to everyone.
 */
export function useMapTiles(zone: MapZone | null): MapTiles {
  const [status, setStatus] = useState<TileStatus | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<TileProgress | null>(null);

  const code = zone?.code ?? null;
  const grid = zone?.tileGrid ?? 0;

  const refresh = useCallback(async () => {
    if (!code || !grid) return;
    // Outside Tauri, or unreadable: the base image stands on its own.
    const result = await fetchTiles(code, grid);
    setStatus(result?.status ?? null);
    setDir(result?.dir ?? null);
  }, [code, grid]);

  useEffect(() => {
    setStatus(null);
    setProgress(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unlisten = listen<TileProgress>("map-tiles-progress", (event) => {
      if (event.payload.zoneCode === code) setProgress(event.payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [code]);

  const download = useCallback(async () => {
    if (!code || !grid) return;
    setDownloading(true);
    setProgress({ zoneCode: code, done: 0, total: grid * grid, failed: 0 });
    try {
      const next = await invoke<TileStatus>("download_map_tiles", { zoneCode: code, grid });
      setStatus(next);
    } finally {
      setDownloading(false);
      await refresh();
    }
  }, [code, grid, refresh]);

  const remove = useCallback(async () => {
    if (!code) return;
    await invoke("delete_map_tiles", { zoneCode: code });
    setProgress(null);
    await refresh();
  }, [code, refresh]);

  const urlFor = useCallback(
    (col: number, row: number) => tileUrlBuilder(dir ?? "", code ?? "")(col, row),
    [code, dir]
  );

  return {
    status,
    // Partial sets are not rendered: a half-tiled map looks like a rendering
    // bug rather than a download in progress.
    ready: Boolean(dir) && tilesComplete(status),
    downloading,
    progress,
    download,
    remove,
    urlFor: dir ? urlFor : null,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}
