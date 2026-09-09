//! The interactive map: its dataset on disk, and its overlay window.
//!
//! Kept apart from `aion2_overlay` because the map shares nothing with the DPS
//! overlays but the window-building idiom. It has no dependency on the meter,
//! and works whether or not capture is running.

use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

const MAP_OVERLAY_LABEL: &str = "aion2-map-overlay";
const OVERLAY_WIDTH: f64 = 320.0;
const OVERLAY_HEIGHT: f64 = 360.0;

/// The zone the overlay should show. Set when the overlay is opened, read back
/// by the overlay window once it has loaded -- simpler than threading it
/// through the URL, and it survives a reload of that window.
static OVERLAY_ZONE: RwLock<Option<String>> = RwLock::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapDataset {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zones: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub categories: Option<serde_json::Value>,
    pub markers: serde_json::Value,
}

/// Where a surveyed dataset is read from, if one has been put there.
///
/// `%APPDATA%/<app>/maps/dataset.json`. Deliberately outside the bundle: the
/// real data comes out of the game client and will take several passes to get
/// right, and each pass should be a file copy rather than a rebuild and a
/// reinstall.
fn dataset_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("maps").join("dataset.json"))
}

/// `Ok(None)` means no dataset is installed, which is the normal case and not
/// an error -- the frontend falls back to its bundled sample.
#[tauri::command]
pub fn load_map_dataset<R: Runtime>(app: AppHandle<R>) -> Result<Option<MapDataset>, String> {
    let Some(path) = dataset_path(&app) else {
        return Ok(None);
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };

    match serde_json::from_str::<MapDataset>(&raw) {
        Ok(dataset) => Ok(Some(dataset)),
        // A malformed file is worth naming: someone put it there on purpose.
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

#[tauri::command]
pub fn get_map_overlay_zone() -> Result<Option<String>, String> {
    Ok(OVERLAY_ZONE.read().unwrap().clone())
}

/// Open the always-on-top minimap, or re-point an open one at another zone.
#[tauri::command]
pub async fn create_map_overlay<R: Runtime>(
    app: AppHandle<R>,
    zone_id: Option<String>,
) -> Result<(), String> {
    *OVERLAY_ZONE.write().unwrap() = zone_id;

    if let Some(window) = app.get_webview_window(MAP_OVERLAY_LABEL) {
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        // Already open on a different zone: reload so it picks up the new one.
        let _ = window.eval("location.reload()");
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        &app,
        MAP_OVERLAY_LABEL,
        WebviewUrl::App("src/games/aion2/overlay/map/index.html".into()),
    )
    .title("Aether | Map")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .inner_size(OVERLAY_WIDTH, OVERLAY_HEIGHT)
    .min_inner_size(220.0, 240.0)
    .resizable(true)
    .maximizable(false)
    .visible(false)
    .build()
    .map_err(|error| error.to_string())?;

    window.show().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn destroy_map_overlay<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MAP_OVERLAY_LABEL) {
        window.destroy().map_err(|error| error.to_string())?;
    }
    Ok(())
}
