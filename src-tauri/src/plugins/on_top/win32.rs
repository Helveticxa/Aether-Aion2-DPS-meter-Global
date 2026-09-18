//! The Win32 half of "always on top": enumerating browser windows, and changing
//! their z-order, layering, and placement from outside their process.
//!
//! Three rules hold throughout, because these are someone else's windows:
//!
//! - **Never block on the browser.** Placement goes through
//!   `SWP_ASYNCWINDOWPOS` and `ShowWindowAsync`, which post to the window's
//!   thread instead of waiting on it, and a hung window is left alone.
//! - **Record before changing.** [`capture_original`] is taken at pin time and
//!   is what [`restore_original`] puts back.
//! - **Never activate.** Everything uses the no-activate variants, so pinning a
//!   window never pulls focus away from the game.

use std::{
    collections::HashMap,
    ffi::{c_void, OsString},
    mem::size_of,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use windows::{
    core::{BOOL, PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, COLORREF, ERROR_SUCCESS, HANDLE, HWND, LPARAM, RECT},
        Graphics::{
            Dwm::{
                DwmGetWindowAttribute, DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CLOAKED,
                DWMWA_EXTENDED_FRAME_BOUNDS,
            },
            Gdi::{
                GetMonitorInfoW, MonitorFromWindow, RedrawWindow, MONITORINFO,
                MONITOR_DEFAULTTONEAREST, RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE,
            },
        },
        Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
        System::{
            Registry::{
                RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, REG_ROUTINE_FLAGS,
                RRF_RT_REG_SZ, RRF_SUBKEY_WOW6432KEY,
            },
            Threading::{
                CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess,
                InitializeProcThreadAttributeList, OpenProcess, OpenProcessToken,
                QueryFullProcessImageNameW, UpdateProcThreadAttribute, CREATE_UNICODE_ENVIRONMENT,
                EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
                PROCESS_CREATE_PROCESS, PROCESS_INFORMATION, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS,
                STARTUPINFOEXW,
            },
        },
        UI::{
            HiDpi::GetDpiForWindow,
            WindowsAndMessaging::{
                AllowSetForegroundWindow, EnumWindows, GetAncestor, GetClassNameW,
                GetForegroundWindow, GetShellWindow, GetWindow, GetWindowLongPtrW, GetWindowRect,
                GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
                GetLayeredWindowAttributes, IsHungAppWindow, IsIconic, IsWindow, IsWindowVisible,
                IsZoomed, SetForegroundWindow, SetLayeredWindowAttributes, SetWindowLongPtrW,
                SetWindowPos, ShowWindowAsync, ASFW_ANY, GA_ROOT, GWL_EXSTYLE, GW_OWNER,
                HWND_NOTOPMOST, HWND_TOPMOST, LAYERED_WINDOW_ATTRIBUTES_FLAGS, LWA_ALPHA,
                SET_WINDOW_POS_FLAGS, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE,
                SWP_NOSIZE, SWP_NOZORDER, SW_RESTORE, SW_SHOWMINNOACTIVE, SW_SHOWNOACTIVATE,
                WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
            },
        },
    },
};

use super::browsers::BrowserId;
use super::{Corner, SizePreset};

/// Chromium's top-level window class, for Chrome and Edge alike.
const CHROMIUM_WINDOW_CLASS: &str = "Chrome_WidgetWin_1";

/// `DWMWA_COLOR_DEFAULT`: hand the border back to the system.
const BORDER_DEFAULT: u32 = 0xFFFF_FFFF;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    fn width(&self) -> i32 {
        self.right - self.left
    }
    fn height(&self) -> i32 {
        self.bottom - self.top
    }
}

