//! Always on top: keep the person's own browser -- Chrome first, Edge second,
//! signed in as they already are -- above the game.
//!
//! Nothing here embeds a browser. A webview has its own cookie jar, Google
//! refuses sign-in inside embedded webviews, and Chrome's cookies are bound to
//! Chrome itself, so the only way to keep someone's session is to use the
//! browser they already run. This module finds it, opens compact app windows
//! in it, and changes the z-order and layering of its windows from outside.
//!
//! Every change to another process's window is recorded so it can be undone:
//! on unpin, on exit, and -- through a small file on disk -- on the next start
//! after a crash. A browser window must never be left stuck on top, see-through,
//! or unclickable because Aether went away.

mod browsers;
#[cfg(windows)]
mod win32;

#[cfg(windows)]
use win32 as platform;

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, MutexGuard, OnceLock,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Emitter, Manager, Runtime,
};

pub use browsers::{BrowserId, BrowserInfo};

/// Emitted to every window whenever the pinned set or its settings change --
/// including from hotkeys and from windows being closed underneath us.
const CHANGED_EVENT: &str = "on-top-changed";

/// Windows 11 border colours: amber for pinned, cyan for ghost. The same two
/// accents the app uses for "active" and "interactive".
const PIN_BORDER: u32 = 0xfde68a;
const GHOST_BORDER: u32 = 0x67e8f9;

const MIN_OPACITY: u8 = 20;
const WATCH_INTERVAL: Duration = Duration::from_millis(750);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SizePreset {
    Small,
    Medium,
    Large,
}

