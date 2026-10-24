//! Whether OBS can capture the DPS overlay, checked on this PC.
//!
//! OBS's Window Capture method "Windows 10 (1903 and up)" is Windows Graphics
//! Capture (WGC), the only one that sees WebView2's DirectComposition output.
//! On a streamer's Windows 10 22H2 PC, OBS found the overlay but WGC refused
//! to make a capture item for it -- `CreateForWindow` failed with
//! `0x80070057` -- while the same overlay captured fine on Windows 11. WGC
//! takes windows that would show in Alt+Tab, and the overlay is kept out of
//! the taskbar and is never activated, so that it never takes the keyboard
//! from the game.
//!
//! So when stream mode comes on, Aether asks WGC the very question OBS asks.
//! If the answer is no, it gives the overlay a taskbar button and asks
//! again, then lets it be activated and asks again, keeping the first that
//! works. If nothing does, it puts the overlay back as it was and says so in
//! Settings, where Display Capture with a crop is offered instead. When
//! stream mode goes off, the overlay goes back to normal.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

use super::aion2_overlay::DPS_OVERLAY_LABEL;

/// What was found out about capturing the overlay.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureCheck {
    /// Not checked: stream mode is off, or the overlay is not up.
    Unknown,
    /// Being checked right now.
    Checking,
    /// WGC takes the overlay as it is.
    Capturable,
    /// WGC takes it once it has a taskbar button.
    NeedsTaskbar,
    /// WGC takes it once it may also be activated.
    NeedsActivation,
    /// WGC refuses it whatever is tried.
    Unsupported,
    /// This Windows has no WGC at all (before 1903).
    NotAvailable,
    /// OBS is reading the meter through the Browser Source (`obs_source`):
    /// nothing needs capturing, and the overlay is left as it is.
    BrowserSource,
}

impl CaptureCheck {
    fn code(self) -> u8 {
        self as u8
    }

    fn from_code(code: u8) -> Self {
        match code {
            1 => Self::Checking,
            2 => Self::Capturable,
            3 => Self::NeedsTaskbar,
            4 => Self::NeedsActivation,
            5 => Self::Unsupported,
            6 => Self::NotAvailable,
            7 => Self::BrowserSource,
            _ => Self::Unknown,
        }
    }
}

static STATUS: AtomicU8 = AtomicU8::new(0);
/// How far the overlay was changed to be capturable: 0 as normal, 1 with a
/// taskbar button, 2 activatable as well.
static LEVEL: AtomicU8 = AtomicU8::new(0);
/// Checked during the current stretch of stream mode.
static CHECKED: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);

pub fn status() -> CaptureCheck {
    CaptureCheck::from_code(STATUS.load(Ordering::SeqCst))
}

/// Whether the overlay is to be left activatable, for the code that shows it.
pub fn overlay_focusable() -> bool {
    LEVEL.load(Ordering::SeqCst) >= 2
}

fn set_status<R: Runtime>(app: &AppHandle<R>, status: CaptureCheck) {
    STATUS.store(status.code(), Ordering::SeqCst);
    let _ = app.emit("obs-capture-status", status);
}

fn apply_level<R: Runtime>(window: &WebviewWindow<R>, level: u8) {
    let _ = window.set_skip_taskbar(level == 0);
    let _ = window.set_focusable(level >= 2);
    LEVEL.store(level, Ordering::SeqCst);
}

/// A new overlay window starts out as normal and is checked again.
pub fn overlay_created() {
    LEVEL.store(0, Ordering::SeqCst);
    CHECKED.store(false, Ordering::SeqCst);
    STATUS.store(CaptureCheck::Unknown.code(), Ordering::SeqCst);
}

