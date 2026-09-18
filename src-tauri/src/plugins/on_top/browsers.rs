//! Finding the browsers someone already has, and the profiles they sign in with.
//!
//! Everything here reads; nothing writes. Chrome and Edge keep the same
//! `Local State` layout (both are Chromium), so one parser serves both, and the
//! only per-browser knowledge is where each one installs and what it calls its
//! files.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Supported browsers, in order of preference. Chrome first, Edge second.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserId {
    Chrome,
    Edge,
}

impl BrowserId {
    pub const ALL: [BrowserId; 2] = [BrowserId::Chrome, BrowserId::Edge];

    pub fn exe_name(self) -> &'static str {
        match self {
            BrowserId::Chrome => "chrome.exe",
            BrowserId::Edge => "msedge.exe",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            BrowserId::Chrome => "Chrome",
            BrowserId::Edge => "Edge",
        }
    }

    pub fn from_exe_name(name: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|id| id.exe_name().eq_ignore_ascii_case(name))
    }

    /// `<LOCALAPPDATA>/...`, where the profiles live.
    fn user_data_suffix(self) -> &'static [&'static str] {
        match self {
            BrowserId::Chrome => &["Google", "Chrome", "User Data"],
            BrowserId::Edge => &["Microsoft", "Edge", "User Data"],
        }
    }

    /// Relative to a Program Files root or LOCALAPPDATA.
    fn install_suffix(self) -> &'static [&'static str] {
        match self {
            BrowserId::Chrome => &["Google", "Chrome", "Application", "chrome.exe"],
            BrowserId::Edge => &["Microsoft", "Edge", "Application", "msedge.exe"],
        }
    }

    /// The signed-in account's picture, which the browser caches per profile.
    fn avatar_file(self) -> &'static str {
        match self {
            BrowserId::Chrome => "Google Profile Picture.png",
            BrowserId::Edge => "Edge Profile Picture.png",
        }
    }

    /// What the browser appends to a normal window's title. App windows
    /// (`--app=`) carry the page title alone, which is how a freshly launched
    /// one is told apart from a restored session.
    pub fn title_suffixes(self) -> &'static [&'static str] {
        match self {
            BrowserId::Chrome => &[" - Google Chrome"],
            // Edge puts a zero-width space inside its own name.
            BrowserId::Edge => &[" - Microsoft\u{200b} Edge", " - Microsoft Edge"],
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfile {
    /// The directory name, e.g. `Default` or `Profile 3` -- what
    /// `--profile-directory` takes.
    pub dir: String,
    pub name: String,
    pub email: Option<String>,
    /// The profile's theme colour as `#rrggbb`, for an initial when there is
    /// no picture.
    pub color: Option<String>,
    /// A `data:image/png;base64,...` URL.
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    pub id: BrowserId,
    pub name: String,
    pub exe: String,
    pub version: Option<String>,
    pub profiles: Vec<BrowserProfile>,
    pub last_used_profile: Option<String>,
}

/// Every supported browser that is installed, in preference order.
pub fn detect_all() -> Vec<BrowserInfo> {
    BrowserId::ALL.into_iter().filter_map(detect).collect()
}

pub fn detect(id: BrowserId) -> Option<BrowserInfo> {
    let exe = find_exe(id)?;
    let version = version_from_install_dir(&exe);

    let (profiles, last_used_profile) = match user_data_dir(id) {
        Some(dir) => read_profiles(id, &dir),
        None => (Vec::new(), None),
    };

    Some(BrowserInfo {
        id,
        name: id.display_name().to_string(),
        exe: exe.to_string_lossy().to_string(),
        version,
        profiles,
        last_used_profile,
    })
}

/// Where the executable is. The registry's App Paths entry first -- the
/// installer writes it, per machine or per user -- then the standard install
/// locations, in case an installer skipped it.
pub fn find_exe(id: BrowserId) -> Option<PathBuf> {
    if let Some(path) = super::platform::read_app_path(id.exe_name()) {
        if path.is_file() {
            return Some(path);
        }
    }

    let roots = [
        std::env::var_os("ProgramFiles"),
        std::env::var_os("ProgramW6432"),
        std::env::var_os("ProgramFiles(x86)"),
        std::env::var_os("LOCALAPPDATA"),
    ];
    roots
        .into_iter()
        .flatten()
        .map(|root| join_all(Path::new(&root), id.install_suffix()))
        .find(|path| path.is_file())
}

pub fn user_data_dir(id: BrowserId) -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    let dir = join_all(Path::new(&local), id.user_data_suffix());
    dir.is_dir().then_some(dir)
}

fn join_all(root: &Path, parts: &[&str]) -> PathBuf {
    parts.iter().fold(root.to_path_buf(), |path, part| path.join(part))
}

/// Chromium installs beside a directory named after its version:
/// `Application/153.0.8010.50/`. Reading that avoids the version-resource API
/// and is what the browser's own updater relies on.
fn version_from_install_dir(exe: &Path) -> Option<String> {
    let dir = exe.parent()?;
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|name| parse_version(&name).map(|parts| (parts, name)))
        .max_by(|(a, _), (b, _)| a.cmp(b))
        .map(|(_, name)| name)
}