impl SizePreset {
    /// Logical pixels. Each fits a 16:9 video plus an app window's title bar,
    /// so a video page shows its player and nothing else.
    pub fn logical(self) -> (i32, i32) {
        match self {
            SizePreset::Small => (480, 304),
            SizePreset::Medium => (640, 394),
            SizePreset::Large => (854, 514),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Managed {
    browser: BrowserId,
    /// Guards against a closed window's handle being reused by another.
    pid: u32,
    opacity: u8,
    ghost: bool,
    /// Minimised by "hide all", as opposed to by the person.
    hidden: bool,
    original: platform::Original,
}

#[derive(Serialize, Deserialize)]
struct SessionEntry {
    hwnd: i64,
    #[serde(flatten)]
    managed: Managed,
}

/// What the page shows for one browser window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowView {
    hwnd: i64,
    browser: BrowserId,
    title: String,
    /// Opened with `--app=`: no tab strip, no address bar.
    app_window: bool,
    minimized: bool,
    pinned: bool,
    opacity: u8,
    ghost: bool,
    hidden: bool,
    frame: platform::Rect,
    monitor: platform::Rect,
}

static MANAGED: Mutex<BTreeMap<isize, Managed>> = Mutex::new(BTreeMap::new());
static PROFILE_NAMES: Mutex<Option<HashMap<BrowserId, Vec<String>>>> = Mutex::new(None);
static SESSION_FILE: OnceLock<PathBuf> = OnceLock::new();
static NOTIFY: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
static WATCHING: AtomicBool = AtomicBool::new(false);

fn managed() -> MutexGuard<'static, BTreeMap<isize, Managed>> {
    MANAGED.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn notify() {
    if let Some(notify) = NOTIFY.get() {
        notify();
    }
}

/// Whether a top-level window is one we keep on top. The focus tracker asks
/// this so that clicking a pinned video does not hide the DPS overlay as if
/// the person had left the game.
pub fn is_managed(hwnd: isize) -> bool {
    managed().contains_key(&hwnd)
}

// =============================================================================
// Pinning
// =============================================================================

fn pin(raw: isize) -> Result<(), String> {
    let mut map = managed();
    if map.contains_key(&raw) {
        return Ok(());
    }
    let (browser, pid) = platform::window_browser(raw)
        .ok_or_else(|| "That window is no longer open.".to_string())?;

    // Captured under the lock, before any change, so a second pin racing this
    // one cannot record our own topmost flag as the window's original state.
    let original = platform::capture_original(raw);
    if platform::is_minimized(raw) {
        platform::show_without_activating(raw);
    }
    platform::set_topmost(raw, true)?;
    platform::set_border(raw, Some(PIN_BORDER));

    map.insert(
        raw,
        Managed {
            browser,
            pid,
            opacity: 100,
            ghost: false,
            hidden: false,
            original,
        },
    );
    persist(&map);
    drop(map);

    ensure_watcher();
    Ok(())
}

/// Pin, and if the window covers the whole screen, shrink it into a corner.
///
/// A pinned maximised window would sit above everything -- the game, and
/// Aether's own window with the Unpin button in it -- with no way back except
/// a shortcut. A window that fills the screen has no business being on top of
/// a game anyway.
fn pin_and_fit(raw: isize, corner: Corner, size: SizePreset) -> Result<(), String> {
    let fills = platform::fills_screen(raw);
    pin(raw)?;
    if fills {
        platform::snap(raw, corner, size, true)?;
    }
    Ok(())
}

fn unpin(raw: isize) {
    let mut map = managed();
    let Some(entry) = map.remove(&raw) else {
        return;
    };
    persist(&map);
    drop(map);

    if platform::is_alive(raw, entry.pid) {
        if entry.hidden {
            platform::show_without_activating(raw);
        }
        platform::restore_original(raw, &entry.original);
    }
}

fn update<T>(raw: isize, change: impl FnOnce(&mut Managed) -> Result<T, String>) -> Result<T, String> {
    let mut map = managed();
    let entry = map
        .get_mut(&raw)
        .ok_or_else(|| "That window is not pinned.".to_string())?;
    let result = change(entry)?;
    persist(&map);
    Ok(result)
}

fn set_opacity(raw: isize, opacity: u8) -> Result<(), String> {
    let opacity = opacity.clamp(MIN_OPACITY, 100);
    update(raw, |entry| {
        platform::apply_layering(raw, opacity, entry.ghost, &entry.original)?;
        entry.opacity = opacity;
        Ok(())
    })
}

fn set_ghost(raw: isize, ghost: bool) -> Result<(), String> {
    update(raw, |entry| {
        platform::apply_layering(raw, entry.opacity, ghost, &entry.original)?;
        platform::set_border(raw, Some(if ghost { GHOST_BORDER } else { PIN_BORDER }));
        entry.ghost = ghost;
        Ok(())
    })
}

/// Undo everything, for every window. Used on exit and before an update
/// replaces the running binary.
pub fn restore_all() {
    let handles: Vec<isize> = managed().keys().copied().collect();
    for raw in handles {
        unpin(raw);
    }
    if let Some(path) = SESSION_FILE.get() {
        let _ = std::fs::remove_file(path);
    }
}

// =============================================================================
// Hotkey actions
// =============================================================================

/// Pin or unpin the browser window the person is in. Other windows are left
/// alone: this is for browsers, and pinning a game or a system window would be
/// disruptive.
pub fn toggle_pin_foreground() {
    let Some(raw) = platform::foreground_root() else {
        return;
    };
    if is_managed(raw) {
        unpin(raw);
    } else if let Err(error) = pin_and_fit(raw, Corner::TopRight, SizePreset::Medium) {
        eprintln!("[on-top] hotkey pin ignored: {error}");
        return;
    }
    notify();
}

/// Ghost every pinned window, or un-ghost them all if every one already is.
/// A ghost window cannot be clicked, so this hotkey is the way back.
pub fn toggle_ghost_all() {
    let handles: Vec<(isize, bool)> = managed().iter().map(|(raw, m)| (*raw, m.ghost)).collect();
    if handles.is_empty() {
        return;
    }
    let target = handles.iter().any(|(_, ghost)| !ghost);
    for (raw, _) in handles {
        if let Err(error) = set_ghost(raw, target) {
            eprintln!("[on-top] ghost toggle skipped a window: {error}");
        }
    }
    notify();
}

/// Minimise every pinned window, or bring them all back.
pub fn set_all_hidden(target: Option<bool>) -> bool {
    let mut map = managed();
    let hide = target.unwrap_or_else(|| map.values().any(|m| !m.hidden));
    for (raw, entry) in map.iter_mut() {
        if hide && !entry.hidden {
            platform::minimize(*raw);
            entry.hidden = true;
        } else if !hide && entry.hidden {
            platform::show_without_activating(*raw);
            let _ = platform::set_topmost(*raw, true);
            entry.hidden = false;
        }
    }
    persist(&map);
    drop(map);
    notify();
    hide
}

// =============================================================================
// Watching
// =============================================================================

/// While anything is pinned: forget windows that closed, notice a hidden window
/// the person restored themselves, and put back a topmost flag or layering the
/// browser dropped. Stops itself when nothing is pinned.
fn ensure_watcher() {
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("on-top-watch".into())
        .spawn(|| loop {
            std::thread::sleep(WATCH_INTERVAL);

            let snapshot: Vec<(isize, Managed)> =
                managed().iter().map(|(raw, m)| (*raw, m.clone())).collect();
            let mut closed = Vec::new();
            let mut shown_again = Vec::new();

            for (raw, entry) in &snapshot {
                if !platform::is_alive(*raw, entry.pid) {
                    closed.push(*raw);
                    continue;
                }
                if entry.hidden {
                    if !platform::is_minimized(*raw) {
                        shown_again.push(*raw);
                    }
                    continue;
                }
                if !platform::is_topmost(*raw) {
                    let _ = platform::set_topmost(*raw, true);
                }
                let dimmed = entry.opacity < 100 || entry.ghost;
                if dimmed && !platform::has_layering(*raw, entry.ghost) {
                    let _ = platform::apply_layering(*raw, entry.opacity, entry.ghost, &entry.original);
                }
            }

            if !closed.is_empty() || !shown_again.is_empty() {
                let mut map = managed();
                for raw in &closed {
                    map.remove(raw);
                }
                for raw in &shown_again {
                    if let Some(entry) = map.get_mut(raw) {
                        entry.hidden = false;
                    }
                }
                persist(&map);
                drop(map);
                notify();
            }

            if managed().is_empty() {
                WATCHING.store(false, Ordering::SeqCst);
                // A pin can land between the check and the store; if one did
                // and no other watcher has started, keep going.
                if managed().is_empty() || WATCHING.swap(true, Ordering::SeqCst) {
                    break;
                }
            }
        });
    if spawned.is_err() {
        WATCHING.store(false, Ordering::SeqCst);
    }
}

// =============================================================================
// Crash recovery
// =============================================================================

fn persist(map: &BTreeMap<isize, Managed>) {
    let Some(path) = SESSION_FILE.get() else {
        return;
    };
    if map.is_empty() {
        let _ = std::fs::remove_file(path);
        return;
    }
    let entries: Vec<SessionEntry> = map
        .iter()
        .map(|(raw, managed)| SessionEntry {
            hwnd: *raw as i64,
            managed: managed.clone(),
        })
        .collect();
    if let Ok(json) = serde_json::to_string(&entries) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, json);
    }
}

