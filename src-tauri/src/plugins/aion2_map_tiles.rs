//! High-resolution map tiles, fetched on demand.
//!
//! The bundled zone images are 4096px, which is sharp to roughly 8x and mush
//! after that. The source's own tiles are 1024px each on grids up to 8x8, so a
//! full zone is 8192px -- twice the linear resolution, and the most detail that
//! exists anywhere. Reaching it means fetching about 52 MB across all eight
//! zones, which is far too much to put in an installer that is 30 MB today.
//!
//! So tiles are optional and per-zone. The bundle keeps working offline at
//! 4096px; a zone the user actually cares about gets its tiles downloaded into
//! the app data directory once, and the viewer layers them over the base when
//! zoomed in far enough to tell the difference.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

const TILE_BASE: &str = "https://aion2hub.com/api/map-tile";

/// Fetched a few at a time rather than all at once: this is someone else's
/// server, and a zone is at most 64 files.
const CONCURRENCY: usize = 4;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TileStatus {
    pub zone_code: String,
    pub expected: usize,
    pub present: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TileProgress {
    pub zone_code: String,
    pub done: usize,
    pub total: usize,
    pub failed: usize,
}

fn tiles_dir<R: Runtime>(app: &AppHandle<R>, zone_code: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("no app data directory: {error}"))?;
    Ok(base.join("maps").join("tiles").join(zone_code))
}

/// Rejects anything that is not a plain zone code, so a caller cannot walk out
/// of the tiles directory or build a request to somewhere else.
fn valid_zone_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 64
        && code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[tauri::command]
pub fn map_tiles_status<R: Runtime>(
    app: AppHandle<R>,
    zone_code: String,
    grid: usize,
) -> Result<TileStatus, String> {
    if !valid_zone_code(&zone_code) {
        return Err("invalid zone code".to_string());
    }

    let dir = tiles_dir(&app, &zone_code)?;
    let expected = grid * grid;
    let mut present = 0;
    let mut bytes = 0u64;

    for row in 0..grid {
        for col in 0..grid {
            let path = dir.join(format!("{zone_code}_{col:02}_{row:02}.webp"));
            if let Ok(meta) = std::fs::metadata(&path) {
                // A zero-length file is a failed download, not a tile.
                if meta.len() > 0 {
                    present += 1;
                    bytes += meta.len();
                }
            }
        }
    }

    Ok(TileStatus {
        zone_code,
        expected,
        present,
        bytes,
    })
}

/// Download every missing tile for one zone.
///
/// Emits `map-tiles-progress` as it goes, and skips tiles already on disk so a
/// cancelled run resumes rather than starting over.
#[tauri::command]
pub async fn download_map_tiles<R: Runtime>(
    app: AppHandle<R>,
    zone_code: String,
    grid: usize,
) -> Result<TileStatus, String> {
    if !valid_zone_code(&zone_code) {
        return Err("invalid zone code".to_string());
    }
    if grid == 0 || grid > 16 {
        return Err("implausible tile grid".to_string());
    }

    let dir = tiles_dir(&app, &zone_code)?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;

    let mut wanted: Vec<(usize, usize)> = Vec::new();
    for row in 0..grid {
        for col in 0..grid {
            let path = dir.join(format!("{zone_code}_{col:02}_{row:02}.webp"));
            let have = std::fs::metadata(&path).map(|m| m.len() > 0).unwrap_or(false);
            if !have {
                wanted.push((col, row));
            }
        }
    }

    let total = grid * grid;
    let client = reqwest::Client::new();
    let mut done = total - wanted.len();
    let mut failed = 0usize;

    for chunk in wanted.chunks(CONCURRENCY) {
        let mut tasks = Vec::new();
        for &(col, row) in chunk {
            let name = format!("{zone_code}_{col:02}_{row:02}.webp");
            let url = format!("{TILE_BASE}/{zone_code}/{name}");
            let path = dir.join(&name);
            let client = client.clone();
            tasks.push(async move {
                let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
                if !response.status().is_success() {
                    return Err(format!("HTTP {}", response.status()));
                }
                let bytes = response.bytes().await.map_err(|e| e.to_string())?;
                if bytes.is_empty() {
                    return Err("empty response".to_string());
                }
                std::fs::write(&path, &bytes).map_err(|e| e.to_string())
            });
        }

        for result in futures_util::future::join_all(tasks).await {
            match result {
                Ok(()) => done += 1,
                Err(_) => failed += 1,
            }
        }

        let _ = app.emit(
            "map-tiles-progress",
            TileProgress {
                zone_code: zone_code.clone(),
                done,
                total,
                failed,
            },
        );
    }

    map_tiles_status(app, zone_code, grid)
}

#[tauri::command]
pub fn delete_map_tiles<R: Runtime>(app: AppHandle<R>, zone_code: String) -> Result<(), String> {
    if !valid_zone_code(&zone_code) {
        return Err("invalid zone code".to_string());
    }
    let dir = tiles_dir(&app, &zone_code)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// The directory tiles live in, so the frontend can build asset URLs for them.
#[tauri::command]
pub fn map_tiles_dir<R: Runtime>(app: AppHandle<R>, zone_code: String) -> Result<String, String> {
    if !valid_zone_code(&zone_code) {
        return Err("invalid zone code".to_string());
    }
    Ok(tiles_dir(&app, &zone_code)?.to_string_lossy().into_owned())
}