impl From<RECT> for Rect {
    fn from(r: RECT) -> Self {
        Self {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RawWindow {
    pub hwnd: isize,
    pub pid: u32,
    pub browser: BrowserId,
    pub raw_title: String,
    pub minimized: bool,
    /// What DWM draws, without the invisible resize border.
    pub frame: Rect,
    pub monitor: Rect,
}

/// A window's own layering and z-order before we touched it.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Original {
    pub topmost: bool,
    pub layered: bool,
    pub transparent: bool,
    /// `(key, alpha, flags)` from `GetLayeredWindowAttributes`, when it was
    /// already layered.
    pub layered_attributes: Option<(u32, u8, u32)>,
}

fn hwnd(raw: isize) -> HWND {
    HWND(raw as *mut c_void)
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn wide_os(text: &std::ffi::OsStr) -> Vec<u16> {
    text.encode_wide().chain(Some(0)).collect()
}

// =============================================================================
// Reading
// =============================================================================

/// Every visible top-level window belonging to a supported browser, in z-order
/// (front first).
pub fn browser_windows(include_untitled: bool) -> Vec<RawWindow> {
    unsafe extern "system" fn collect(window: HWND, lparam: LPARAM) -> BOOL {
        let list = unsafe { &mut *(lparam.0 as *mut Vec<isize>) };
        list.push(window.0 as isize);
        BOOL(1)
    }

    let mut handles: Vec<isize> = Vec::new();
    let _ = unsafe { EnumWindows(Some(collect), LPARAM(&mut handles as *mut _ as isize)) };

    let mut owners: HashMap<u32, Option<BrowserId>> = HashMap::new();
    handles
        .into_iter()
        .filter_map(|raw| describe(raw, include_untitled, &mut owners))
        .collect()
}

fn describe(
    raw: isize,
    include_untitled: bool,
    owners: &mut HashMap<u32, Option<BrowserId>>,
) -> Option<RawWindow> {
    let window = hwnd(raw);
    unsafe {
        if !IsWindowVisible(window).as_bool() {
            return None;
        }
        // Owned windows are menus, bubbles, and dialogs -- never a page.
        if GetWindow(window, GW_OWNER).is_ok() {
            return None;
        }
    }
    if ex_style(raw) & WS_EX_TOOLWINDOW.0 != 0 || is_cloaked(raw) {
        return None;
    }
    if class_name(raw) != CHROMIUM_WINDOW_CLASS {
        return None;
    }

    let pid = window_pid(raw)?;
    let browser = (*owners.entry(pid).or_insert_with(|| {
        process_name(pid).and_then(|name| BrowserId::from_exe_name(&name))
    }))?;

    let raw_title = window_text(raw);
    if raw_title.is_empty() && !include_untitled {
        return None;
    }

    let minimized = unsafe { IsIconic(window).as_bool() };
    let frame = frame_bounds(raw);
    // Chromium keeps a few invisible helper windows of this class; a page is
    // never smaller than this.
    if !minimized && (frame.width() < 64 || frame.height() < 48) {
        return None;
    }

    Some(RawWindow {
        hwnd: raw,
        pid,
        browser,
        raw_title,
        minimized,
        frame,
        monitor: monitor_rects(raw).0,
    })
}

/// The browser a top-level window belongs to, if it is a browser window at all.
pub fn window_browser(raw: isize) -> Option<(BrowserId, u32)> {
    let mut owners = HashMap::new();
    describe(raw, true, &mut owners).map(|window| (window.browser, window.pid))
}

pub fn is_alive(raw: isize, pid: u32) -> bool {
    let exists = unsafe { IsWindow(Some(hwnd(raw))).as_bool() };
    exists && window_pid(raw) == Some(pid)
}

pub fn is_minimized(raw: isize) -> bool {
    unsafe { IsIconic(hwnd(raw)).as_bool() }
}

/// Maximised, fullscreen, or simply sized to cover (nearly) the whole work area.
pub fn fills_screen(raw: isize) -> bool {
    if unsafe { IsZoomed(hwnd(raw)).as_bool() } {
        return true;
    }
    if is_minimized(raw) {
        return false;
    }
    let frame = frame_bounds(raw);
    let (_, work) = monitor_rects(raw);
    let area = |r: &Rect| (r.width().max(0) as i64) * (r.height().max(0) as i64);
    area(&work) > 0 && area(&frame) * 10 >= area(&work) * 9
}

pub fn is_topmost(raw: isize) -> bool {
    ex_style(raw) & WS_EX_TOPMOST.0 != 0
}

pub fn has_layering(raw: isize, click_through: bool) -> bool {
    let ex = ex_style(raw);
    ex & WS_EX_LAYERED.0 != 0 && (!click_through || ex & WS_EX_TRANSPARENT.0 != 0)
}

/// The top-level window the user is in.
pub fn foreground_root() -> Option<isize> {
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.0.is_null() {
            return None;
        }
        let root = GetAncestor(foreground, GA_ROOT);
        let root = if root.0.is_null() { foreground } else { root };
        Some(root.0 as isize)
    }
}

fn ex_style(raw: isize) -> u32 {
    unsafe { GetWindowLongPtrW(hwnd(raw), GWL_EXSTYLE) as u32 }
}

fn window_pid(raw: isize) -> Option<u32> {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd(raw), Some(&mut pid)) };
    (pid != 0).then_some(pid)
}