/// Undo what a previous run left behind if it ended without restoring --
/// a crash, a kill from Task Manager, an update that replaced the binary.
fn recover_previous_session(path: &PathBuf) {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    let entries: Vec<SessionEntry> = serde_json::from_str(&raw).unwrap_or_default();
    for entry in entries {
        let hwnd = entry.hwnd as isize;
        if platform::is_alive(hwnd, entry.managed.pid) {
            if entry.managed.hidden {
                platform::show_without_activating(hwnd);
            }
            platform::restore_original(hwnd, &entry.managed.original);
        }
    }
    let _ = std::fs::remove_file(path);
}

// =============================================================================
// Launching
// =============================================================================

/// Turn what someone typed into something safe to hand a browser: a web
/// address, or failing that, a search.
fn normalize_url(input: &str, browser: BrowserId) -> Result<String, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("Enter an address to open.".into());
    }

    let lower = text.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Ok(text.replace(' ', "%20").replace('"', "%22"));
    }
    if lower.contains("://") || lower.starts_with("javascript:") || lower.starts_with("data:") {
        return Err("Only web addresses (http or https) can be opened.".into());
    }

    let host = text.split(['/', '?', '#']).next().unwrap_or("");
    let looks_like_address = !text.contains(char::is_whitespace)
        && (host.contains('.') || host.starts_with("localhost"));
    if looks_like_address {
        return Ok(format!("https://{}", text.replace('"', "%22")));
    }

    let engine = match browser {
        BrowserId::Chrome => "https://www.google.com/search?q=",
        BrowserId::Edge => "https://www.bing.com/search?q=",
    };
    Ok(format!("{engine}{}", percent_encode(text)))
}

fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Only an existing profile directory is passed on: given an unknown one, the
/// browser would quietly create a brand-new empty profile.
fn usable_profile(browser: BrowserId, profile: Option<String>) -> Option<String> {
    let dir = profile?;
    let plain = !dir.is_empty()
        && dir.len() < 128
        && !dir.contains(['/', '\\', '"', ':'])
        && dir != "."
        && dir != "..";
    if !plain {
        return None;
    }
    let exists = browsers::user_data_dir(browser)
        .map(|root| root.join(&dir).is_dir())
        .unwrap_or(false);
    exists.then_some(dir)
}

fn launch_blocking(
    browser: BrowserId,
    profile: Option<String>,
    url: String,
    corner: Corner,
    size: SizePreset,
) -> Result<i64, String> {
    let exe = browsers::find_exe(browser)
        .ok_or_else(|| format!("{} is not installed.", browser.display_name()))?;

    let before: HashSet<isize> = platform::browser_windows(true)
        .into_iter()
        .filter(|w| w.browser == browser)
        .map(|w| w.hwnd)
        .collect();

    let mut args = vec![format!("--app={url}")];
    if let Some(dir) = usable_profile(browser, profile) {
        args.push(format!("--profile-directory={dir}"));
    }
    platform::launch(&exe, &args)?;

    // A browser that was not running may also restore last session's windows.
    // An app window has no browser name in its title, which is how ours is
    // told apart; any new window is accepted if that never shows up.
    let deadline = Instant::now() + LAUNCH_TIMEOUT;
    let mut fallback: Option<(isize, Instant)> = None;
    let found = loop {
        std::thread::sleep(Duration::from_millis(100));
        let fresh: Vec<_> = platform::browser_windows(true)
            .into_iter()
            .filter(|w| w.browser == browser && !before.contains(&w.hwnd))
            .collect();

        if let Some(window) = fresh.iter().find(|w| {
            !w.raw_title.is_empty() && browsers::is_app_window_title(browser, &w.raw_title)
        }) {
            break Some(window.hwnd);
        }
        if fallback.is_none() {
            fallback = fresh.first().map(|w| (w.hwnd, Instant::now()));
        }
        if let Some((raw, seen)) = fallback {
            if seen.elapsed() > Duration::from_secs(3) {
                break Some(raw);
            }
        }
        if Instant::now() > deadline {
            break fallback.map(|(raw, _)| raw);
        }
    };

    let raw = found.ok_or_else(|| {
        format!(
            "{} started, but its window did not appear. It may have opened on another desktop.",
            browser.display_name()
        )
    })?;

    // Let the browser finish its own first layout before moving the window.
    std::thread::sleep(Duration::from_millis(150));
    pin(raw)?;
    platform::snap(raw, corner, size, true)?;
    // Chromium restores an app window's remembered bounds as it finishes
    // opening. If that landed after our move, this puts it back; if not, it
    // is the same rectangle again and nothing moves.
    std::thread::sleep(Duration::from_millis(400));
    let _ = platform::snap(raw, corner, size, true);

    notify();
    Ok(raw as i64)
}

