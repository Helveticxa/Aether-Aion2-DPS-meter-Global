//! The startup gate: everything that must be true before Aether can measure.
//!
//! Two ideas drive this module.
//!
//! First, a backend that *exists* is not a backend that *works*. Upstream
//! decided Npcap was present by loading `wpcap.dll`, which keeps succeeding
//! after the driver service is stopped or the adapter list goes empty -- the
//! splash would wave the user into an app that can never see a packet. Here the
//! probe talks to the driver.
//!
//! Second, not every failure deserves to stop anyone. Capture needs *one*
//! backend, not both, so WinDivert missing while Npcap works is a footnote, not
//! an alarm. [`Weight`] carries that distinction to the UI so the gate holds for
//! real problems and stays quiet about the rest.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::dps_meter::capture::capturer;
use crate::dps_meter::capture::windivert_capturer;

/// Set once the gate has opened, and never cleared.
///
/// A gate that only the splash screen honours is not a gate: the tray icon and
/// a second launch both surface the main window on their own. Everything that
/// can put the main window on screen consults this instead.
static PASSED: AtomicBool = AtomicBool::new(false);

pub fn passed() -> bool {
    PASSED.load(Ordering::Relaxed)
}

pub fn mark_passed() {
    PASSED.store(true, Ordering::Relaxed);
}

/// Which check a row reports on. The frontend keys its icons and fix buttons
/// off this rather than off the label, so labels stay free to be reworded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckId {
    Elevation,
    Npcap,
    Windivert,
}

/// Whether a failing check stops startup.
///
/// Computed per report, not fixed per check: Npcap is required only while
/// WinDivert cannot stand in for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Weight {
    Required,
    Optional,
}

/// The remedy offered for a failing check. `None` means there is nothing the
/// app can usefully do on the operator's behalf.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Fix {
    /// Download and launch the official Npcap installer.
    InstallNpcap,
    /// The bundled driver file is gone; only a reinstall puts it back.
    ReinstallAether,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: CheckId,
    pub label: &'static str,
    /// One sentence, always populated -- on success too, so the row says
    /// something more useful than "Available".
    pub detail: String,
    pub ok: bool,
    pub weight: Weight,
    pub fix: Option<Fix>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// True when nothing required is failing. The gate opens on this alone.
    pub ready: bool,
    /// One line for the header: what is being waited on, or that all is well.
    pub summary: String,
    pub checks: Vec<Check>,
}

/// True when every required check passes. Optional checks never gate.
fn is_ready(checks: &[Check]) -> bool {
    checks
        .iter()
        .all(|check| check.ok || check.weight == Weight::Optional)
}

fn summarise(checks: &[Check]) -> String {
    let blocking: Vec<&str> = checks
        .iter()
        .filter(|check| !check.ok && check.weight == Weight::Required)
        .map(|check| check.label)
        .collect();

    match blocking.as_slice() {
        [] => "Everything Aether needs is in place.".to_string(),
        [one] => format!("{one} has to be sorted out before the meter can run."),
        many => format!(
            "{} have to be sorted out before the meter can run.",
            many.join(" and ")
        ),
    }
}

/// Whether `WinDivert64.sys` is absent from the install directory.
///
/// Tauri drops it next to the executable, so its absence means something
/// removed it after installation rather than a packaging mistake.
fn windivert_file_missing() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("WinDivert64.sys")))
        .map(|sys| !sys.exists())
        .unwrap_or(false)
}

/// Build the report. Pure assembly once the probes have run, so the weighting
/// rules stay testable on a machine with no capture driver at all.
fn assemble(
    elevated: bool,
    npcap: Result<usize, String>,
    windivert: Option<String>,
    windivert_file_missing: bool,
) -> Report {
    let windivert_ok = windivert.is_none();
    let npcap_ok = npcap.is_ok();

    let elevation = Check {
        id: CheckId::Elevation,
        label: "Administrator rights",
        detail: if elevated {
            "Running elevated, which packet capture requires.".to_string()
        } else {
            "Aether is not running as Administrator. Capture drivers cannot be opened without it \
             -- close Aether and start it again."
                .to_string()
        },
        ok: elevated,
        weight: Weight::Required,
        fix: None,
    };

    let npcap = Check {
        id: CheckId::Npcap,
        label: "Npcap",
        detail: match &npcap {
            Ok(count) => format!(
                "Installed and answering -- {count} network adapter{} visible.",
                if *count == 1 { "" } else { "s" }
            ),
            Err(error) => error.clone(),
        },
        ok: npcap_ok,
        // Preferred backend, but capture needs only one of the two.
        weight: if windivert_ok {
            Weight::Optional
        } else {
            Weight::Required
        },
        fix: if npcap_ok {
            None
        } else {
            Some(Fix::InstallNpcap)
        },
    };

    let windivert = Check {
        id: CheckId::Windivert,
        label: "WinDivert",
        detail: match &windivert {
            None => "Bundled driver loaded, available as a fallback.".to_string(),
            Some(error) if windivert_file_missing => format!(
                "{error}. The bundled driver file is missing from the install folder, which \
                 usually means antivirus quarantined it."
            ),
            Some(error) => error.clone(),
        },
        ok: windivert_ok,
        // Always optional: it exists to cover Npcap, never to become a
        // requirement of its own. When both are down, Npcap carries the
        // blocking weight, because Npcap is the one Aether can install.
        weight: Weight::Optional,
        fix: if windivert_ok || !windivert_file_missing {
            None
        } else {
            Some(Fix::ReinstallAether)
        },
    };

    let checks = vec![elevation, npcap, windivert];
    Report {
        ready: is_ready(&checks),
        summary: summarise(&checks),
        checks,
    }
}