fn class_name(raw: isize) -> String {
    let mut buffer = [0u16; 128];
    let len = unsafe { GetClassNameW(hwnd(raw), &mut buffer) };
    String::from_utf16_lossy(&buffer[..len.max(0) as usize])
}

/// Reads the title without sending `WM_GETTEXT`, so a hung window cannot
/// stall the caller.
fn window_text(raw: isize) -> String {
    let window = hwnd(raw);
    let len = unsafe { GetWindowTextLengthW(window) };
    if len <= 0 {
        return String::new();
    }
    let mut buffer = vec![0u16; len as usize + 1];
    let copied = unsafe { GetWindowTextW(window, &mut buffer) };
    String::from_utf16_lossy(&buffer[..copied.max(0) as usize])
}

/// Windows on another virtual desktop, or suspended UWP frames, are cloaked:
/// "visible" to the API, invisible to the person.
fn is_cloaked(raw: isize) -> bool {
    let mut cloaked = 0u32;
    unsafe {
        DwmGetWindowAttribute(
            hwnd(raw),
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut c_void,
            size_of::<u32>() as u32,
        )
    }
    .is_ok()
        && cloaked != 0
}

fn window_rect(raw: isize) -> Rect {
    let mut rect = RECT::default();
    let _ = unsafe { GetWindowRect(hwnd(raw), &mut rect) };
    rect.into()
}

fn frame_bounds(raw: isize) -> Rect {
    let mut rect = RECT::default();
    let ok = unsafe {
        DwmGetWindowAttribute(
            hwnd(raw),
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut c_void,
            size_of::<RECT>() as u32,
        )
    }
    .is_ok();
    if ok {
        rect.into()
    } else {
        window_rect(raw)
    }
}

/// `(whole monitor, work area)` of the monitor the window is on.
fn monitor_rects(raw: isize) -> (Rect, Rect) {
    unsafe {
        let monitor = MonitorFromWindow(hwnd(raw), MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            (info.rcMonitor.into(), info.rcWork.into())
        } else {
            (Rect::default(), Rect::default())
        }
    }
}

fn process_name(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = vec![0u16; 1024];
        let mut len = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(process);
        result.ok()?;
        let path = String::from_utf16_lossy(&buffer[..len as usize]);
        Path::new(&path)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
    }
}

/// The default value of `App Paths\<exe>`: per user, per machine, then the
/// 32-bit view of the machine hive.
pub fn read_app_path(exe: &str) -> Option<PathBuf> {
    let subkey = wide(&format!(
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{exe}"
    ));
    let lookups = [
        (HKEY_CURRENT_USER, RRF_RT_REG_SZ),
        (HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ),
        (HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ | RRF_SUBKEY_WOW6432KEY),
    ];
    lookups.into_iter().find_map(|(root, flags)| {
        let value = registry_string(root, &subkey, flags)?;
        let path = value.trim().trim_matches('"').trim();
        (!path.is_empty()).then(|| PathBuf::from(path))
    })
}

fn registry_string(root: HKEY, subkey: &[u16], flags: REG_ROUTINE_FLAGS) -> Option<String> {
    unsafe {
        let mut size = 0u32;
        let status = RegGetValueW(
            root,
            PCWSTR(subkey.as_ptr()),
            PCWSTR::null(),
            flags,
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
            PCWSTR::null(),
            flags,
            None,
            Some(buffer.as_mut_ptr() as *mut c_void),
            Some(&mut size),
        );
        if status != ERROR_SUCCESS {
            return None;
        }
        let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..len]))
    }
}

pub fn is_elevated() -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut TOKEN_ELEVATION as *mut c_void),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
}

// =============================================================================
// Changing
// =============================================================================

pub fn capture_original(raw: isize) -> Original {
    let ex = ex_style(raw);
    let layered = ex & WS_EX_LAYERED.0 != 0;
    let layered_attributes = layered
        .then(|| {
            let mut key = COLORREF(0);
            let mut alpha = 0u8;
            let mut flags = LAYERED_WINDOW_ATTRIBUTES_FLAGS(0);
            unsafe {
                GetLayeredWindowAttributes(
                    hwnd(raw),
                    Some(&mut key),
                    Some(&mut alpha),
                    Some(&mut flags),
                )
            }
            .ok()
            .map(|_| (key.0, alpha, flags.0))
        })
        .flatten();

    Original {
        topmost: ex & WS_EX_TOPMOST.0 != 0,
        layered,
        transparent: ex & WS_EX_TRANSPARENT.0 != 0,
        layered_attributes,
    }
}

