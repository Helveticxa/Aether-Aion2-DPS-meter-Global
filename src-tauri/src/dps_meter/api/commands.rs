use tauri::{AppHandle, Emitter, State};

use crate::dps_meter::capture::dispatcher::TcpReassemblyStatus;
use crate::dps_meter::capture::windivert_capturer::WinDivertStatus;
use crate::dps_meter::config::DpsMeterConfig;
use crate::dps_meter::engine::meter::DpsMeter;
use crate::dps_meter::history::HistoryRecord;
use crate::dps_meter::models::combat::{CombatSnapshot, PvpCombatStatsRow, PvpWatchInfoResponse};
use crate::dps_meter::models::diagnostics::DpsMeterState;
use crate::dps_meter::preflight;
use crate::dps_meter::capture::census::{self, CensusSnapshot};
use crate::dps_meter::capture::recorder::{RecordingFile, RecordingStatus};
use crate::dps_meter::region::{self, RegionStatus};
use crate::dps_meter::storage::data_storage::{BuffOverlayContext, FieldBossTimerSnapshot};

/// What [`install_npcap`] did, step by step, so a failure can be read off the
/// screen instead of guessed at.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NpcapInstallOutcome {
    /// Whether the official installer actually ran. False means Aether stopped
    /// before launching anything -- download or verification failed.
    pub launched: bool,
    pub steps: Vec<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub fn apply_dps_meter_config(
    meter: State<'_, DpsMeter>,
    config: DpsMeterConfig,
) -> Result<DpsMeterConfig, String> {
    Ok(meter.apply_config(config))
}

#[tauri::command]
pub fn get_dps_meter_config(meter: State<'_, DpsMeter>) -> Result<DpsMeterConfig, String> {
    Ok(meter.current_config())
}

#[tauri::command]
pub fn start_dps_meter(meter: State<'_, DpsMeter>) -> Result<(), String> {
    meter.start_dps_meter()
}

#[tauri::command]
pub fn get_dps_snapshot(meter: State<'_, DpsMeter>) -> Result<Option<CombatSnapshot>, String> {
    Ok(meter.get_dps_snapshot(0))
}

#[tauri::command]
pub fn get_pvp_watch_info(
    meter: State<'_, DpsMeter>,
    names: Vec<String>,
) -> Result<PvpWatchInfoResponse, String> {
    Ok(meter.get_pvp_watch_info(&names))
}

#[tauri::command]
pub fn get_pvp_combat_stats(meter: State<'_, DpsMeter>) -> Result<Vec<PvpCombatStatsRow>, String> {
    Ok(meter.get_pvp_combat_stats())
}

#[tauri::command]
pub fn clear_pvp_combat_stats(meter: State<'_, DpsMeter>) -> Result<(), String> {
    meter.clear_pvp_combat_stats();
    Ok(())
}

#[tauri::command]
pub fn get_buff_overlay_context(meter: State<'_, DpsMeter>) -> Result<BuffOverlayContext, String> {
    Ok(meter.get_buff_overlay_context())
}

#[tauri::command]
pub fn get_field_boss_timers(
    meter: State<'_, DpsMeter>,
) -> Result<Vec<FieldBossTimerSnapshot>, String> {
    Ok(meter.get_field_boss_timers())
}

