mod dps_meter;
mod plugins;

use tauri::{Manager, RunEvent};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_window_state::StateFlags;

#[tauri::command]
fn update_tray_menu(
    app: tauri::AppHandle,
    show_text: String,
    quit_text: String,
) -> Result<(), String> {
    plugins::system_tray::update_tray_menu(&app, &show_text, &quit_text)
}

#[tauri::command]
fn show_system_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|error| error.to_string())
}

/// Delete what removed features left in app data. An update installs over the
/// old copy without running its uninstaller, so nothing else ever would.
///
/// `maps/` held the optional full-resolution map tiles (tens of MB per zone)
/// and a dataset override; the map was removed in 2.2.0.
fn remove_retired_app_data(app: &tauri::AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let maps = dir.join("maps");
    if maps.is_dir() {
        match std::fs::remove_dir_all(&maps) {
            Ok(()) => eprintln!("[startup] removed retired map data at {}", maps.display()),
            Err(error) => eprintln!("[startup] could not remove {}: {error}", maps.display()),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .with_filter(|label| {
                    !(matches!(label, "splashscreen" | "dps-overlay-pvp")
                    // Chat pop-ups are placed from the Always on top page,
                    // which remembers where; restoring a title bar left on
                    // mid-move would be wrong.
                    || label.starts_with(plugins::on_top::chat::LABEL_PREFIX))
                })
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch focuses what is already running -- which, while
            // the startup gate is still holding, is the gate and not the app.
            plugins::system_tray::show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(plugins::logger::init())
        .plugin(plugins::shortcut::global_shortcut_plugin())
        .plugin(plugins::shortcut::init())
        .plugin(plugins::system_tray::init())
        .plugin(plugins::aion2_overlay::init())
        .plugin(plugins::aion2_focus::init())
        .plugin(plugins::window_tracking::init())
        .plugin(plugins::on_top::init())
        .plugin(plugins::game_display::init())
        .invoke_handler(tauri::generate_handler![
            update_tray_menu,
            show_system_notification,
            plugins::system_tray::quit_application,
            plugins::logger::get_app_logger_debug_enabled,
            plugins::logger::set_app_logger_debug_enabled,
            plugins::logger::read_app_log_tail,
            dps_meter::api::commands::apply_dps_meter_config,
            dps_meter::api::commands::get_dps_meter_config,
            dps_meter::api::commands::start_dps_meter,
            dps_meter::api::commands::get_dps_snapshot,
            dps_meter::api::commands::get_pvp_watch_info,
            dps_meter::api::commands::get_pvp_combat_stats,
            dps_meter::api::commands::clear_pvp_combat_stats,
            dps_meter::api::commands::get_dps_meter_status,
            dps_meter::api::commands::get_region_status,
            dps_meter::api::commands::reset_region_observations,
            dps_meter::api::commands::get_connection_status,
            dps_meter::api::commands::get_personal_best,
            dps_meter::api::commands::list_personal_bests,
            dps_meter::api::commands::reset_personal_bests,
            dps_meter::api::commands::start_packet_recording,
            dps_meter::api::commands::stop_packet_recording,
            dps_meter::api::commands::get_packet_recording_status,
            dps_meter::api::commands::list_packet_recordings,
            dps_meter::api::commands::replay_packet_recording,
            dps_meter::api::commands::cancel_packet_replay,
            dps_meter::api::commands::is_packet_replaying,
            dps_meter::api::commands::get_diagnostics_report,
            dps_meter::api::commands::save_diagnostics_report,
            dps_meter::api::commands::get_opcode_census,
            dps_meter::api::commands::set_opcode_census_enabled,
            dps_meter::api::commands::reset_opcode_census,
            dps_meter::api::commands::reset_dps_meter,
            dps_meter::api::commands::stop_dps_meter,
            dps_meter::api::commands::check_dps_meter_state,
            dps_meter::api::commands::get_tcp_reassembly_status,
            dps_meter::api::commands::get_last_snapshot,
            dps_meter::api::commands::get_history,
            dps_meter::api::commands::delete_all_history,
            dps_meter::api::commands::delete_history_record,
            dps_meter::api::commands::delete_history_records,
            dps_meter::api::commands::check_npcap_available,
            dps_meter::api::commands::run_preflight,
            dps_meter::api::commands::enter_app,
            dps_meter::api::commands::install_npcap,
            plugins::aion2_overlay::create_dps_overlay,
            plugins::aion2_overlay::destroy_dps_overlay,
            plugins::aion2_overlay::create_pvp_overlay,
            plugins::aion2_overlay::create_dps_history,
            plugins::aion2_overlay::toggle_dps_overlay_locked,
            plugins::aion2_overlay::set_dps_overlay_locked,
            plugins::aion2_overlay::get_dps_overlay_locked,
            plugins::aion2_overlay::create_dps_log,
            plugins::aion2_overlay::create_dps_detail,
            plugins::aion2_overlay::create_dps_settings,
            plugins::window_tracking::ensure_tracked_window,
            plugins::aion2_overlay::get_overlay_config,
            plugins::aion2_overlay::set_overlay_config,
            plugins::aion2_overlay::get_language,
            plugins::aion2_overlay::set_language,
            plugins::aion2_overlay::get_detail_selection,
            plugins::aion2_overlay::set_detail_selection,
            plugins::aion2_focus::set_dps_manual_hidden,
            plugins::aion2_focus::set_auto_hide_enabled,
            plugins::aion2_focus::set_dps_always_on_top,
            plugins::shortcut::sync_shortcuts,
            plugins::shortcut::get_shortcut_failures,
            plugins::on_top::on_top_detect,
            plugins::on_top::on_top_windows,
            plugins::on_top::on_top_pin,
            plugins::on_top::on_top_set_opacity,
            plugins::on_top::on_top_set_ghost,
            plugins::on_top::on_top_snap,
            plugins::on_top::on_top_focus,
            plugins::on_top::on_top_set_hidden,
            plugins::on_top::on_top_unpin_all,
            plugins::on_top::on_top_launch,
            plugins::on_top::chat::chat_resolve,
            plugins::on_top::chat::chat_apply,
            plugins::on_top::chat::chat_overlay_init,
            plugins::on_top::chat::chat_close,
            plugins::on_top::chat::chat_close_all,
            plugins::on_top::chat::chat_style,
            plugins::on_top::chat::chat_set_ghost,
            plugins::on_top::chat::chat_set_hidden,
            plugins::on_top::chat::chat_set_adjusting,
            plugins::on_top::chat::chat_snap,
            plugins::on_top::chat::chat_status,
            plugins::game_display::get_game_display_status,
            plugins::game_display::open_graphics_settings,
        ])
        .setup(|app| {
            let logger = app
                .state::<std::sync::Arc<plugins::logger::AppLogger>>()
                .inner()
                .clone();
            remove_retired_app_data(app.handle());
            let meter = dps_meter::engine::meter::DpsMeter::new(app.handle().clone(), logger);
            app.manage(meter);
            Ok(())
        });

    // Only enable updater in release mode
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Browser windows we pinned belong to someone else's process; they
        // must not stay on top, see-through, or unclickable once we are gone.
        if let RunEvent::Exit = event {
            plugins::on_top::restore_all();
            // The meter stops on ExitRequested; this covers any other way out.
            #[cfg(windows)]
            dps_meter::capture::windivert_capturer::unload_driver();
            return;
        }
        if let RunEvent::ExitRequested { api, .. } = event {
            if let Some(state) = app_handle.try_state::<plugins::system_tray::AppLifecycleState>() {
                if !plugins::system_tray::should_allow_exit(state) {
                    api.prevent_exit();
                } else if let Some(meter) =
                    app_handle.try_state::<dps_meter::engine::meter::DpsMeter>()
                {
                    meter.stop_dps_meter();
                }
            }
        }
    });
}