/// `None` when the question could not be answered.
///
/// The distinction matters because this check can lock the user out: there is
/// no fix button for it, only Quit. A failed API call is this code's problem,
/// not the machine's, and the manifest already makes Windows refuse to launch
/// Aether unelevated -- so an unanswerable query is treated as elevated. Only a
/// query that succeeds and says "no" holds the gate closed.
#[cfg(windows)]
fn query_elevated() -> Option<bool> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = Default::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;

        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let queried = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut std::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
        .is_ok();
        let _ = CloseHandle(token);

        queried.then(|| elevation.TokenIsElevated != 0)
    }
}

#[cfg(not(windows))]
fn query_elevated() -> Option<bool> {
    Some(true)
}

/// Named and separate so the fail-open decision above is visible to anyone
/// tempted to "tighten" it into a lock-out.
fn resolve_elevation(queried: Option<bool>) -> bool {
    queried.unwrap_or(true)
}

fn is_elevated() -> bool {
    resolve_elevation(query_elevated())
}

/// Run every check and weigh the results.
pub fn run() -> Report {
    let status = windivert_capturer::check_windivert_status();
    let windivert = if status.available {
        None
    } else {
        Some(
            status
                .error
                .unwrap_or_else(|| "WinDivert could not be opened".to_string()),
        )
    };

    assemble(
        is_elevated(),
        capturer::probe_npcap(),
        windivert,
        windivert_file_missing(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failing(report: &Report, weight: Weight) -> Vec<CheckId> {
        report
            .checks
            .iter()
            .filter(|check| check.weight == weight && !check.ok)
            .map(|check| check.id)
            .collect()
    }

    #[test]
    fn a_missing_windivert_does_not_gate_when_npcap_works() {
        // The case that prompted this module: Npcap fine, WinDivert absent, and
        // the old screen put an amber warning next to "starting...".
        let report = assemble(
            true,
            Ok(4),
            Some("WinDivert64.sys was not found".into()),
            true,
        );

        assert!(report.ready);
        assert!(failing(&report, Weight::Required).is_empty());
        assert_eq!(failing(&report, Weight::Optional), vec![CheckId::Windivert]);
    }

    #[test]
    fn losing_both_backends_gates_on_npcap() {
        let report = assemble(
            true,
            Err("wpcap.dll not found".into()),
            Some("no driver".into()),
            false,
        );

        assert!(!report.ready);
        assert_eq!(failing(&report, Weight::Required), vec![CheckId::Npcap]);
        assert_eq!(
            report.checks[1].fix,
            Some(Fix::InstallNpcap),
            "the blocking row must offer the one fix Aether can perform"
        );
    }

    #[test]
    fn windivert_alone_is_enough_to_start() {
        let report = assemble(true, Err("wpcap.dll not found".into()), None, false);

        assert!(report.ready, "one working backend is the whole requirement");
    }

    #[test]
    fn losing_elevation_gates_on_its_own() {
        let report = assemble(false, Ok(4), None, false);

        assert!(!report.ready);
        assert_eq!(failing(&report, Weight::Required), vec![CheckId::Elevation]);
    }

    #[test]
    fn a_quarantined_driver_offers_a_reinstall_but_still_does_not_gate() {
        let report = assemble(true, Ok(1), Some("WinDivert64.sys was not found".into()), true);

        assert!(report.ready);
        assert_eq!(report.checks[2].fix, Some(Fix::ReinstallAether));
        assert!(report.checks[2].detail.contains("antivirus"));
    }

    #[test]
    fn a_driver_present_but_blocked_offers_no_reinstall() {
        // Error 1275, say: the file is there, so putting it back changes nothing.
        let report = assemble(true, Ok(1), Some("blocked by security software".into()), false);

        assert_eq!(report.checks[2].fix, None);
        assert!(!report.checks[2].detail.contains("antivirus"));
    }

    #[test]
    fn an_unanswerable_elevation_query_does_not_lock_anyone_out() {
        // This check has no fix button, so a false negative traps the user on a
        // screen whose only other control is Quit.
        assert!(resolve_elevation(None));
        assert!(resolve_elevation(Some(true)));
        assert!(!resolve_elevation(Some(false)));
    }

    #[test]
    fn the_summary_names_what_is_blocking() {
        let ready = assemble(true, Ok(2), None, false);
        assert!(ready.summary.contains("in place"));

        let blocked = assemble(false, Err("gone".into()), Some("gone".into()), false);
        assert!(blocked.summary.contains("Administrator rights"));
        assert!(blocked.summary.contains("Npcap"));
        assert!(
            !blocked.summary.contains("WinDivert"),
            "optional failures never appear in the blocking summary"
        );
    }
}
