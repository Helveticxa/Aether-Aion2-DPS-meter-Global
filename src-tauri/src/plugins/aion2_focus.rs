use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime, State,
};

const AION2_PROCESS_NAME: &str = "Aion2.exe";
const DPS_OVERLAY_LABEL: &str = "dps-overlay";
const PVP_OVERLAY_LABEL: &str = "dps-overlay-pvp";
const FOLLOW_FOCUS_WINDOW_LABELS: [&str; 2] = [DPS_OVERLAY_LABEL, PVP_OVERLAY_LABEL];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Aion2FocusChangedPayload {
    focused: bool,
    process_name: Option<String>,
}

pub struct Aion2FocusState {
    dps_manual_hidden: AtomicBool,
    auto_hide_enabled: AtomicBool,
    dps_always_on_top: AtomicBool,
    /// The meter has no fight of yours to show, so the DPS overlay stays out
    /// of the way until the next one starts. Set by the meter, not the user.
    dps_idle_hidden: AtomicBool,
    /// Whether the game, or something counted as part of it, is in front.
    game_focused: AtomicBool,
}

impl Default for Aion2FocusState {
    fn default() -> Self {
        Self {
            dps_manual_hidden: AtomicBool::new(false),
            auto_hide_enabled: AtomicBool::new(true),
            dps_always_on_top: AtomicBool::new(false),
            dps_idle_hidden: AtomicBool::new(false),
            game_focused: AtomicBool::new(false),
        }
    }
}

impl Aion2FocusState {
    /// What a follow-focus window should be doing right now. `None` leaves it
    /// as it is.
    fn wanted_visibility(&self, label: &str, focused: bool) -> Option<bool> {
        let manual_hidden = self.dps_manual_hidden.load(Ordering::Relaxed);
        let follows_focus = self.auto_hide_enabled.load(Ordering::Relaxed)
            && !self.dps_always_on_top.load(Ordering::Relaxed);

        if label == DPS_OVERLAY_LABEL && self.dps_idle_hidden.load(Ordering::Relaxed) {
            return Some(false);
        }
        if manual_hidden {
            // Hidden from the hotkey: stays hidden until the hotkey says so.
            return if focused || !follows_focus {
                None
            } else {
                Some(false)
            };
        }
        if !follows_focus {
            // The window is not following the game. The DPS overlay still has
            // to come back when an idle spell ends; the PvP window is left be.
            return (label == DPS_OVERLAY_LABEL).then_some(true);
        }
        Some(focused)
    }
}

/// Show or hide a follow-focus window. Showing never activates it: the DPS
/// overlay comes back on the first hit of a fight, and taking the keyboard
/// from the game at that moment would be the worst possible time.
fn apply_visibility<R: Runtime>(window: &tauri::WebviewWindow<R>, show: bool) {
    let visible = window.is_visible().unwrap_or(false);
    if show == visible {
        return;
    }
    if show {
        let _ = window.set_focusable(false);
        let _ = window.show();
    } else {
        let _ = window.hide();
    }
}

fn sync_windows<R: Runtime>(app: &tauri::AppHandle<R>, state: &Aion2FocusState, focused: bool) {
    for label in FOLLOW_FOCUS_WINDOW_LABELS {
        if let Some(window) = app.get_webview_window(label) {
            if let Some(show) = state.wanted_visibility(label, focused) {
                apply_visibility(&window, show);
            }
        }
    }
}

#[tauri::command]
pub fn set_dps_manual_hidden(state: State<'_, Aion2FocusState>, hidden: bool) {
    state.dps_manual_hidden.store(hidden, Ordering::Relaxed);
}

pub fn set_dps_manual_hidden_for_app<R: Runtime>(app: &tauri::AppHandle<R>, hidden: bool) {
    if let Some(state) = app.try_state::<Aion2FocusState>() {
        state.dps_manual_hidden.store(hidden, Ordering::Relaxed);
    }
}

/// Called by the meter when the overlay has, or no longer has, a fight of
/// yours to show. Takes effect at once rather than on the next focus poll, so
/// the overlay is up for the first seconds of a fight.
///
/// The caller is usually the meter's snapshot thread, and window calls wait on
/// the event loop -- which joins that thread when the meter stops. So the
/// window work is posted to the event loop rather than done here, and the two
/// can never end up waiting on each other.
pub fn set_dps_idle_hidden_for_app<R: Runtime>(app: &tauri::AppHandle<R>, hidden: bool) {
    let Some(state) = app.try_state::<Aion2FocusState>() else {
        return;
    };
    if state.dps_idle_hidden.swap(hidden, Ordering::Relaxed) == hidden {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(state) = handle.try_state::<Aion2FocusState>() else {
            return;
        };
        if let Some(window) = handle.get_webview_window(DPS_OVERLAY_LABEL) {
            let focused = state.game_focused.load(Ordering::Relaxed);
            if let Some(show) = state.wanted_visibility(DPS_OVERLAY_LABEL, focused) {
                apply_visibility(&window, show);
            }
        }
    });
}