fn parse_version(name: &str) -> Option<Vec<u32>> {
    let parts: Vec<u32> = name
        .split('.')
        .map(|part| part.parse().ok())
        .collect::<Option<_>>()?;
    (parts.len() == 4).then_some(parts)
}

fn read_profiles(id: BrowserId, user_data: &Path) -> (Vec<BrowserProfile>, Option<String>) {
    let Ok(raw) = std::fs::read_to_string(user_data.join("Local State")) else {
        return (Vec::new(), None);
    };
    let Some(parsed) = parse_local_state(&raw) else {
        return (Vec::new(), None);
    };

    let profiles = parsed
        .profiles
        .into_iter()
        // The cache can outlive a profile deleted by hand.
        .filter(|profile| user_data.join(&profile.dir).is_dir())
        .map(|mut profile| {
            profile.avatar = read_avatar(&user_data.join(&profile.dir).join(id.avatar_file()));
            profile
        })
        .collect::<Vec<_>>();

    let last_used = parsed
        .last_used
        .filter(|dir| profiles.iter().any(|profile| &profile.dir == dir));

    (profiles, last_used)
}

fn read_avatar(path: &Path) -> Option<String> {
    // A profile picture is a few kilobytes. Anything large is not one.
    const LIMIT: u64 = 1024 * 1024;
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > LIMIT {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if !bytes.starts_with(b"\x89PNG") {
        return None;
    }
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

pub struct LocalState {
    pub profiles: Vec<BrowserProfile>,
    pub last_used: Option<String>,
}

/// The profile list out of a Chromium `Local State` file, in the order the
/// browser's own profile menu shows it.
pub fn parse_local_state(raw: &str) -> Option<LocalState> {
    let root: Value = serde_json::from_str(raw).ok()?;
    let profile = root.get("profile")?;
    let cache = profile.get("info_cache")?.as_object()?;

    let order: Vec<&str> = profile
        .get("profiles_order")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();

    let mut profiles: Vec<BrowserProfile> = cache
        .iter()
        .filter(|(_, info)| !flag(info, "is_ephemeral") && !flag(info, "is_omitted_from_profile_list"))
        .map(|(dir, info)| BrowserProfile {
            dir: dir.clone(),
            name: profile_name(dir, info),
            email: text(info, "user_name"),
            color: ["profile_highlight_color", "default_avatar_fill_color"]
                .iter()
                .find_map(|key| info.get(*key).and_then(Value::as_i64))
                .map(argb_to_hex),
            avatar: None,
        })
        .collect();

    profiles.sort_by(|a, b| {
        let rank = |dir: &str| order.iter().position(|item| *item == dir).unwrap_or(usize::MAX);
        rank(&a.dir)
            .cmp(&rank(&b.dir))
            .then_with(|| dir_sort_key(&a.dir).cmp(&dir_sort_key(&b.dir)))
    });

    Some(LocalState {
        profiles,
        last_used: text(profile, "last_used"),
    })
}

/// What the browser itself calls the profile. A profile still wearing its
/// generated name ("Person 1", "Profile 1") shows the account's name instead,
/// as the browser's own menu does.
fn profile_name(dir: &str, info: &Value) -> String {
    let own = text(info, "name");
    let account = text(info, "gaia_name").or_else(|| text(info, "gaia_given_name"));
    if flag(info, "is_using_default_name") {
        if let Some(account) = account {
            return account;
        }
    }
    own.or(account).unwrap_or_else(|| dir.to_string())
}

/// `Default` first, then `Profile 2` before `Profile 10`.
fn dir_sort_key(dir: &str) -> (u8, u32, String) {
    if dir == "Default" {
        return (0, 0, String::new());
    }
    let number = dir
        .rsplit(' ')
        .next()
        .and_then(|tail| tail.parse().ok())
        .unwrap_or(u32::MAX);
    (1, number, dir.to_string())
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Chromium stores colours as signed 32-bit ARGB.
fn argb_to_hex(value: i64) -> String {
    let argb = value as u32;
    format!("#{:06x}", argb & 0x00ff_ffff)
}

/// A window title without the browser's own decoration.
///
/// `Guide - YouTube - Google Chrome` becomes `Guide - YouTube`. Edge also
/// appends the profile and a tab count --
/// `Guide and 2 more pages - Work - Microsoft Edge` -- and both go, using the
/// profile names the browser reported.
pub fn clean_title(id: BrowserId, raw: &str, profile_names: &[String]) -> String {
    let mut title = raw.trim();

    for suffix in id.title_suffixes() {
        if let Some(index) = title.rfind(suffix) {
            title = title[..index].trim_end();
            break;
        }
    }

    for name in profile_names {
        let tail = format!(" - {name}");
        if let Some(stripped) = title.strip_suffix(tail.as_str()) {
            title = stripped.trim_end();
            break;
        }
    }

    // "and 2 more pages" / "and 1 more page"
    if let Some(index) = title.rfind(" and ") {
        let rest = &title[index + 5..];
        let mut words = rest.split(' ');
        let count_ok = words.next().is_some_and(|n| n.parse::<u32>().is_ok());
        let more_ok = words.next() == Some("more");
        let page_ok = matches!(words.next(), Some("page") | Some("pages"));
        if count_ok && more_ok && page_ok && words.next().is_none() {
            title = title[..index].trim_end();
        }
    }

    title.to_string()
}

/// Whether a raw title belongs to an app window rather than a tabbed one.
pub fn is_app_window_title(id: BrowserId, raw: &str) -> bool {
    !id.title_suffixes().iter().any(|suffix| raw.contains(suffix))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCAL_STATE: &str = r##"{
      "profile": {
        "last_used": "Profile 2",
        "profiles_order": ["Default", "Profile 2", "Profile 1"],
        "info_cache": {
          "Profile 1": { "name": "Work", "user_name": "work@example.com",
                         "profile_highlight_color": -16736064 },
          "Default":   { "name": "Person 1", "is_using_default_name": true,
                         "gaia_name": "Kapten", "user_name": "" },
          "Profile 2": { "name": "Gaming", "default_avatar_fill_color": -3355444 },
          "Profile 9": { "name": "Guest-ish", "is_ephemeral": true }
        }
      }
    }"##;

    #[test]
    fn parses_profiles_in_menu_order() {
        let state = parse_local_state(LOCAL_STATE).unwrap();
        let dirs: Vec<_> = state.profiles.iter().map(|p| p.dir.as_str()).collect();
        assert_eq!(dirs, ["Default", "Profile 2", "Profile 1"]);
        assert_eq!(state.last_used.as_deref(), Some("Profile 2"));
    }

    #[test]
    fn default_named_profile_shows_account_name() {
        let state = parse_local_state(LOCAL_STATE).unwrap();
        assert_eq!(state.profiles[0].name, "Kapten");
        // An empty user_name is no email at all.
        assert_eq!(state.profiles[0].email, None);
        assert_eq!(state.profiles[2].name, "Work");
        assert_eq!(state.profiles[2].email.as_deref(), Some("work@example.com"));
    }

    #[test]
    fn colours_become_hex() {
        let state = parse_local_state(LOCAL_STATE).unwrap();
        assert_eq!(state.profiles[2].color.as_deref(), Some("#00a0c0"));
        assert_eq!(state.profiles[1].color.as_deref(), Some("#cccccc"));
    }

    #[test]
    fn falls_back_to_natural_order_without_profiles_order() {
        let raw = r#"{"profile":{"info_cache":{
            "Profile 10":{"name":"c"},"Profile 2":{"name":"b"},"Default":{"name":"a"}}}}"#;
        let state = parse_local_state(raw).unwrap();
        let dirs: Vec<_> = state.profiles.iter().map(|p| p.dir.as_str()).collect();
        assert_eq!(dirs, ["Default", "Profile 2", "Profile 10"]);
    }

    #[test]
    fn rejects_files_that_are_not_local_state() {
        assert!(parse_local_state("{}").is_none());
        assert!(parse_local_state("not json").is_none());
    }

    #[test]
    fn cleans_chrome_titles() {
        assert_eq!(
            clean_title(BrowserId::Chrome, "Fire Temple guide - YouTube - Google Chrome", &[]),
            "Fire Temple guide - YouTube"
        );
        // App windows carry the page title alone.
        assert_eq!(clean_title(BrowserId::Chrome, "YouTube", &[]), "YouTube");
    }

    #[test]
    fn cleans_edge_titles() {
        let profiles = vec!["Work".to_string()];
        assert_eq!(
            clean_title(
                BrowserId::Edge,
                "Inbox and 2 more pages - Work - Microsoft\u{200b} Edge",
                &profiles
            ),
            "Inbox"
        );
        assert_eq!(
            clean_title(BrowserId::Edge, "Docs and 1 more page - Microsoft Edge", &profiles),
            "Docs"
        );
        // A page title that merely contains "and" keeps it.
        assert_eq!(
            clean_title(BrowserId::Edge, "Salt and pepper - Microsoft Edge", &profiles),
            "Salt and pepper"
        );
    }

    #[test]
    fn tells_app_windows_from_tabbed_ones() {
        assert!(is_app_window_title(BrowserId::Chrome, "YouTube"));
        assert!(!is_app_window_title(BrowserId::Chrome, "YouTube - Google Chrome"));
        assert!(!is_app_window_title(BrowserId::Edge, "Bing - Microsoft\u{200b} Edge"));
    }

    #[test]
    fn reads_versions_from_directory_names() {
        assert_eq!(parse_version("153.0.8010.50"), Some(vec![153, 0, 8010, 50]));
        assert_eq!(parse_version("SetupMetrics"), None);
        assert_eq!(parse_version("1.2.3"), None);
    }

    #[test]
    fn maps_process_names() {
        assert_eq!(BrowserId::from_exe_name("CHROME.EXE"), Some(BrowserId::Chrome));
        assert_eq!(BrowserId::from_exe_name("msedge.exe"), Some(BrowserId::Edge));
        assert_eq!(BrowserId::from_exe_name("firefox.exe"), None);
    }
}