/// Called about once a second with whether stream mode is in effect and the
/// overlay is on screen. Starts a check when stream mode has come on, and
/// undoes any change when it has gone off.
pub fn on_stream_tick<R: Runtime>(app: &AppHandle<R>, streaming: bool, overlay_visible: bool) {
    if !streaming {
        if CHECKED.swap(false, Ordering::SeqCst) {
            if LEVEL.load(Ordering::SeqCst) != 0 {
                if let Some(window) = app.get_webview_window(DPS_OVERLAY_LABEL) {
                    apply_level(&window, 0);
                }
            }
            set_status(app, CaptureCheck::Unknown);
        } else if status() == CaptureCheck::BrowserSource && !super::obs_source::connected() {
            set_status(app, CaptureCheck::Unknown);
        }
        return;
    }
    // A Browser Source makes Window Capture unnecessary: no taskbar button,
    // no activation. Checked again should the source go away.
    if super::obs_source::connected() {
        if LEVEL.load(Ordering::SeqCst) != 0 {
            if let Some(window) = app.get_webview_window(DPS_OVERLAY_LABEL) {
                apply_level(&window, 0);
            }
        }
        CHECKED.store(false, Ordering::SeqCst);
        if status() != CaptureCheck::BrowserSource && !RUNNING.load(Ordering::SeqCst) {
            set_status(app, CaptureCheck::BrowserSource);
        }
        return;
    }
    if !overlay_visible || CHECKED.load(Ordering::SeqCst) {
        return;
    }
    CHECKED.store(true, Ordering::SeqCst);
    run(app.clone());
}

/// Check now, whatever was found before. Settings offers it as a button.
pub fn run<R: Runtime>(app: AppHandle<R>) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    set_status(&app, CaptureCheck::Checking);
    std::thread::spawn(move || {
        let result = check(&app);
        set_status(&app, result);
        RUNNING.store(false, Ordering::SeqCst);
    });
}

#[cfg(windows)]
fn check<R: Runtime>(app: &AppHandle<R>) -> CaptureCheck {
    use windows::Graphics::Capture::GraphicsCaptureSession;

    let Some(window) = app.get_webview_window(DPS_OVERLAY_LABEL) else {
        return CaptureCheck::Unknown;
    };
    let Ok(hwnd) = window.hwnd() else {
        return CaptureCheck::Unknown;
    };
    let hwnd = hwnd.0 as isize;
    if !GraphicsCaptureSession::IsSupported().unwrap_or(false) {
        return CaptureCheck::NotAvailable;
    }

    for level in 0..=2u8 {
        if level != LEVEL.load(Ordering::SeqCst) {
            apply_level(&window, level);
            // Let the taskbar and the window manager catch up.
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
        match wgc_accepts(hwnd) {
            Ok(true) => {
                return match level {
                    0 => CaptureCheck::Capturable,
                    1 => CaptureCheck::NeedsTaskbar,
                    _ => CaptureCheck::NeedsActivation,
                }
            }
            Ok(false) => continue,
            Err(error) => {
                // Some other failure: no reason to think a change helps.
                eprintln!("[capture-check] WGC check failed: {error}");
                if level != 0 {
                    apply_level(&window, 0);
                }
                return CaptureCheck::Unknown;
            }
        }
    }
    apply_level(&window, 0);
    CaptureCheck::Unsupported
}

#[cfg(not(windows))]
fn check<R: Runtime>(_app: &AppHandle<R>) -> CaptureCheck {
    CaptureCheck::NotAvailable
}

/// Ask WGC for a capture item for `hwnd`, exactly as OBS does. `Ok(false)` is
/// the refusal OBS logs as `CreateForWindow (0x80070057)`. Creating the item
/// starts no capture and shows no border.
#[cfg(windows)]
pub fn wgc_accepts(hwnd: isize) -> Result<bool, String> {
    use windows::Graphics::Capture::GraphicsCaptureItem;
    use windows::Win32::Foundation::{E_INVALIDARG, HWND};
    use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

    let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
        .map_err(|error| error.to_string())?;
    match unsafe { interop.CreateForWindow::<GraphicsCaptureItem>(HWND(hwnd as _)) } {
        Ok(_) => Ok(true),
        Err(error) if error.code() == E_INVALIDARG => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

/// The last finding, for Settings.
#[tauri::command]
pub fn get_obs_capture_status() -> CaptureCheck {
    status()
}

/// Check again now, for Settings.
#[tauri::command]
pub async fn recheck_obs_capture<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let visible = app
        .get_webview_window(DPS_OVERLAY_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if !visible {
        return Err("Open the DPS overlay first: only a window on screen can be checked.".into());
    }
    run(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_finding_survives_the_round_trip_through_its_code() {
        for status in [
            CaptureCheck::Unknown,
            CaptureCheck::Checking,
            CaptureCheck::Capturable,
            CaptureCheck::NeedsTaskbar,
            CaptureCheck::NeedsActivation,
            CaptureCheck::Unsupported,
            CaptureCheck::NotAvailable,
            CaptureCheck::BrowserSource,
        ] {
            assert_eq!(CaptureCheck::from_code(status.code()), status);
        }
    }
}
