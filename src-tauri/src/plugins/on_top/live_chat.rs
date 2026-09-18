//! A YouTube live chat overlay: the chat alone, over the game, with no
//! background behind it -- the look stream overlays use.
//!
//! This one is not a pinned browser window. A browser cannot make its page
//! background see-through while keeping the text solid; lowering a window's
//! opacity fades the words along with everything else. So this is Aether's own
//! transparent window, loading YouTube's popout chat and restyling it with
//! `live_chat.js`. Reading a public chat needs no sign-in, which is why the
//! browser's session does not matter here.
//!
//! The page gets no access to Aether: it is a remote origin with no
//! capability, navigation is held to the chat page, and popups are refused.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    webview::NewWindowResponse, AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize,
    Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use super::{platform, Corner, SizePreset};

pub const LABEL: &str = "aion2-live-chat";
const CHANGED_EVENT: &str = "live-chat-changed";
const INJECT: &str = include_str!("live_chat.js");

/// How the chat is drawn. Plain data: it is serialised into the page script.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatStyle {
    pub font_size: u8,
    pub avatars: bool,
    /// A soft dark band behind each message, for bright scenes.
    pub backdrop: bool,
    /// "Live chat" (everything) rather than YouTube's default "Top chat".
    pub all_messages: bool,
}

impl ChatStyle {
    fn clamped(mut self) -> Self {
        self.font_size = self.font_size.clamp(11, 32);
        self
    }
}

impl Default for ChatStyle {
    fn default() -> Self {
        Self {
            font_size: 15,
            avatars: true,
            backdrop: false,
            all_messages: true,
        }
    }
}

/// Physical pixels, as the window reports them.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct PhysicalRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPlacement {
    pub corner: Corner,
    pub size: SizePreset,
    /// Where the player last put it by hand, if they did.
    pub rect: Option<PhysicalRect>,
}

struct ChatState {
    video_id: Option<String>,
    ghost: bool,
    adjusting: bool,
    hidden: bool,
    style: Option<ChatStyle>,
}

static STATE: Mutex<ChatState> = Mutex::new(ChatState {
    video_id: None,
    ghost: true,
    adjusting: false,
    hidden: false,
    style: None,
});

fn state() -> std::sync::MutexGuard<'static, ChatState> {
    STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStatus {
    open: bool,
    video_id: Option<String>,
    ghost: bool,
    adjusting: bool,
    hidden: bool,
    rect: Option<PhysicalRect>,
}

/// Chat is tall and narrow: these are not the video presets.
fn chat_size(size: SizePreset) -> (i32, i32) {
    match size {
        SizePreset::Small => (320, 420),
        SizePreset::Medium => (380, 540),
        SizePreset::Large => (440, 680),
    }
}

// =============================================================================
// Finding the stream
// =============================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatSource {
    Video(String),
    /// A channel path such as `@handle` or `channel/UC...`, whose current
    /// stream is looked up.
    Channel(String),
}

fn is_video_id(text: &str) -> bool {
    text.len() == 11
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn is_channel_segment(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 100
        && text
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | '@'))
}

/// What someone pasted: a watch, live, Studio, or youtu.be link, a bare video
/// id, or a channel (`@handle`, a channel link).
pub fn parse_source(input: &str) -> Result<ChatSource, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("Paste a YouTube live link or a channel's @handle.".into());
    }
    if is_video_id(text) {
        return Ok(ChatSource::Video(text.to_string()));
    }
    if let Some(handle) = text.strip_prefix('@') {
        return if is_channel_segment(handle) {
            Ok(ChatSource::Channel(format!("@{handle}")))
        } else {
            Err("That handle has characters YouTube does not use.".into())
        };
    }

    let with_scheme = if text.contains("://") {
        text.to_string()
    } else {
        format!("https://{text}")
    };
    let url = Url::parse(&with_scheme).map_err(|_| "That is not a YouTube link.".to_string())?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let segments: Vec<&str> = url
        .path_segments()
        .map(|parts| parts.filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();

    let video = |id: &str| -> Result<ChatSource, String> {
        if is_video_id(id) {
            Ok(ChatSource::Video(id.to_string()))
        } else {
            Err("That link does not contain a valid video id.".into())
        }
    };

    if host == "youtu.be" {
        return segments
            .first()
            .map_or_else(|| Err("That link has no video in it.".into()), |id| video(id));
    }
    if host != "youtube.com" && !host.ends_with(".youtube.com") {
        return Err("That is not a YouTube link.".into());
    }

    if let Some((_, id)) = url.query_pairs().find(|(key, _)| key == "v") {
        return video(&id);
    }
    match segments.as_slice() {
        ["live" | "shorts" | "embed" | "video", id, ..] => video(id),
        [first, ..] if first.starts_with('@') && is_channel_segment(first) => {
            Ok(ChatSource::Channel(first.to_string()))
        }
        ["channel" | "c" | "user", name, ..] if is_channel_segment(name) => {
            Ok(ChatSource::Channel(format!("{}/{}", segments[0], name)))
        }
        _ => Err("Could not find a video or channel in that link.".into()),
    }
}

