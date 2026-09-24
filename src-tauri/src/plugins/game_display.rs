//! Keeping pinned windows, chat pop-ups, and the meter above a fullscreen game
//! -- any game, not only AION 2 -- and saying plainly when that cannot work.
//!
//! How a game fills the screen decides everything:
//!
//! - **Borderless** ("fullscreen windowed"): an ordinary window the size of
//!   the monitor. Windows composes it like any other, so our topmost windows
//!   show over it. The game's own window can sit in the topmost band too, and
//!   activating it lifts it over ours, so while it is in front ours are raised
//!   back above it.
//! - **Fullscreen**: the game asks Direct3D for the whole display. On Windows
//!   10 and 11 that is usually handled with "fullscreen optimizations", which
//!   still composes other windows on top -- the same raise makes them show.
//!   Some games, and any with those optimizations turned off, run in true
//!   exclusive mode instead, which bypasses the compositor: nothing another
//!   program shows can appear, not Discord's, Steam's, or NVIDIA's overlays
//!   either. The only way through is to inject code into the game, which
//!   anti-cheat (BattlEye, and AION 2's) bans for and Aether never does.
//!
//! Windows cannot say which of the two a fullscreen game got, so Aether keeps
//! raising and, once, explains what to do if nothing appears: switch the game
//! to borderless, which with Windows 11's "Optimizations for windowed games"
//! runs as fast as fullscreen.
//!
//! Raising is only ever a z-order change without activation, and only when one
//! of our windows is actually below the game, so it never takes focus. The
//! game itself is only ever looked at from outside: its window's size and
//! style, the shell's fullscreen state, and the registry. No handle to its
//! process is opened (see `process_names`).

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

const AION2_EXE: &str = "Aion2.exe";
const CHANGED_EVENT: &str = "game-display-changed";
const TICK: std::time::Duration = std::time::Duration::from_millis(1500);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DisplayMode {
    /// No fullscreen app seen since it last exited.
    None,
    Borderless,
    /// Direct3D fullscreen: overlays show if Windows applied fullscreen
    /// optimizations, and cannot in true exclusive mode.
    Fullscreen,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameDisplayStatus {
    pub mode: DisplayMode,
    /// The fullscreen app last seen in front, by executable name.
    pub app: Option<String>,
    /// Whether that app is in front right now.
    pub in_front: bool,
    pub is_aion2: bool,
    /// "Disable fullscreen optimizations" ticked in the app's Properties,
    /// which forces true exclusive mode.
    pub fullscreen_optimizations_disabled: bool,
    /// Windows 11's "Optimizations for windowed games", which makes
    /// borderless as fast as fullscreen. `None` when never set.
    pub windowed_game_optimizations: Option<bool>,
}

/// What one look at the foreground window found.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct WindowFacts {
    pub ours: bool,
    pub shell: bool,
    pub minimized: bool,
    pub covers_monitor: bool,
    pub framed: bool,
}

/// How the window in front fills the screen, if it does. `None` means it is
/// not a fullscreen app (a normal window, the desktop, or one of ours).
pub(crate) fn classify(facts: WindowFacts, d3d_fullscreen: bool) -> Option<DisplayMode> {
    if facts.ours || facts.shell || facts.minimized || !facts.covers_monitor {
        return None;
    }
    if d3d_fullscreen {
        return Some(DisplayMode::Fullscreen);
    }
    // A maximised window with a title bar is just a big window.
    (!facts.framed).then_some(DisplayMode::Borderless)
}

struct State {
    mode: DisplayMode,
    app: Option<String>,
    hwnd: isize,
    pid: u32,
    in_front: bool,
}

static STATE: Mutex<State> = Mutex::new(State {
    mode: DisplayMode::None,
    app: None,
    hwnd: 0,
    pid: 0,
    in_front: false,
});
/// Executables already told about fullscreen this run.
static NOTIFIED: Mutex<Vec<String>> = Mutex::new(Vec::new());
static RUNNING: AtomicBool = AtomicBool::new(false);

fn status() -> GameDisplayStatus {
    let (mode, app, in_front) = STATE
        .lock()
        .map(|s| (s.mode, s.app.clone(), s.in_front))
        .unwrap_or((DisplayMode::None, None, false));
    GameDisplayStatus {
        mode,
        fullscreen_optimizations_disabled: app
            .as_deref()
            .is_some_and(platform::fullscreen_optimizations_disabled),
        is_aion2: app
            .as_deref()
            .is_some_and(|name| name.eq_ignore_ascii_case(AION2_EXE)),
        app,
        in_front,
        windowed_game_optimizations: platform::windowed_game_optimizations(),
    }
}

#[tauri::command]
pub fn get_game_display_status() -> GameDisplayStatus {
    status()
}