pub fn is_dps_idle_hidden<R: Runtime>(app: &tauri::AppHandle<R>) -> bool {
    app.try_state::<Aion2FocusState>()
        .map(|state| state.dps_idle_hidden.load(Ordering::Relaxed))
        .unwrap_or(false)
}

#[tauri::command]
pub fn set_auto_hide_enabled(state: State<'_, Aion2FocusState>, enabled: bool) {
    state.auto_hide_enabled.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
pub fn set_dps_always_on_top<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, Aion2FocusState>,
    enabled: bool,
) {
    state.dps_always_on_top.store(enabled, Ordering::Relaxed);
    if enabled {
        let focused = state.game_focused.load(Ordering::Relaxed);
        sync_windows(&app, &state, focused);
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("aion2-focus")
        .setup(|app, _api| {
            app.manage(Aion2FocusState::default());

            #[cfg(windows)]
            windows_impl::start(app.app_handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_dps_manual_hidden,
            set_auto_hide_enabled,
            set_dps_always_on_top
        ])
        .build()
}

#[cfg(windows)]
mod windows_impl {
    use std::{
        sync::{
            atomic::Ordering,
            mpsc::{self, Sender},
            Mutex, OnceLock,
        },
    };

    use tauri::{AppHandle, Emitter, Manager, Runtime};
    use windows::{
        Win32::{
            Foundation::HWND,
            UI::{
                Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
                WindowsAndMessaging::{
                    DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
                    TranslateMessage, EVENT_SYSTEM_FOREGROUND, MSG, WINEVENT_OUTOFCONTEXT,
                    WINEVENT_SKIPOWNPROCESS,
                },
            },
        },
    };

    use super::{
        sync_windows, Aion2FocusChangedPayload, Aion2FocusState, AION2_PROCESS_NAME,
        PVP_OVERLAY_LABEL,
    };

    static FOREGROUND_SENDER: OnceLock<Mutex<Option<Sender<isize>>>> = OnceLock::new();

    /// Whether `hwnd_raw` belongs to the game session: the game itself, one of
    /// our windows, or a browser window pinned over the game.
    fn is_game_session(hwnd_raw: isize) -> (bool, Option<String>) {
        let process_name = process_name_for_hwnd(hwnd_raw);
        let aion2_focused = process_name
            .as_deref()
            .map(|name| name.eq_ignore_ascii_case(AION2_PROCESS_NAME))
            .unwrap_or(false);
        // Any window of ours counts (settings, detail and log are opened from
        // the overlay mid-game), and so does a browser window pinned over the
        // game: clicking a video to pause it must not hide the meter.
        let focused = aion2_focused
            || foreground_belongs_to_current_app(hwnd_raw)
            || crate::plugins::on_top::is_managed(hwnd_raw);
        (focused, process_name)
    }

    pub fn start<R: Runtime>(app: AppHandle<R>) {
        let (tx, rx) = mpsc::channel::<isize>();
        let sender_slot = FOREGROUND_SENDER.get_or_init(|| Mutex::new(None));
        if let Ok(mut sender) = sender_slot.lock() {
            if sender.is_some() {
                return;
            }
            *sender = Some(tx.clone());
        } else {
            return;
        }

        let app_for_processor = app.clone();
        std::thread::spawn(move || {
            let mut last_focused: Option<bool> = None;

            while let Ok(hwnd_raw) = rx.recv() {
                let (focused, process_name) = is_game_session(hwnd_raw);

                // Any game in front, AION 2 or not, may cover what we keep
                // on top.
                crate::plugins::game_display::check(&app_for_processor);

                if last_focused == Some(focused) {
                    continue;
                }
                last_focused = Some(focused);

                let _ = app_for_processor.emit(
                    "aion2-focus-changed",
                    Aion2FocusChangedPayload {
                        focused,
                        process_name,
                    },
                );

                if let Some(state) = app_for_processor.try_state::<Aion2FocusState>() {
                    state.game_focused.store(focused, Ordering::Relaxed);
                    sync_windows(&app_for_processor, &state, focused);
                }
            }
        });

        std::thread::spawn(move || unsafe {
            let hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(handle_foreground_event),
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            );

            if hook.0.is_null() {
                clear_sender();
                return;
            }

            let initial_hwnd = GetForegroundWindow();
            send_hwnd(initial_hwnd);

            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).into() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }

            let _ = UnhookWinEvent(hook);
            clear_sender();
        });

        // Polling fallback: periodically verify window visibility matches the
        // actual foreground state. Nothing to check while no overlay is open.
        let app_for_poller = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(1));

            if !crate::plugins::aion2_overlay::is_dps_overlay_active()
                && app_for_poller.get_webview_window(PVP_OVERLAY_LABEL).is_none()
            {
                continue;
            }

            let hwnd = unsafe { GetForegroundWindow() };
            if hwnd.0.is_null() {
                continue;
            }
            let (focused, _) = is_game_session(hwnd.0 as isize);

            if let Some(state) = app_for_poller.try_state::<Aion2FocusState>() {
                state.game_focused.store(focused, Ordering::Relaxed);
                sync_windows(&app_for_poller, &state, focused);
            }
        });
    }

    unsafe extern "system" fn handle_foreground_event(
        _hook: HWINEVENTHOOK,
        _event: u32,
        hwnd: HWND,
        _object_id: i32,
        _child_id: i32,
        _event_thread: u32,
        _event_time: u32,
    ) {
        send_hwnd(hwnd);
    }

    fn send_hwnd(hwnd: HWND) {
        if hwnd.0.is_null() {
            return;
        }

        let Some(sender_slot) = FOREGROUND_SENDER.get() else {
            return;
        };
        let Ok(sender) = sender_slot.lock() else {
            return;
        };
        let Some(sender) = sender.as_ref() else {
            return;
        };

        let _ = sender.send(hwnd.0 as isize);
    }

    fn clear_sender() {
        if let Some(sender_slot) = FOREGROUND_SENDER.get() {
            if let Ok(mut sender) = sender_slot.lock() {
                *sender = None;
            }
        }
    }

    fn foreground_belongs_to_current_app(hwnd_raw: isize) -> bool {
        unsafe {
            let hwnd = HWND(hwnd_raw as *mut _);
            let mut process_id = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut process_id));
            process_id != 0 && process_id == std::process::id()
        }
    }

    /// The executable in front, read from a process snapshot: the game's
    /// process is never opened, since anti-cheat watches for exactly that.
    fn process_name_for_hwnd(hwnd_raw: isize) -> Option<String> {
        let mut process_id = 0u32;
        unsafe {
            GetWindowThreadProcessId(HWND(hwnd_raw as *mut _), Some(&mut process_id));
        }
        crate::plugins::process_names::exe_name(process_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(idle: bool, manual: bool, auto_hide: bool, always_on_top: bool) -> Aion2FocusState {
        let state = Aion2FocusState::default();
        state.dps_idle_hidden.store(idle, Ordering::Relaxed);
        state.dps_manual_hidden.store(manual, Ordering::Relaxed);
        state.auto_hide_enabled.store(auto_hide, Ordering::Relaxed);
        state.dps_always_on_top.store(always_on_top, Ordering::Relaxed);
        state
    }

    #[test]
    fn between_fights_the_meter_is_hidden_whatever_else_is_true() {
        for (manual, auto_hide, on_top, focused) in [
            (false, true, false, true),
            (false, false, false, true),
            (false, true, true, true),
            (true, true, false, false),
        ] {
            let s = state(true, manual, auto_hide, on_top);
            assert_eq!(s.wanted_visibility(DPS_OVERLAY_LABEL, focused), Some(false));
        }
    }

    #[test]
    fn idle_does_not_touch_the_pvp_window() {
        let s = state(true, false, true, false);
        assert_eq!(s.wanted_visibility(PVP_OVERLAY_LABEL, true), Some(true));
    }

    #[test]
    fn in_a_fight_the_meter_follows_the_game() {
        let s = state(false, false, true, false);
        assert_eq!(s.wanted_visibility(DPS_OVERLAY_LABEL, true), Some(true));
        assert_eq!(s.wanted_visibility(DPS_OVERLAY_LABEL, false), Some(false));
    }

    #[test]
    fn with_focus_following_off_a_fight_still_brings_the_meter_back() {
        let s = state(false, false, false, false);
        assert_eq!(s.wanted_visibility(DPS_OVERLAY_LABEL, false), Some(true));
        assert_eq!(s.wanted_visibility(PVP_OVERLAY_LABEL, false), None);
    }

    #[test]
    fn hidden_from_the_hotkey_stays_hidden_in_game() {
        let s = state(false, true, true, false);
        assert_eq!(s.wanted_visibility(DPS_OVERLAY_LABEL, true), None);
        assert_eq!(s.wanted_visibility(DPS_OVERLAY_LABEL, false), Some(false));
    }
}