/// One pasteable summary of everything worth knowing about a session.
///
/// Built for the global launch: rather than describing a screen over chat, copy
/// this and hand it over. It carries the region profile, what the capture
/// actually saw, and the opcode tally -- which together answer whether this
/// build understands the service it is pointed at.
#[tauri::command]
pub fn get_diagnostics_report(meter: State<'_, DpsMeter>) -> Result<String, String> {
    let region = region::status();
    let counts = census::snapshot();
    let recording = meter.packet_recording_status();

    let mut out = String::new();
    out.push_str("=== Aether diagnostics ===\n");
    out.push_str(&format!("version        {}\n", env!("CARGO_PKG_VERSION")));
    out.push_str(&format!("meter running  {}\n", meter.is_running()));
    out.push_str(&format!("replaying      {}\n", meter.is_replaying()));
    out.push_str(&format!(
        "recording      {}{}\n",
        recording.recording,
        if recording.packets > 0 {
            format!(" ({} packets, {} bytes)", recording.packets, recording.bytes)
        } else {
            String::new()
        }
    ));

    out.push_str("\n--- region ---\n");
    out.push_str(&format!("configured     {:?}\n", region.configured));
    out.push_str(&format!("detected       {:?}\n", region.detected));
    out.push_str(&format!("effective      {:?}\n", region.effective));
    out.push_str(&format!(
        "server names   {}\n",
        if region.server_names_available {
            "resolvable (ids match the bundled Taiwan catalogue)"
        } else {
            "not resolvable for these ids"
        }
    ));
    out.push_str(&format!(
        "server ips     {}\n",
        if region.observed_server_ips.is_empty() {
            "none observed".to_string()
        } else {
            region.observed_server_ips.join(", ")
        }
    ));
    out.push_str(&format!(
        "server ids     {}\n",
        if region.observed_server_ids.is_empty() {
            "none observed".to_string()
        } else {
            region
                .observed_server_ids
                .iter()
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        }
    ));

    out.push_str("\n--- opcode census ---\n");
    if !counts.enabled && counts.total_packets == 0 {
        out.push_str("disabled, nothing counted\n");
    } else {
        out.push_str(&format!(
            "enabled {} | total {} | known {} | unknown {}\n",
            counts.enabled, counts.total_packets, counts.known_packets, counts.unknown_packets
        ));
        out.push_str("opcode  known  count  payload\n");
        for stat in counts.opcodes.iter().take(40) {
            out.push_str(&format!(
                "{:6}  {:5}  {:5}  {}-{} B\n",
                stat.opcode,
                if stat.known { "yes" } else { "NO" },
                stat.count,
                stat.min_len,
                stat.max_len
            ));
        }
    }

    Ok(out)
}

/// Build the report and drop a copy on disk, returning both.
#[tauri::command]
pub fn save_diagnostics_report(meter: State<'_, DpsMeter>) -> Result<(String, String), String> {
    let report = get_diagnostics_report(meter.clone())?;
    let path = meter.save_diagnostics_report(&report)?;
    Ok((report, path))
}

/// Counts every dispatched opcode, recognised or not.
///
/// On an unfamiliar service this answers the only question that matters at
/// first: do the opcodes match the ones the parsers already handle? Off by
/// default -- it sits on the per-packet path.
#[tauri::command]
pub fn get_opcode_census() -> Result<CensusSnapshot, String> {
    Ok(census::snapshot())
}

#[tauri::command]
pub fn set_opcode_census_enabled(enabled: bool) -> Result<(), String> {
    census::set_enabled(enabled);
    Ok(())
}

#[tauri::command]
pub fn reset_opcode_census() -> Result<(), String> {
    census::reset();
    Ok(())
}

/// Recording captures a session's raw packets so a parser can be iterated
/// against them offline -- the difference between needing to be in game for
/// every attempt and needing to be there once.
#[tauri::command]
pub fn start_packet_recording(meter: State<'_, DpsMeter>) -> Result<String, String> {
    meter.start_packet_recording()
}

#[tauri::command]
pub fn stop_packet_recording(meter: State<'_, DpsMeter>) -> Result<Option<RecordingStatus>, String> {
    meter.stop_packet_recording()
}

#[tauri::command]
pub fn get_packet_recording_status(meter: State<'_, DpsMeter>) -> Result<RecordingStatus, String> {
    Ok(meter.packet_recording_status())
}

#[tauri::command]
pub fn list_packet_recordings(meter: State<'_, DpsMeter>) -> Result<Vec<RecordingFile>, String> {
    Ok(meter.list_packet_recordings())
}

/// Feed a recording back through the live pipeline. Runs on its own thread and
/// reports completion through the `packet-replay-finished` event.
#[tauri::command]
pub fn replay_packet_recording(meter: State<'_, DpsMeter>, path: String) -> Result<(), String> {
    meter.replay_packet_recording(path)
}

#[tauri::command]
pub fn cancel_packet_replay(meter: State<'_, DpsMeter>) -> Result<(), String> {
    meter.cancel_packet_replay();
    Ok(())
}