// =============================================================================
// Listing
// =============================================================================

fn list_windows() -> Vec<WindowView> {
    let names = PROFILE_NAMES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .unwrap_or_default();
    let map = managed().clone();

    let mut views: Vec<WindowView> = platform::browser_windows(true)
        .into_iter()
        .filter(|w| !w.raw_title.is_empty() || map.contains_key(&w.hwnd))
        .map(|w| {
            let entry = map.get(&w.hwnd);
            let profile_names = names.get(&w.browser).map(Vec::as_slice).unwrap_or(&[]);
            let title = browsers::clean_title(w.browser, &w.raw_title, profile_names);
            WindowView {
                hwnd: w.hwnd as i64,
                browser: w.browser,
                app_window: browsers::is_app_window_title(w.browser, &w.raw_title),
                title: if title.is_empty() { "Untitled window".into() } else { title },
                minimized: w.minimized,
                pinned: entry.is_some(),
                opacity: entry.map_or(100, |m| m.opacity),
                ghost: entry.is_some_and(|m| m.ghost),
                hidden: entry.is_some_and(|m| m.hidden),
                frame: w.frame,
                monitor: w.monitor,
            }
        })
        .collect();

    // Chrome before Edge; within each, the enumeration's front-to-back order.
    views.sort_by_key(|view| BrowserId::ALL.iter().position(|b| *b == view.browser));
    views
}

// =============================================================================
// Commands
// =============================================================================

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn on_top_detect() -> Result<Vec<BrowserInfo>, String> {
    blocking(|| {
        let found = browsers::detect_all();
        let names = found
            .iter()
            .map(|b| (b.id, b.profiles.iter().map(|p| p.name.clone()).collect()))
            .collect();
        *PROFILE_NAMES.lock().unwrap_or_else(|p| p.into_inner()) = Some(names);
        Ok(found)
    })
    .await
}

#[tauri::command]
pub async fn on_top_windows() -> Result<Vec<WindowView>, String> {
    blocking(|| Ok(list_windows())).await
}