/// Windows' graphics settings page, where "Optimizations for windowed games"
/// lives. Opened for the player to change; Aether never flips it.
#[tauri::command]
pub fn open_graphics_settings() -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg("ms-settings:display-advancedgraphics")
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Anything of ours that is meant to be seen over a game right now.
fn anything_on_top() -> bool {
    super::aion2_overlay::is_dps_overlay_active()
        || super::on_top::has_pinned()
        || super::on_top::chat::has_overlays()
}

/// Look at the window in front and act on it. Called on every foreground
/// change and on a slow tick, since a game can go fullscreen after it came
/// to the front.
pub fn check<R: Runtime>(app: &AppHandle<R>) {
    let Some(front) = platform::foreground() else {
        return;
    };
    // Our own windows say nothing about how the game runs: keep what was
    // known, only noting that it is no longer in front.
    if front.facts.ours {
        let was_in_front = STATE
            .lock()
            .map(|mut state| std::mem::replace(&mut state.in_front, false))
            .unwrap_or(false);
        if was_in_front {
            let _ = app.emit(CHANGED_EVENT, status());
        }
        return;
    }

    let d3d = front.facts.covers_monitor && platform::d3d_fullscreen_in_front();
    let seen = classify(front.facts, d3d);

    let (changed, notify_for) = {
        let Ok(mut state) = STATE.lock() else {
            return;
        };
        let before = (state.mode, state.app.clone(), state.in_front);
        match seen {
            Some(mode) => {
                state.mode = mode;
                state.app = front.exe_name.clone();
                state.hwnd = front.hwnd;
                state.pid = front.pid;
                state.in_front = true;
            }
            None => {
                state.in_front = false;
                // The app we knew has closed its window: forget it.
                if state.pid != 0 && !platform::window_alive(state.hwnd, state.pid) {
                    state.mode = DisplayMode::None;
                    state.app = None;
                    state.hwnd = 0;
                    state.pid = 0;
                }
            }
        }
        let changed = before != (state.mode, state.app.clone(), state.in_front);
        let notify_for = (seen == Some(DisplayMode::Fullscreen))
            .then(|| state.app.clone())
            .flatten();
        (changed, notify_for)
    };

    if changed {
        let _ = app.emit(CHANGED_EVENT, status());
    }

    if seen.is_some() && anything_on_top() {
        super::on_top::raise_all_over(app, front.hwnd);
        if let Some(exe) = notify_for {
            notify_fullscreen(app, &exe);
        }
    }
}

/// Once per game per run, and only when something was meant to be on screen:
/// what to do if it does not appear. A Windows notification, because in true
/// exclusive mode nothing of ours can show over the game.
fn notify_fullscreen<R: Runtime>(app: &AppHandle<R>, exe: &str) {
    {
        let Ok(mut notified) = NOTIFIED.lock() else {
            return;
        };
        if notified.iter().any(|seen| seen.eq_ignore_ascii_case(exe)) {
            return;
        }
        notified.push(exe.to_string());
    }
    let name = exe.trim_end_matches(".exe").trim_end_matches(".EXE");
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(format!("{name} is in fullscreen"))
        .body(
            "Aether keeps your chat and pinned windows above it. If they do not show, the game \
             is in exclusive mode, which nothing can draw over: switch it to borderless \
             (fullscreen windowed).",
        )
        .show();
}

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("game-display")
        .setup(|app, _| {
            if RUNNING.swap(true, Ordering::SeqCst) {
                return Ok(());
            }
            let handle = app.app_handle().clone();
            let spawned = std::thread::Builder::new()
                .name("game-display".into())
                .spawn(move || loop {
                    // Idle unless something of ours is out to be shown, or a
                    // game is being tracked for the settings page.
                    let tracking = STATE.lock().map(|s| s.pid != 0).unwrap_or(false);
                    if tracking || anything_on_top() {
                        check(&handle);
                    }
                    std::thread::sleep(TICK);
                });
            if let Err(error) = spawned {
                eprintln!("[game-display] could not start: {error}");
            }
            Ok(())
        })
        .build()
}

pub(crate) struct Foreground {
    pub hwnd: isize,
    pub pid: u32,
    pub facts: WindowFacts,
    pub exe_name: Option<String>,
}

/// Whether a Compatibility-tab entry (a full exe path and its flags) turns
/// fullscreen optimizations off for the executable named `exe`.
pub(crate) fn layer_disables_fso(path: &str, flags: &str, exe: &str) -> bool {
    let name = path.rsplit(['\\', '/']).next().unwrap_or(path);
    name.eq_ignore_ascii_case(exe)
        && flags
            .to_ascii_uppercase()
            .split_whitespace()
            .any(|flag| flag == "DISABLEDXMAXIMIZEDWINDOWEDMODE")
}