#[tauri::command]
pub fn is_packet_replaying(meter: State<'_, DpsMeter>) -> Result<bool, String> {
    Ok(meter.is_replaying())
}

/// Region profile in force, plus what the capture has actually observed.
///
/// The observations are the point: they are how an uncatalogued service (the
/// global servers, for one) gets characterised from a real session.
#[tauri::command]
pub fn get_region_status() -> Result<RegionStatus, String> {
    Ok(region::status())
}

#[tauri::command]
pub fn reset_region_observations() -> Result<(), String> {
    region::reset_observations();
    Ok(())
}

#[tauri::command]
pub fn get_dps_meter_status(meter: State<'_, DpsMeter>) -> Result<bool, String> {
    Ok(meter.is_running())
}

#[tauri::command]
pub fn reset_dps_meter(meter: State<'_, DpsMeter>) -> Result<(), String> {
    meter.reset_dps_meter(true);
    Ok(())
}

#[tauri::command]
pub fn stop_dps_meter(meter: State<'_, DpsMeter>) -> Result<(), String> {
    meter.stop_dps_meter();
    Ok(())
}

#[tauri::command]
pub fn check_dps_meter_state(meter: State<'_, DpsMeter>) -> Result<DpsMeterState, String> {
    Ok(meter.check_state())
}

#[tauri::command]
pub fn get_tcp_reassembly_status(
    meter: State<'_, DpsMeter>,
) -> Result<TcpReassemblyStatus, String> {
    Ok(meter.tcp_reassembly_status())
}

#[tauri::command]
pub fn get_last_snapshot(meter: State<'_, DpsMeter>) -> Option<CombatSnapshot> {
    meter.get_last_snapshot()
}

#[tauri::command]
pub fn delete_all_history(app: AppHandle, meter: State<'_, DpsMeter>) -> Result<usize, String> {
    let count = meter.delete_all_history();
    if count > 0 {
        let _ = app.emit("history-updated", ());
    }
    Ok(count)
}

#[tauri::command]
pub fn get_history(meter: State<'_, DpsMeter>) -> Result<Vec<HistoryRecord>, String> {
    Ok(meter.get_history())
}

#[tauri::command]
pub fn delete_history_record(
    app: AppHandle,
    meter: State<'_, DpsMeter>,
    id: String,
) -> Result<bool, String> {
    let deleted = meter.delete_history_record(&id);
    if deleted {
        let _ = app.emit("history-updated", ());
    }
    Ok(deleted)
}

#[tauri::command]
pub fn delete_history_records(
    app: AppHandle,
    meter: State<'_, DpsMeter>,
    ids: Vec<String>,
) -> Result<usize, String> {
    let deleted = meter.delete_history_records(&ids);
    if deleted > 0 {
        let _ = app.emit("history-updated", ());
    }
    Ok(deleted)
}

#[tauri::command]
pub fn mark_history_records_uploaded(
    app: AppHandle,
    meter: State<'_, DpsMeter>,
    ids: Vec<String>,
) -> Result<usize, String> {
    let updated = meter.mark_history_records_uploaded(&ids);
    if updated > 0 {
        let _ = app.emit("history-updated", ());
    }
    Ok(updated)
}

#[tauri::command]
pub fn check_npcap_available() -> Result<WinDivertStatus, String> {
    let mut status = crate::dps_meter::capture::windivert_capturer::check_windivert_status();
    if !status.available {
        match crate::dps_meter::capture::capturer::check_npcap_available() {
            Ok(()) => {
                status.available = true;
                status.error_code = None;
                status.error = None;
            }
            Err(npcap_error) => {
                status.error = Some(format!(
                    "{}; Npcap: {npcap_error}",
                    status
                        .error
                        .unwrap_or_else(|| "WinDivert unavailable".to_string())
                ));
            }
        }
    }
    Ok(status)
}

/// Everything the startup gate needs, in one call.
#[tauri::command]
pub fn run_preflight() -> Result<preflight::Report, String> {
    Ok(preflight::run())
}