/// The video a channel is streaming right now: `/<channel>/live` answers with
/// the stream's watch page, whose canonical link carries the id.
async fn resolve_channel(path: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;
    let html = client
        .get(format!("https://www.youtube.com/{path}/live"))
        // Skip the EU consent interstitial, which has no canonical link.
        .header("Cookie", "SOCS=CAI; CONSENT=PENDING+987")
        .header("Accept-Language", "en")
        .send()
        .await
        .map_err(|e| format!("Could not reach YouTube: {e}"))?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    live_video_from_page(&html).ok_or_else(|| format!("{path} is not live right now."))
}

fn live_video_from_page(html: &str) -> Option<String> {
    const MARKER: &str = "<link rel=\"canonical\" href=\"https://www.youtube.com/watch?v=";
    let start = html.find(MARKER)? + MARKER.len();
    let id = html.get(start..start + 11)?;
    is_video_id(id).then(|| id.to_string())
}

/// The popout chat, with the overlay's settings in the fragment for the page
/// script to read.
fn chat_url(video_id: &str, style: &ChatStyle) -> Result<Url, String> {
    Url::parse(&format!(
        "https://www.youtube.com/live_chat?is_popout=1&dark_theme=1&v={video_id}#aether={}",
        super::percent_encode(&settings_json(style, false))
    ))
    .map_err(|e| e.to_string())
}

/// The chat page and YouTube's consent step only. A click on a name or a
/// link inside the chat goes nowhere rather than turning the overlay into a
/// browser.
fn navigation_allowed(url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    let youtube = host == "youtube.com" || host.ends_with(".youtube.com");
    youtube && (url.path().starts_with("/live_chat") || host.starts_with("consent."))
}

/// Numbers and booleans only, so it is safe inside a URL and a script.
fn settings_json(style: &ChatStyle, adjusting: bool) -> String {
    serde_json::json!({
        "fontSize": style.font_size,
        "avatars": style.avatars,
        "backdrop": style.backdrop,
        "allMessages": style.all_messages,
        "adjusting": adjusting,
    })
    .to_string()
}

// =============================================================================
// The window
// =============================================================================

fn window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(LABEL)
}

fn raw_hwnd<R: Runtime>(window: &WebviewWindow<R>) -> Option<isize> {
    window.hwnd().ok().map(|hwnd| hwnd.0 as isize)
}

fn notify<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(CHANGED_EVENT, ());
}