#[cfg(windows)]
mod platform {
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{
            Foundation::{ERROR_SUCCESS, HWND, RECT},
            Graphics::Gdi::{
                GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
            },
            System::Registry::{
                RegCloseKey, RegEnumValueW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER,
                HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, REG_SZ, RRF_RT_REG_SZ,
            },
            UI::{
                Shell::{SHQueryUserNotificationState, QUNS_RUNNING_D3D_FULL_SCREEN},
                WindowsAndMessaging::{
                    GetAncestor, GetClassNameW, GetForegroundWindow, GetWindowLongW, GetWindowRect,
                    GetWindowThreadProcessId, IsIconic, IsWindow, GA_ROOT, GWL_STYLE, WS_CAPTION,
                    WS_THICKFRAME,
                },
            },
        },
    };

    use super::{layer_disables_fso, Foreground, WindowFacts};

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Whether the game's window still exists, asked of the window manager
    /// rather than of the game's process.
    pub fn window_alive(raw: isize, pid: u32) -> bool {
        unsafe {
            let window = HWND(raw as *mut _);
            if !IsWindow(Some(window)).as_bool() {
                return false;
            }
            let mut owner = 0u32;
            GetWindowThreadProcessId(window, Some(&mut owner));
            owner == pid
        }
    }

    fn class_name(window: HWND) -> String {
        let mut buffer = [0u16; 64];
        let len = unsafe { GetClassNameW(window, &mut buffer) } as usize;
        String::from_utf16_lossy(&buffer[..len.min(buffer.len())])
    }

    /// The window in front, and what it looks like.
    pub fn foreground() -> Option<Foreground> {
        unsafe {
            let front = GetForegroundWindow();
            if front.0.is_null() {
                return None;
            }
            let window = GetAncestor(front, GA_ROOT);
            let window = if window.0.is_null() { front } else { window };

            let mut pid = 0u32;
            GetWindowThreadProcessId(window, Some(&mut pid));
            let ours = pid == std::process::id();
            let class = class_name(window);
            let shell = matches!(
                class.as_str(),
                "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
            );

            let style = GetWindowLongW(window, GWL_STYLE) as u32;
            let mut rect = RECT::default();
            let _ = GetWindowRect(window, &mut rect);
            let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            let covers = GetMonitorInfoW(monitor, &mut info).as_bool()
                && rect.left <= info.rcMonitor.left
                && rect.top <= info.rcMonitor.top
                && rect.right >= info.rcMonitor.right
                && rect.bottom >= info.rcMonitor.bottom;

            let exe_name = if ours {
                None
            } else {
                crate::plugins::process_names::exe_name(pid)
            };

            Some(Foreground {
                hwnd: window.0 as isize,
                pid,
                facts: WindowFacts {
                    ours,
                    shell,
                    minimized: IsIconic(window).as_bool(),
                    covers_monitor: covers,
                    framed: style & WS_CAPTION.0 == WS_CAPTION.0 || style & WS_THICKFRAME.0 != 0,
                },
                exe_name,
            })
        }
    }

    /// Whether the app in front runs Direct3D fullscreen.
    pub fn d3d_fullscreen_in_front() -> bool {
        unsafe { SHQueryUserNotificationState() }
            .map(|state| state == QUNS_RUNNING_D3D_FULL_SCREEN)
            .unwrap_or(false)
    }

    fn registry_value(root: HKEY, subkey: &str, value: &str) -> Option<String> {
        let subkey = wide(subkey);
        let value = wide(value);
        unsafe {
            let mut size = 0u32;
            let status = RegGetValueW(
                root,
                PCWSTR(subkey.as_ptr()),
                PCWSTR(value.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                None,
                Some(&mut size),
            );
            if status != ERROR_SUCCESS || size == 0 {
                return None;
            }
            let mut buffer = vec![0u16; (size as usize).div_ceil(2) + 1];
            let mut size = (buffer.len() * 2) as u32;
            let status = RegGetValueW(
                root,
                PCWSTR(subkey.as_ptr()),
                PCWSTR(value.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr() as *mut _),
                Some(&mut size),
            );
            if status != ERROR_SUCCESS {
                return None;
            }
            Some(
                String::from_utf16_lossy(&buffer)
                    .trim_end_matches('\0')
                    .to_string(),
            )
        }
    }

    /// Every Compatibility-tab entry under `root`: exe path and flags.
    fn compat_layers(root: HKEY) -> Vec<(String, String)> {
        const LAYERS: &str =
            "Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers";
        let subkey = wide(LAYERS);
        let mut entries = Vec::new();
        unsafe {
            let mut key = HKEY::default();
            if RegOpenKeyExW(
                root,
                PCWSTR(subkey.as_ptr()),
                None,
                KEY_QUERY_VALUE,
                &mut key,
            ) != ERROR_SUCCESS
            {
                return entries;
            }
            let mut name = vec![0u16; 32_768];
            let mut data = vec![0u8; 4096];
            for index in 0..4096u32 {
                let mut name_len = name.len() as u32;
                let mut data_len = data.len() as u32;
                let mut kind = 0u32;
                let status = RegEnumValueW(
                    key,
                    index,
                    Some(PWSTR(name.as_mut_ptr())),
                    &mut name_len,
                    None,
                    Some(&mut kind),
                    Some(data.as_mut_ptr()),
                    Some(&mut data_len),
                );
                if status != ERROR_SUCCESS {
                    // ERROR_NO_MORE_ITEMS, or a value too large to be flags.
                    break;
                }
                if kind != REG_SZ.0 {
                    continue;
                }
                let units: Vec<u16> = data[..data_len as usize]
                    .chunks_exact(2)
                    .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                    .collect();
                entries.push((
                    String::from_utf16_lossy(&name[..name_len as usize]),
                    String::from_utf16_lossy(&units)
                        .trim_end_matches('\0')
                        .to_string(),
                ));
            }
            let _ = RegCloseKey(key);
        }
        entries
    }

    /// "Disable fullscreen optimizations" in the Compatibility tab of an exe
    /// with this name, for this user or for everyone. Matched by name because
    /// the full path would mean asking the game's process. Read, never written.
    pub fn fullscreen_optimizations_disabled(exe_name: &str) -> bool {
        [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
            .into_iter()
            .any(|root| {
                compat_layers(root)
                    .iter()
                    .any(|(path, flags)| layer_disables_fso(path, flags, exe_name))
            })
    }

    /// Windows 11's "Optimizations for windowed games". Read, never written.
    pub fn windowed_game_optimizations() -> Option<bool> {
        let settings = registry_value(
            HKEY_CURRENT_USER,
            "Software\\Microsoft\\DirectX\\UserGpuPreferences",
            "DirectXUserGlobalSettings",
        )?;
        settings
            .split(';')
            .find_map(|part| part.trim().strip_prefix("SwapEffectUpgradeEnable="))
            .map(|value| value.trim() == "1")
    }
}

#[cfg(not(windows))]
mod platform {
    use super::Foreground;
    pub fn foreground() -> Option<Foreground> {
        None
    }
    pub fn window_alive(_: isize, _: u32) -> bool {
        false
    }
    pub fn d3d_fullscreen_in_front() -> bool {
        false
    }
    pub fn fullscreen_optimizations_disabled(_: &str) -> bool {
        false
    }
    pub fn windowed_game_optimizations() -> Option<bool> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn front(covers: bool, framed: bool) -> WindowFacts {
        WindowFacts {
            covers_monitor: covers,
            framed,
            ..WindowFacts::default()
        }
    }

    #[test]
    fn direct3d_fullscreen_is_fullscreen() {
        assert_eq!(
            classify(front(true, false), true),
            Some(DisplayMode::Fullscreen)
        );
    }

    #[test]
    fn a_frameless_window_over_the_monitor_is_borderless() {
        assert_eq!(
            classify(front(true, false), false),
            Some(DisplayMode::Borderless)
        );
    }

    #[test]
    fn big_or_small_ordinary_windows_are_not_games() {
        assert_eq!(
            classify(front(true, true), false),
            None,
            "maximised with a title bar"
        );
        assert_eq!(classify(front(false, false), false), None);
    }

    #[test]
    fn compatibility_entries_match_by_exe_name_and_exact_flag() {
        let path = "C:/Games/PUBG/TslGame/Binaries/Win64/TslGame.exe";
        assert!(layer_disables_fso(
            path,
            "~ DISABLEDXMAXIMIZEDWINDOWEDMODE",
            "tslgame.exe"
        ));
        assert!(layer_disables_fso(
            path,
            "~ HIGHDPIAWARE disabledxmaximizedwindowedmode",
            "TslGame.exe"
        ));
        assert!(!layer_disables_fso(path, "~ HIGHDPIAWARE", "TslGame.exe"));
        assert!(!layer_disables_fso(
            path,
            "~ DISABLEDXMAXIMIZEDWINDOWEDMODE",
            "Aion2.exe"
        ));
    }

    #[test]
    fn our_windows_the_desktop_and_minimised_windows_say_nothing() {
        let mut ours = front(true, false);
        ours.ours = true;
        let mut shell = front(true, false);
        shell.shell = true;
        let mut minimized = front(true, false);
        minimized.minimized = true;
        for facts in [ours, shell, minimized] {
            assert_eq!(classify(facts, true), None);
        }
    }
}