/// Open the main window, but only if the checks still pass.
///
/// The decision lives here rather than in the gate's JavaScript so that it
/// cannot drift: the checks are re-run at the moment of entry, which costs
/// milliseconds and means a driver that died between the last check and the
/// click cannot let anyone through.
#[tauri::command]
pub fn enter_app(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;

    let report = preflight::run();
    if !report.ready {
        return Err(report.summary);
    }
    preflight::mark_passed();

    if let Some(main) = app.get_webview_window("main") {
        main.show().map_err(|error| error.to_string())?;
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    if let Some(gate) = app.get_webview_window("splashscreen") {
        let _ = gate.close();
    }

    Ok(())
}

/// Pinned to an exact build. The URL and the digest move together, in one
/// commit, so what Aether executes is always something a human chose.
const NPCAP_INSTALLER_URL: &str = "https://npcap.com/dist/npcap-1.88.exe";
const NPCAP_INSTALLER_SHA256: &str =
    "a2f4ec1e5ea353ff67efd24b2ebf081ba44532410fae8d5e146af0310aa4f56b";

/// Fetch the official Npcap installer, verify it, and run it.
///
/// Npcap reserves silent installation for its OEM licence, so the installer
/// shows its own window and the user clicks through it. Aether's part is to
/// remove the guesswork around it: fetch the right build, prove it is the right
/// build, and re-check on its own once the installer exits.
///
/// Verification is not ceremony. This downloads an executable and runs it with
/// the administrator rights Aether already holds, so the digest is what stands
/// between a hijacked download and a kernel driver of someone else's choosing.
#[tauri::command]
pub async fn install_npcap() -> Result<NpcapInstallOutcome, String> {
    use sha2::{Digest, Sha256};

    fn stop(steps: Vec<String>, error: String) -> Result<NpcapInstallOutcome, String> {
        Ok(NpcapInstallOutcome {
            launched: false,
            steps,
            error: Some(error),
        })
    }

    let mut steps = vec![format!("Downloading {NPCAP_INSTALLER_URL}")];

    let response = match reqwest::Client::new().get(NPCAP_INSTALLER_URL).send().await {
        Ok(response) => response,
        Err(error) => return stop(steps, format!("Download failed: {error}")),
    };
    if !response.status().is_success() {
        let status = response.status();
        return stop(steps, format!("Download failed: HTTP {status}"));
    }
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => return stop(steps, format!("Download failed: {error}")),
    };
    steps.push(format!("Downloaded {} bytes", bytes.len()));

    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != NPCAP_INSTALLER_SHA256 {
        steps.push("Checksum did not match".to_string());
        return stop(
            steps,
            format!(
                "The downloaded installer is not the build Aether expects \
                 (sha256 {digest}). Nothing was run. Install Npcap yourself from npcap.com."
            ),
        );
    }
    steps.push("Checksum verified against the pinned build".to_string());

    let path = std::env::temp_dir().join("aether-npcap-installer.exe");
    if let Err(error) = std::fs::write(&path, &bytes) {
        return stop(steps, format!("Could not write the installer: {error}"));
    }
    steps.push(format!("Saved to {}", path.display()));
    steps.push("Waiting for the Npcap installer to finish".to_string());

    // Blocking wait on a background thread: the installer is interactive and
    // takes as long as the user does.
    let launch_path = path.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new(&launch_path).status()
    })
    .await;

    // Best effort -- a leftover installer in %TEMP% is harmless.
    let _ = std::fs::remove_file(&path);

    match status {
        Ok(Ok(exit)) if exit.success() => {
            steps.push("Installer finished".to_string());
            Ok(NpcapInstallOutcome {
                launched: true,
                steps,
                error: None,
            })
        }
        Ok(Ok(exit)) => {
            // A non-zero code usually means the user cancelled. Not an error
            // worth shouting about; the re-check that follows tells the truth.
            steps.push(format!("Installer exited with code {:?}", exit.code()));
            Ok(NpcapInstallOutcome {
                launched: true,
                steps,
                error: Some(
                    "The installer closed without completing. Npcap was probably not installed."
                        .to_string(),
                ),
            })
        }
        Ok(Err(error)) => stop(steps, format!("Could not start the installer: {error}")),
        Err(error) => stop(steps, format!("Could not start the installer: {error}")),
    }
}