fn current_rect<R: Runtime>(window: &WebviewWindow<R>) -> Option<PhysicalRect> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(PhysicalRect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

fn place<R: Runtime>(window: &WebviewWindow<R>, placement: &ChatPlacement) -> Result<(), String> {
    if let Some(rect) = placement.rect {
        let right = rect.x + rect.width as i32;
        let bottom = rect.y + rect.height as i32;
        if rect.width >= 160 && rect.height >= 160 && platform::rect_visible(rect.x, rect.y, right, bottom) {
            window
                .set_size(PhysicalSize::new(rect.width, rect.height))
                .map_err(|e| e.to_string())?;
            return window
                .set_position(PhysicalPosition::new(rect.x, rect.y))
                .map_err(|e| e.to_string());
        }
    }
    let hwnd = raw_hwnd(window).ok_or_else(|| "The chat window has no handle.".to_string())?;
    platform::snap(hwnd, placement.corner, chat_size(placement.size), true)
}

/// A transparent window can still be clicked. Ghost makes it let every click
/// through to the game, except while it is being moved.
fn apply_click_through<R: Runtime>(window: &WebviewWindow<R>) {
    let (ghost, adjusting) = {
        let s = state();
        (s.ghost, s.adjusting)
    };
    let _ = window.set_ignore_cursor_events(ghost && !adjusting);
}

fn restyle<R: Runtime>(window: &WebviewWindow<R>) {
    let (style, adjusting) = {
        let s = state();
        (s.style.clone().unwrap_or_default(), s.adjusting)
    };
    let _ = window.eval(format!(
        "window.__aetherChat && window.__aetherChat.apply({})",
        settings_json(&style, adjusting)
    ));
}

pub fn set_ghost<R: Runtime>(app: &AppHandle<R>, ghost: bool) {
    state().ghost = ghost;
    if let Some(window) = window(app) {
        apply_click_through(&window);
    }
    notify(app);
}

pub fn is_open<R: Runtime>(app: &AppHandle<R>) -> bool {
    window(app).is_some()
}

pub fn ghost() -> bool {
    state().ghost
}

pub fn is_hidden() -> bool {
    state().hidden
}

pub fn set_hidden<R: Runtime>(app: &AppHandle<R>, hidden: bool) {
    let Some(window) = window(app) else {
        return;
    };
    state().hidden = hidden;
    let _ = if hidden { window.hide() } else { window.show() };
    notify(app);
}

fn reset_state() {
    let mut s = state();
    s.video_id = None;
    s.adjusting = false;
    s.hidden = false;
}

// =============================================================================
// Commands
// =============================================================================

#[tauri::command]
pub async fn live_chat_resolve(input: String) -> Result<String, String> {
    match parse_source(&input)? {
        ChatSource::Video(id) => Ok(id),
        ChatSource::Channel(path) => resolve_channel(&path).await,
    }
}

#[tauri::command]
pub async fn live_chat_open<R: Runtime>(
    app: AppHandle<R>,
    video_id: String,
    style: ChatStyle,
    ghost: bool,
    placement: ChatPlacement,
) -> Result<(), String> {
    if !is_video_id(&video_id) {
        return Err("That is not a YouTube video id.".into());
    }
    let style = style.clamped();

    {
        let mut s = state();
        s.video_id = Some(video_id.clone());
        s.ghost = ghost;
        s.adjusting = false;
        s.hidden = false;
        s.style = Some(style.clone());
    }

    let url = chat_url(&video_id, &style)?;

    // Already open: switch streams in place. The window keeps where the
    // player put it, and no second window with the same label is attempted
    // while the first is still being torn down.
    if let Some(existing) = window(&app) {
        existing.navigate(url).map_err(|e| e.to_string())?;
        apply_click_through(&existing);
        let _ = existing.show();
        notify(&app);
        return Ok(());
    }

    let (width, height) = chat_size(placement.size);
    let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(url))
        .title("Aether | Live chat")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .maximizable(false)
        .minimizable(false)
        .focused(false)
        .visible(false)
        .inner_size(width as f64, height as f64)
        .min_inner_size(220.0, 200.0)
        .initialization_script(INJECT)
        .on_navigation(navigation_allowed)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build()
        .map_err(|e| e.to_string())?;

    // Closed from its own title bar while being moved: forget it.
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            reset_state();
            notify(&handle);
        }
    });

    place(&window, &placement)?;
    apply_click_through(&window);
    window.show().map_err(|e| e.to_string())?;
    notify(&app);
    Ok(())
}

#[tauri::command]
pub fn live_chat_close<R: Runtime>(app: AppHandle<R>) {
    if let Some(window) = window(&app) {
        let _ = window.destroy();
    }
    reset_state();
    notify(&app);
}

#[tauri::command]
pub fn live_chat_style<R: Runtime>(app: AppHandle<R>, style: ChatStyle) {
    state().style = Some(style.clamped());
    if let Some(window) = window(&app) {
        restyle(&window);
    }
    notify(&app);
}

#[tauri::command]
pub fn live_chat_set_ghost<R: Runtime>(app: AppHandle<R>, ghost: bool) {
    set_ghost(&app, ghost);
}

#[tauri::command]
pub fn live_chat_set_hidden<R: Runtime>(app: AppHandle<R>, hidden: bool) {
    set_hidden(&app, hidden);
}

/// Moving mode: a title bar and borders to drag, clicks accepted, a dashed
/// outline to show the bounds. Leaving it returns where the window ended up,
/// so the page can remember it.
#[tauri::command]
pub fn live_chat_set_adjusting<R: Runtime>(
    app: AppHandle<R>,
    adjusting: bool,
) -> Result<Option<PhysicalRect>, String> {
    let window = window(&app).ok_or_else(|| "The live chat overlay is not open.".to_string())?;
    {
        let mut s = state();
        s.adjusting = adjusting;
        if adjusting && s.hidden {
            s.hidden = false;
        }
    }
    if adjusting {
        let _ = window.show();
    }
    window
        .set_decorations(adjusting)
        .map_err(|e| e.to_string())?;
    apply_click_through(&window);
    restyle(&window);
    if adjusting {
        let _ = window.set_focus();
    }
    notify(&app);
    Ok(if adjusting { None } else { current_rect(&window) })
}