pub fn set_topmost(raw: isize, topmost: bool) -> Result<(), String> {
    let window = hwnd(raw);
    let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;
    unsafe {
        if topmost {
            return SetWindowPos(window, Some(HWND_TOPMOST), 0, 0, 0, 0, flags)
                .map_err(|e| e.to_string());
        }

        SetWindowPos(window, Some(HWND_NOTOPMOST), 0, 0, 0, 0, flags).map_err(|e| e.to_string())?;

        // HWND_NOTOPMOST parks the window at the top of the normal band --
        // above whatever the person is looking at, which is usually Aether's
        // own window with the Unpin button in it. Tuck it just behind that
        // window instead. Never behind a topmost one: that would make it
        // topmost again.
        if let Some(foreground) = foreground_root() {
            if foreground != raw && !is_topmost(foreground) {
                let _ = SetWindowPos(window, Some(hwnd(foreground)), 0, 0, 0, 0, flags);
            }
        }
        Ok(())
    }
}

/// Opacity and click-through. Both need `WS_EX_LAYERED`; click-through adds
/// `WS_EX_TRANSPARENT`, which on a layered top-level window makes the mouse
/// pass to whatever is underneath.
pub fn apply_layering(
    raw: isize,
    opacity_percent: u8,
    click_through: bool,
    original: &Original,
) -> Result<(), String> {
    let window = hwnd(raw);
    let before = ex_style(raw);
    let dimmed = opacity_percent < 100;
    let want_layered = original.layered || dimmed || click_through;
    let want_transparent = original.transparent || click_through;

    let mut after = before;
    set_bit(&mut after, WS_EX_LAYERED.0, want_layered);
    set_bit(&mut after, WS_EX_TRANSPARENT.0, want_transparent);

    if after != before {
        // Changing a style sends the window WM_STYLECHANGING synchronously.
        if unsafe { IsHungAppWindow(window).as_bool() } {
            return Err("the window is not responding".into());
        }
        unsafe { SetWindowLongPtrW(window, GWL_EXSTYLE, after as i32 as isize) };
    }

    if want_layered {
        // A layered window without attributes is not drawn at all, so these
        // follow the style change immediately.
        let (key, alpha, flags) = match (dimmed, original.layered_attributes) {
            (false, Some(attributes)) => attributes,
            _ => (0, percent_to_alpha(opacity_percent), LWA_ALPHA.0),
        };
        unsafe {
            SetLayeredWindowAttributes(
                window,
                COLORREF(key),
                alpha,
                LAYERED_WINDOW_ATTRIBUTES_FLAGS(flags),
            )
        }
        .map_err(|e| e.to_string())?;
    } else if before & WS_EX_LAYERED.0 != 0 {
        // Dropping the layered style frees its redirection surface; the window
        // then has to be asked to paint again.
        unsafe {
            let _ = RedrawWindow(
                Some(window),
                None,
                None,
                RDW_ERASE | RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN,
            );
        }
    }
    Ok(())
}

fn set_bit(value: &mut u32, bit: u32, on: bool) {
    if on {
        *value |= bit;
    } else {
        *value &= !bit;
    }
}

fn percent_to_alpha(percent: u8) -> u8 {
    ((percent.min(100) as u32 * 255 + 50) / 100) as u8
}

/// Put back everything [`capture_original`] recorded.
pub fn restore_original(raw: isize, original: &Original) {
    let _ = apply_layering(raw, 100, false, original);
    if !original.topmost {
        let _ = set_topmost(raw, false);
    }
}

/// Hand a window's Windows 11 border back to the system.
///
/// Pinned windows are no longer recoloured: the browser should look like
/// itself. 0.1.14 did colour them amber or cyan, though, and a window it
/// pinned before a crash can still be wearing that colour, so crash recovery
/// clears it. Nothing else calls this. Windows 10 has no such attribute; the
/// call fails there and nothing changes.
pub fn clear_border(raw: isize) {
    let value = BORDER_DEFAULT;
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd(raw),
            DWMWA_BORDER_COLOR,
            &value as *const u32 as *const c_void,
            size_of::<u32>() as u32,
        );
    }
}

