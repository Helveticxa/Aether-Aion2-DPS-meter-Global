pub mod aion2_focus;
pub mod aion2_overlay;
pub mod game_display;
pub mod logger;
pub mod on_top;
pub mod process_names;
pub mod shortcut;
pub mod system_tray;
pub mod window_tracking;

// Window classes of Aether's own windows (they matter on Windows only). Every
// window but the DPS overlay has one of its own, so OBS's Window Capture,
// which falls back to a window of the same class when the title it saved is
// not on screen, can never land on them instead of the meter. The main window
// and the startup gate take "AetherApp" from tauri.conf.json. See
// `aion2_overlay::create_dps_overlay`.
pub const OWN_WINDOW_CLASS_PANEL: &str = "AetherPanel";
pub const OWN_WINDOW_CLASS_PVP: &str = "AetherPvp";
pub const OWN_WINDOW_CLASS_CHAT: &str = "AetherChat";