#[tauri::command]
pub async fn live_chat_snap<R: Runtime>(
    app: AppHandle<R>,
    corner: Corner,
    size: SizePreset,
) -> Result<(), String> {
    let window = window(&app).ok_or_else(|| "The live chat overlay is not open.".to_string())?;
    let hwnd = raw_hwnd(&window).ok_or_else(|| "The chat window has no handle.".to_string())?;
    platform::snap(hwnd, corner, chat_size(size), true)?;
    notify(&app);
    Ok(())
}

#[tauri::command]
pub fn live_chat_status<R: Runtime>(app: AppHandle<R>) -> ChatStatus {
    let window = window(&app);
    let s = state();
    ChatStatus {
        open: window.is_some(),
        video_id: if window.is_some() { s.video_id.clone() } else { None },
        ghost: s.ghost,
        adjusting: s.adjusting,
        hidden: s.hidden,
        rect: window.as_ref().and_then(current_rect),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video(id: &str) -> Result<ChatSource, String> {
        Ok(ChatSource::Video(id.to_string()))
    }

    #[test]
    fn reads_every_kind_of_video_link() {
        let id = "wYM_8XBICas";
        for input in [
            id,
            "https://www.youtube.com/watch?v=wYM_8XBICas",
            "youtube.com/watch?v=wYM_8XBICas&t=10",
            "https://youtu.be/wYM_8XBICas",
            "https://www.youtube.com/live/wYM_8XBICas?si=abc",
            "https://studio.youtube.com/video/wYM_8XBICas/livestreaming",
            "https://studio.youtube.com/live_chat?is_popout=1&v=wYM_8XBICas",
            "https://www.youtube.com/live_chat?v=wYM_8XBICas",
            "https://m.youtube.com/watch?v=wYM_8XBICas",
        ] {
            assert_eq!(parse_source(input), video(id), "{input}");
        }
    }

    #[test]
    fn reads_channels() {
        assert_eq!(
            parse_source("@ForgeLabs_id"),
            Ok(ChatSource::Channel("@ForgeLabs_id".into()))
        );
        assert_eq!(
            parse_source("https://www.youtube.com/@ForgeLabs_id/streams"),
            Ok(ChatSource::Channel("@ForgeLabs_id".into()))
        );
        assert_eq!(
            parse_source("https://www.youtube.com/channel/UCabcdefghij0123456789ab"),
            Ok(ChatSource::Channel("channel/UCabcdefghij0123456789ab".into()))
        );
    }

    #[test]
    fn refuses_what_is_not_youtube() {
        assert!(parse_source("").is_err());
        assert!(parse_source("https://twitch.tv/somebody").is_err());
        assert!(parse_source("https://evil.example/watch?v=wYM_8XBICas").is_err());
        assert!(parse_source("https://www.youtube.com/watch?v=short").is_err());
        assert!(parse_source("@bad handle").is_err());
    }

    #[test]
    fn finds_the_live_video_on_a_channel_page() {
        let page = r#"<head><link rel="canonical" href="https://www.youtube.com/watch?v=wYM_8XBICas"></head>"#;
        assert_eq!(live_video_from_page(page), Some("wYM_8XBICas".into()));
        let offline = r#"<link rel="canonical" href="https://www.youtube.com/@someone">"#;
        assert_eq!(live_video_from_page(offline), None);
    }

    #[test]
    fn holds_navigation_to_the_chat() {
        let ok = |u: &str| navigation_allowed(&Url::parse(u).unwrap());
        assert!(ok("https://www.youtube.com/live_chat?v=wYM_8XBICas"));
        assert!(ok("https://consent.youtube.com/m?continue=x"));
        assert!(!ok("https://www.youtube.com/@someone"));
        assert!(!ok("https://www.youtube.com/watch?v=wYM_8XBICas"));
        assert!(!ok("https://accounts.google.com/"));
        assert!(!ok("https://evil.example/live_chat"));
    }

    #[test]
    fn settings_travel_in_the_fragment() {
        let url = chat_url("wYM_8XBICas", &ChatStyle::default()).unwrap();
        assert_eq!(url.path(), "/live_chat");
        assert!(url.query().unwrap().ends_with("v=wYM_8XBICas"));
        let fragment = url.fragment().unwrap();
        assert!(fragment.starts_with("aether=%7B"), "{fragment}");
        assert!(fragment.contains("fontSize%22%3A15"), "{fragment}");
    }

    #[test]
    fn font_size_is_kept_readable() {
        let tiny = ChatStyle { font_size: 2, ..ChatStyle::default() }.clamped();
        let huge = ChatStyle { font_size: 200, ..ChatStyle::default() }.clamped();
        assert_eq!((tiny.font_size, huge.font_size), (11, 32));
    }
}