/// Move a window into a corner of its monitor's work area at a preset size.
pub fn snap(raw: isize, corner: Corner, size: SizePreset, topmost: bool) -> Result<(), String> {
    let window = hwnd(raw);
    unsafe {
        // A maximised or minimised window has to become a normal one first,
        // or its placement is not ours to set. Wait briefly for that to land:
        // the invisible-border maths below needs the restored geometry.
        if IsIconic(window).as_bool() || IsZoomed(window).as_bool() {
            let _ = ShowWindowAsync(window, SW_SHOWNOACTIVATE);
            let deadline = Instant::now() + Duration::from_millis(500);
            while (IsIconic(window).as_bool() || IsZoomed(window).as_bool())
                && Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    }

    let scale = (unsafe { GetDpiForWindow(window) }.max(96)) as f64 / 96.0;
    let (_, work) = monitor_rects(raw);
    if work.width() <= 0 || work.height() <= 0 {
        return Err("could not read the monitor's work area".into());
    }

    let margin = (16.0 * scale).round() as i32;
    let (logical_w, logical_h) = size.logical();
    let width = ((logical_w as f64 * scale).round() as i32).min(work.width() - margin * 2);
    let height = ((logical_h as f64 * scale).round() as i32).min(work.height() - margin * 2);

    let (x, y) = match corner {
        Corner::TopLeft => (work.left + margin, work.top + margin),
        Corner::TopRight => (work.right - margin - width, work.top + margin),
        Corner::BottomLeft => (work.left + margin, work.bottom - margin - height),
        Corner::BottomRight => (work.right - margin - width, work.bottom - margin - height),
    };

    // SetWindowPos places the outer rectangle, which on Windows 10 and 11
    // includes an invisible resize border on three sides. Without this the
    // window lands a few pixels short of the edge it was aimed at.
    let outer = window_rect(raw);
    let frame = frame_bounds(raw);
    let inset = |value: i32| value.clamp(0, 32);
    let (left, top) = (inset(frame.left - outer.left), inset(frame.top - outer.top));
    let (right, bottom) = (inset(outer.right - frame.right), inset(outer.bottom - frame.bottom));

    let mut flags: SET_WINDOW_POS_FLAGS = SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;
    let insert_after = if topmost {
        Some(HWND_TOPMOST)
    } else {
        flags |= SWP_NOZORDER;
        None
    };

    unsafe {
        SetWindowPos(
            window,
            insert_after,
            x - left,
            y - top,
            width + left + right,
            height + top + bottom,
            flags,
        )
    }
    .map_err(|e| e.to_string())
}

pub fn minimize(raw: isize) {
    unsafe {
        let _ = ShowWindowAsync(hwnd(raw), SW_SHOWMINNOACTIVE);
    }
}

pub fn show_without_activating(raw: isize) {
    unsafe {
        let _ = ShowWindowAsync(hwnd(raw), SW_SHOWNOACTIVATE);
    }
}

pub fn focus(raw: isize) {
    let window = hwnd(raw);
    unsafe {
        if IsIconic(window).as_bool() {
            let _ = ShowWindowAsync(window, SW_RESTORE);
        }
        let _ = SetForegroundWindow(window);
    }
}

// =============================================================================
// Launching
// =============================================================================

/// Start the browser as the person at the desktop, not as Aether.
///
/// Aether runs elevated for packet capture, and a child inherits its token. A
/// browser running as Administrator is both a security problem and a practical
/// one: every later non-elevated launch tries to hand its URL to the elevated
/// instance, is refused by UIPI, and fails. So when elevated, the process is
/// created with the shell (Explorer) as its parent through
/// `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`, which makes it inherit the shell's
/// ordinary token -- documented behaviour, not a trick.
pub fn launch(exe: &Path, args: &[String]) -> Result<(), String> {
    unsafe {
        // Let the browser bring its new window forward; the person just asked
        // for it.
        let _ = AllowSetForegroundWindow(ASFW_ANY);
    }

    if is_elevated() {
        match launch_as_shell_child(exe, args) {
            Ok(()) => return Ok(()),
            Err(error) => {
                // Never fall back to a direct launch here: that would start
                // the browser elevated.
                eprintln!("[on-top] could not launch through the shell: {error}");
                return Err(format!(
                    "Could not start {} as a normal user: {error}",
                    exe.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
                ));
            }
        }
    }

    let mut command = Command::new(exe);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(dir) = exe.parent() {
        command.current_dir(dir);
    }
    for (key, _) in std::env::vars_os() {
        if is_private_variable(&key) {
            command.env_remove(key);
        }
    }
    command.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Aether's WebView2 configuration travels in environment variables. The
/// browser should start with the person's environment, not with ours.
fn is_private_variable(key: &OsString) -> bool {
    key.to_string_lossy().to_ascii_uppercase().starts_with("WEBVIEW2_")
}

fn launch_as_shell_child(exe: &Path, args: &[String]) -> Result<(), String> {
    let mut command_line = wide_os(&command_line(exe, args));
    let current_dir = exe.parent().map(|dir| wide_os(dir.as_os_str()));
    let environment = environment_block();

    unsafe {
        let shell = GetShellWindow();
        if shell.0.is_null() {
            return Err("no desktop shell is running".into());
        }
        let mut shell_pid = 0u32;
        GetWindowThreadProcessId(shell, Some(&mut shell_pid));
        if shell_pid == 0 {
            return Err("could not identify the desktop shell".into());
        }
        let parent = OpenProcess(PROCESS_CREATE_PROCESS, false, shell_pid)
            .map_err(|e| format!("opening the shell process: {e}"))?;

        let result = (|| {
            let mut size = 0usize;
            // Sizing call: expected to fail with ERROR_INSUFFICIENT_BUFFER.
            let _ = InitializeProcThreadAttributeList(None, 1, None, &mut size);
            let mut buffer = vec![0u8; size.max(64)];
            let list = LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr() as *mut c_void);
            InitializeProcThreadAttributeList(Some(list), 1, None, &mut size)
                .map_err(|e| e.to_string())?;

            let parent_handle = parent;
            let created = UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_PARENT_PROCESS as usize,
                Some(&parent_handle as *const HANDLE as *const c_void),
                size_of::<HANDLE>(),
                None,
                None,
            )
            .and_then(|_| {
                let mut startup = STARTUPINFOEXW::default();
                startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
                startup.lpAttributeList = list;
                let mut process = PROCESS_INFORMATION::default();
                CreateProcessW(
                    PCWSTR::null(),
                    Some(PWSTR(command_line.as_mut_ptr())),
                    None,
                    None,
                    false,
                    EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                    Some(environment.as_ptr() as *const c_void),
                    current_dir
                        .as_ref()
                        .map_or(PCWSTR::null(), |dir| PCWSTR(dir.as_ptr())),
                    &startup.StartupInfo,
                    &mut process,
                )
                .map(|_| {
                    let _ = CloseHandle(process.hThread);
                    let _ = CloseHandle(process.hProcess);
                })
            });

            DeleteProcThreadAttributeList(list);
            drop(buffer);
            created.map_err(|e| e.to_string())
        })();

        let _ = CloseHandle(parent);
        result
    }
}