/// `corner` and `size` are where a window that fills the screen goes when it
/// is pinned; any other window keeps its place.
#[tauri::command]
pub async fn on_top_pin(
    hwnd: i64,
    pinned: bool,
    corner: Option<Corner>,
    size: Option<SizePreset>,
) -> Result<(), String> {
    blocking(move || {
        if pinned {
            pin_and_fit(
                hwnd as isize,
                corner.unwrap_or(Corner::TopRight),
                size.unwrap_or(SizePreset::Medium),
            )?;
        } else {
            unpin(hwnd as isize);
        }
        notify();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn on_top_set_opacity(hwnd: i64, opacity: u8) -> Result<(), String> {
    blocking(move || set_opacity(hwnd as isize, opacity)).await
}

#[tauri::command]
pub async fn on_top_set_ghost(hwnd: i64, ghost: bool) -> Result<(), String> {
    blocking(move || {
        set_ghost(hwnd as isize, ghost)?;
        notify();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn on_top_snap(hwnd: i64, corner: Corner, size: SizePreset) -> Result<(), String> {
    blocking(move || {
        let raw = hwnd as isize;
        let pinned = is_managed(raw);
        if pinned {
            let _ = update(raw, |entry| {
                if entry.hidden {
                    platform::show_without_activating(raw);
                    entry.hidden = false;
                }
                Ok(())
            });
        }
        platform::snap(raw, corner, size, pinned)?;
        notify();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn on_top_focus(hwnd: i64) -> Result<(), String> {
    blocking(move || {
        let raw = hwnd as isize;
        let _ = update(raw, |entry| {
            entry.hidden = false;
            Ok(())
        });
        platform::focus(raw);
        notify();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn on_top_set_hidden(hidden: Option<bool>) -> Result<bool, String> {
    blocking(move || Ok(set_all_hidden(hidden))).await
}

#[tauri::command]
pub async fn on_top_unpin_all() -> Result<(), String> {
    blocking(|| {
        restore_all();
        notify();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn on_top_launch(
    browser: BrowserId,
    profile: Option<String>,
    url: String,
    corner: Corner,
    size: SizePreset,
) -> Result<i64, String> {
    let url = normalize_url(&url, browser)?;
    blocking(move || launch_blocking(browser, profile, url, corner, size)).await
}

// =============================================================================
// Plugin
// =============================================================================

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("on-top")
        .setup(|app, _api| {
            if let Ok(dir) = app.path().app_data_dir() {
                let path = dir.join("on-top-session.json");
                recover_previous_session(&path);
                let _ = SESSION_FILE.set(path);
            }

            let handle = app.clone();
            let _ = NOTIFY.set(Box::new(move || {
                let _ = handle.emit(CHANGED_EVENT, ());
            }));
            Ok(())
        })
        .build()
}

// =============================================================================
// Other platforms
// =============================================================================

#[cfg(not(windows))]
mod platform {
    //! Windows-only feature; these keep the crate building elsewhere.
    use std::path::{Path, PathBuf};

    use serde::{Deserialize, Serialize};

    use super::{browsers::BrowserId, Corner, SizePreset};

    const UNSUPPORTED: &str = "Always on top is only available on Windows.";

    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
    pub struct Rect {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }

    #[derive(Debug, Clone)]
    pub struct RawWindow {
        pub hwnd: isize,
        pub pid: u32,
        pub browser: BrowserId,
        pub raw_title: String,
        pub minimized: bool,
        pub frame: Rect,
        pub monitor: Rect,
    }

    #[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
    pub struct Original {}

    pub fn browser_windows(_: bool) -> Vec<RawWindow> {
        Vec::new()
    }
    pub fn window_browser(_: isize) -> Option<(BrowserId, u32)> {
        None
    }
    pub fn is_alive(_: isize, _: u32) -> bool {
        false
    }
    pub fn is_minimized(_: isize) -> bool {
        false
    }
    pub fn is_topmost(_: isize) -> bool {
        false
    }
    pub fn fills_screen(_: isize) -> bool {
        false
    }
    pub fn has_layering(_: isize, _: bool) -> bool {
        false
    }
    pub fn foreground_root() -> Option<isize> {
        None
    }
    pub fn read_app_path(_: &str) -> Option<PathBuf> {
        None
    }
    pub fn capture_original(_: isize) -> Original {
        Original {}
    }
    pub fn set_topmost(_: isize, _: bool) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn apply_layering(_: isize, _: u8, _: bool, _: &Original) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn restore_original(_: isize, _: &Original) {}
    pub fn set_border(_: isize, _: Option<u32>) {}
    pub fn snap(_: isize, _: Corner, _: SizePreset, _: bool) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn minimize(_: isize) {}
    pub fn show_without_activating(_: isize) {}
    pub fn focus(_: isize) {}
    pub fn launch(_: &Path, _: &[String]) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_get_a_scheme() {
        assert_eq!(
            normalize_url("youtube.com", BrowserId::Chrome).unwrap(),
            "https://youtube.com"
        );
        assert_eq!(
            normalize_url("  https://www.twitch.tv/x ", BrowserId::Chrome).unwrap(),
            "https://www.twitch.tv/x"
        );
        assert_eq!(
            normalize_url("localhost:3000/a", BrowserId::Chrome).unwrap(),
            "https://localhost:3000/a"
        );
    }

    #[test]
    fn words_become_a_search_in_that_browsers_engine() {
        assert_eq!(
            normalize_url("aion 2 fire temple", BrowserId::Chrome).unwrap(),
            "https://www.google.com/search?q=aion+2+fire+temple"
        );
        assert!(normalize_url("guide", BrowserId::Edge)
            .unwrap()
            .starts_with("https://www.bing.com/search?q=guide"));
    }

    #[test]
    fn refuses_anything_that_is_not_the_web() {
        assert!(normalize_url("", BrowserId::Chrome).is_err());
        assert!(normalize_url("file:///C:/Windows", BrowserId::Chrome).is_err());
        assert!(normalize_url("javascript:alert(1)", BrowserId::Chrome).is_err());
        assert!(normalize_url("chrome://settings", BrowserId::Chrome).is_err());
    }

    #[test]
    fn unknown_profiles_are_not_passed_on() {
        assert_eq!(usable_profile(BrowserId::Chrome, None), None);
        assert_eq!(usable_profile(BrowserId::Chrome, Some("..".into())), None);
        assert_eq!(usable_profile(BrowserId::Chrome, Some("a/b".into())), None);
        assert_eq!(
            usable_profile(BrowserId::Chrome, Some("No Such Profile 9999".into())),
            None
        );
    }

    /// The page (`src/games/aion2/lib/on-top.ts`) reads these exact keys; a
    /// rename on either side would fail silently as `undefined`.
    #[test]
    fn window_view_matches_the_page_contract() {
        let view = WindowView {
            hwnd: 42,
            browser: BrowserId::Edge,
            title: "t".into(),
            app_window: true,
            minimized: false,
            pinned: true,
            opacity: 80,
            ghost: true,
            hidden: false,
            frame: platform::Rect::default(),
            monitor: platform::Rect::default(),
        };
        let json = serde_json::to_value(&view).unwrap();
        let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "appWindow", "browser", "frame", "ghost", "hidden", "hwnd", "minimized",
                "monitor", "opacity", "pinned", "title"
            ]
        );
        assert_eq!(json["browser"], "edge");
        let mut rect: Vec<_> = json["frame"].as_object().unwrap().keys().cloned().collect();
        rect.sort();
        assert_eq!(rect, ["bottom", "left", "right", "top"]);
    }

    #[test]
    fn browser_info_matches_the_page_contract() {
        let info = BrowserInfo {
            id: BrowserId::Chrome,
            name: "Chrome".into(),
            exe: "chrome.exe".into(),
            version: None,
            profiles: vec![browsers::BrowserProfile {
                dir: "Default".into(),
                name: "Kapten".into(),
                email: None,
                color: None,
                avatar: None,
            }],
            last_used_profile: Some("Default".into()),
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["id"], "chrome");
        assert_eq!(json["lastUsedProfile"], "Default");
        let mut keys: Vec<_> = json["profiles"][0].as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["avatar", "color", "dir", "email", "name"]);
    }

    #[test]
    fn reads_the_values_the_page_sends() {
        let corner: Corner = serde_json::from_str("\"bottom-left\"").unwrap();
        let size: SizePreset = serde_json::from_str("\"large\"").unwrap();
        let browser: BrowserId = serde_json::from_str("\"edge\"").unwrap();
        assert_eq!(
            (corner, size, browser),
            (Corner::BottomLeft, SizePreset::Large, BrowserId::Edge)
        );
        for text in ["\"top-left\"", "\"top-right\"", "\"bottom-right\""] {
            assert!(serde_json::from_str::<Corner>(text).is_ok(), "{text}");
        }
        for text in ["\"small\"", "\"medium\""] {
            assert!(serde_json::from_str::<SizePreset>(text).is_ok(), "{text}");
        }
    }

    #[test]
    fn presets_fit_a_video_and_a_title_bar() {
        for preset in [SizePreset::Small, SizePreset::Medium, SizePreset::Large] {
            let (w, h) = preset.logical();
            let video = (w as f64 * 9.0 / 16.0).round() as i32;
            assert!((h - video - 34).abs() <= 1, "{preset:?}: {w}x{h}");
        }
    }
}