/// `"C:\...\chrome.exe" "--app=https://..." "--profile-directory=Profile 1"`,
/// quoted by the rules `CommandLineToArgvW` reads them back with.
fn command_line(exe: &Path, args: &[String]) -> OsString {
    let mut line = OsString::from("\"");
    line.push(exe.as_os_str());
    line.push("\"");
    for arg in args {
        line.push(" ");
        line.push(quote_argument(arg));
    }
    line
}

fn quote_argument(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(backslashes));
                quoted.push(c);
                backslashes = 0;
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

/// Our environment minus Aether's private variables, as the sorted,
/// double-terminated UTF-16 block `CreateProcessW` expects.
fn environment_block() -> Vec<u16> {
    let mut variables: Vec<(OsString, OsString)> = std::env::vars_os()
        .filter(|(key, _)| !is_private_variable(key))
        .collect();
    variables.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());

    let mut block = Vec::new();
    for (key, value) in variables {
        block.extend(key.encode_wide());
        block.push('=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_arguments_like_command_line_to_argv() {
        assert_eq!(quote_argument("--app=https://youtube.com"), "--app=https://youtube.com");
        assert_eq!(
            quote_argument("--profile-directory=Profile 1"),
            "\"--profile-directory=Profile 1\""
        );
        assert_eq!(quote_argument(r#"a"b"#), r#""a\"b""#);
        assert_eq!(quote_argument(r"C:\dir with space\"), r#""C:\dir with space\\""#);
    }

    #[test]
    fn alpha_rounds_to_the_nearest_step() {
        assert_eq!(percent_to_alpha(100), 255);
        assert_eq!(percent_to_alpha(50), 128);
        assert_eq!(percent_to_alpha(20), 51);
    }
}
