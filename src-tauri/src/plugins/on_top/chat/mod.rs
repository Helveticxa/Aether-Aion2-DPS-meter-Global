//! Live chat overlays: YouTube and Twitch chat drawn over the game, one chat
//! per pop-up or several merged into one.
//!
//! Aether reads the chats itself and draws them in its own transparent
//! windows. Restyling each platform's chat page could not merge two of them
//! into one list, and ran a whole web application per pop-up. The pieces:
//!
//! - **Connectors**, one per chat (`youtube.rs`, `twitch.rs`), shared by every
//!   pop-up that shows that chat and stopped as soon as none does.
//! - **Pop-ups**, transparent windows running `overlay/chat/`, each showing one
//!   or more chats. Messages reach them as events addressed to that window.
//! - **This hub**, which connects the two and remembers the last messages of
//!   each chat so a new pop-up does not start empty.

pub mod message;
pub mod source;
mod twitch;
mod youtube;

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex, MutexGuard, OnceLock,
    },
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    async_runtime::JoinHandle, AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize,
    Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use self::message::{ChatEvent, ChatMessage};
use self::source::{Parsed, Platform, SourceSpec};
use super::{platform, Corner, SizePreset};

pub const LABEL_PREFIX: &str = "aion2-chat-";
const PAGE: &str = "src/games/aion2/overlay/chat/index.html";
const MAX_OVERLAYS: usize = 4;
const MAX_SOURCES_PER_OVERLAY: usize = 4;
/// Messages kept per chat, for a pop-up that opens mid-stream.
const RECENT: usize = 60;

// =============================================================================
// Types
// =============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceState {
    Connecting,
    Live,
    Ended,
    Error,
}

/// How chat is drawn. Shared by every pop-up.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatStyle {
    pub font_size: u8,
    pub avatars: bool,
    /// A soft dark band behind each message, for bright scenes.
    pub backdrop: bool,
    /// Fade a message out this many seconds after it arrives; 0 keeps them.
    #[serde(default)]
    pub fade_secs: u16,
}

impl ChatStyle {
    fn clamped(mut self) -> Self {
        self.font_size = self.font_size.clamp(11, 32);
        if self.fade_secs != 0 {
            self.fade_secs = self.fade_secs.clamp(5, 600);
        }
        self
    }
}

impl Default for ChatStyle {
    fn default() -> Self {
        Self {
            font_size: 15,
            avatars: true,
            backdrop: false,
            fade_secs: 0,
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

/// One pop-up the page wants: which chats, and where a new one goes.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayRequest {
    pub sources: Vec<SourceSpec>,
    pub placement: ChatPlacement,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub key: String,
    #[serde(flatten)]
    pub spec: SourceSpec,
    pub state: SourceState,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayStatus {
    pub id: u32,
    pub sources: Vec<SourceStatus>,
    pub ghost: bool,
    pub adjusting: bool,
    pub hidden: bool,
    pub rect: Option<PhysicalRect>,
}

/// What a pop-up needs to draw itself.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayConfig {
    pub sources: Vec<SourceStatus>,
    pub style: ChatStyle,
    pub adjusting: bool,
    /// Present when the chats changed: the pop-up redraws from it.
    pub backlog: Option<Vec<ChatMessage>>,
}

struct Connector {
    task: JoinHandle<()>,
    recent: VecDeque<ChatMessage>,
    state: SourceState,
    detail: Option<String>,
}

struct Overlay {
    sources: Vec<SourceSpec>,
    ghost: bool,
    adjusting: bool,
    hidden: bool,
}

#[derive(Default)]
struct Hub {
    connectors: HashMap<String, Connector>,
    overlays: BTreeMap<u32, Overlay>,
    style: ChatStyle,
}

fn hub() -> MutexGuard<'static, Hub> {
    static HUB: OnceLock<Mutex<Hub>> = OnceLock::new();
    HUB.get_or_init(|| Mutex::new(Hub::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Labels are never reused: a new pop-up cannot collide with one still being
/// torn down under the same name.
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

pub fn label(id: u32) -> String {
    format!("{LABEL_PREFIX}{id}")
}

fn id_of(label: &str) -> Option<u32> {
    label.strip_prefix(LABEL_PREFIX)?.parse().ok()
}

// =============================================================================
// Events
// =============================================================================

type Emit = Box<dyn Fn(Option<&str>, &str, Value) + Send + Sync>;
static EMIT: OnceLock<Emit> = OnceLock::new();

/// Called once at startup with the app handle, so connectors, which run
/// without one, can still reach the windows.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = EMIT.set(Box::new(move |target, event, payload| {
        let _ = match target {
            Some(label) => handle.emit_to(label, event, payload),
            None => handle.emit(event, payload),
        };
    }));
}

fn emit(target: Option<&str>, event: &str, payload: Value) {
    if let Some(emit) = EMIT.get() {
        emit(target, event, payload);
    }
}

/// Tells the Always on top page something changed.
fn announce() {
    emit(None, "chat-changed", Value::Null);
}

fn status_of(hub: &Hub, spec: &SourceSpec) -> SourceStatus {
    let key = spec.key();
    let connector = hub.connectors.get(&key);
    SourceStatus {
        key,
        spec: spec.clone(),
        state: connector.map_or(SourceState::Connecting, |c| c.state),
        detail: connector.and_then(|c| c.detail.clone()),
    }
}

fn config_for(hub: &Hub, overlay: &Overlay, with_backlog: bool) -> OverlayConfig {
    let backlog = with_backlog.then(|| {
        let mut messages: Vec<ChatMessage> = overlay
            .sources
            .iter()
            .filter_map(|spec| hub.connectors.get(&spec.key()))
            .flat_map(|c| c.recent.iter().cloned())
            .collect();
        messages.sort_by_key(|m| m.at);
        let skip = messages.len().saturating_sub(RECENT);
        messages.into_iter().skip(skip).collect()
    });
    OverlayConfig {
        sources: overlay.sources.iter().map(|s| status_of(hub, s)).collect(),
        style: hub.style.clone(),
        adjusting: overlay.adjusting,
        backlog,
    }
}

fn push_config(hub: &Hub, id: u32, with_backlog: bool) {
    if let Some(overlay) = hub.overlays.get(&id) {
        let config = config_for(hub, overlay, with_backlog);
        emit(
            Some(&label(id)),
            "chat-config",
            serde_json::to_value(config).unwrap_or(Value::Null),
        );
    }
}

// =============================================================================
// Connectors report here
// =============================================================================

pub(super) fn deliver(key: &str, events: Vec<ChatEvent>) {
    let (labels, messages, removed) = {
        let mut hub = hub();
        let Some(connector) = hub.connectors.get_mut(key) else {
            return;
        };
        let mut messages = Vec::new();
        let mut removed = Vec::new();
        for event in events {
            match event {
                ChatEvent::Message(message) => {
                    connector.recent.push_back(message.clone());
                    if connector.recent.len() > RECENT {
                        connector.recent.pop_front();
                    }
                    messages.push(message);
                }
                ChatEvent::Remove(id) => {
                    connector.recent.retain(|m| m.id != id);
                    removed.push(id);
                }
            }
        }
        let labels: Vec<String> = hub
            .overlays
            .iter()
            .filter(|(_, o)| o.sources.iter().any(|s| s.key() == key))
            .map(|(id, _)| label(*id))
            .collect();
        (labels, messages, removed)
    };

    let payload = json!({ "source": key, "messages": messages, "removed": removed });
    for label in labels {
        emit(Some(&label), "chat-events", payload.clone());
    }
}

pub(super) fn set_state(key: &str, state: SourceState, detail: Option<String>) {
    let mut hub = hub();
    let Some(connector) = hub.connectors.get_mut(key) else {
        return;
    };
    if connector.state == state && connector.detail == detail {
        return;
    }
    connector.state = state;
    connector.detail = detail;
    let ids: Vec<u32> = hub
        .overlays
        .iter()
        .filter(|(_, o)| o.sources.iter().any(|s| s.key() == key))
        .map(|(id, _)| *id)
        .collect();
    for id in ids {
        push_config(&hub, id, false);
    }
    drop(hub);
    announce();
}

/// Start the connectors some pop-up needs, stop the ones none does.
fn sync_connectors(hub: &mut Hub) {
    let mut needed: HashMap<String, SourceSpec> = HashMap::new();
    for overlay in hub.overlays.values() {
        for spec in &overlay.sources {
            needed.entry(spec.key()).or_insert_with(|| spec.clone());
        }
    }
    hub.connectors.retain(|key, connector| {
        let keep = needed.contains_key(key);
        if !keep {
            connector.task.abort();
        }
        keep
    });
    for (key, run_spec) in needed {
        if hub.connectors.contains_key(&key) {
            continue;
        }
        let task = tauri::async_runtime::spawn(async move {
            match run_spec.platform {
                Platform::Youtube => youtube::run(run_spec).await,
                Platform::Twitch => twitch::run(run_spec).await,
            }
        });
        hub.connectors.insert(
            key,
            Connector {
                task,
                recent: VecDeque::new(),
                state: SourceState::Connecting,
                detail: None,
            },
        );
    }
}

// =============================================================================
// Windows
// =============================================================================

/// Chat is tall and narrow: these are not the video presets.
fn chat_size(size: SizePreset) -> (i32, i32) {
    match size {
        SizePreset::Small => (320, 420),
        SizePreset::Medium => (380, 540),
        SizePreset::Large => (440, 680),
    }
}

fn window<R: Runtime>(app: &AppHandle<R>, id: u32) -> Option<WebviewWindow<R>> {
    app.get_webview_window(&label(id))
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
        if rect.width >= 160
            && rect.height >= 160
            && platform::rect_visible(rect.x, rect.y, right, bottom)
        {
            window
                .set_size(PhysicalSize::new(rect.width, rect.height))
                .map_err(|e| e.to_string())?;
            return window
                .set_position(PhysicalPosition::new(rect.x, rect.y))
                .map_err(|e| e.to_string());
        }
    }
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    platform::snap(hwnd, placement.corner, chat_size(placement.size), true)
}

/// Ghost lets every click through to the game, except while it is moved.
fn apply_click_through<R: Runtime>(window: &WebviewWindow<R>, overlay: &Overlay) {
    let _ = window.set_ignore_cursor_events(overlay.ghost && !overlay.adjusting);
}

/// A pop-up closed from its own title bar, or torn down with the app.
fn forget(id: u32) {
    let mut hub = hub();
    if hub.overlays.remove(&id).is_some() {
        sync_connectors(&mut hub);
        drop(hub);
        announce();
    }
}

fn create_window<R: Runtime>(
    app: &AppHandle<R>,
    id: u32,
    placement: &ChatPlacement,
) -> Result<WebviewWindow<R>, String> {
    let (width, height) = chat_size(placement.size);
    let window = WebviewWindowBuilder::new(app, label(id), WebviewUrl::App(PAGE.into()))
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
        .min_inner_size(200.0, 160.0)
        .build()
        .map_err(|e| e.to_string())?;
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            forget(id);
        }
    });
    place(&window, placement)?;
    Ok(window)
}

// =============================================================================
// For the shortcuts
// =============================================================================

pub fn ghost_states() -> Vec<bool> {
    hub().overlays.values().map(|o| o.ghost).collect()
}

pub fn set_all_ghost<R: Runtime>(app: &AppHandle<R>, ghost: bool) {
    let mut hub = hub();
    for (id, overlay) in hub.overlays.iter_mut() {
        overlay.ghost = ghost;
        if let Some(window) = window(app, *id) {
            apply_click_through(&window, overlay);
        }
    }
    drop(hub);
    announce();
}

pub fn any_visible() -> bool {
    hub().overlays.values().any(|o| !o.hidden)
}

pub fn has_overlays() -> bool {
    !hub().overlays.is_empty()
}

pub fn set_all_hidden<R: Runtime>(app: &AppHandle<R>, hidden: bool) {
    let mut hub = hub();
    for (id, overlay) in hub.overlays.iter_mut() {
        overlay.hidden = hidden;
        if let Some(window) = window(app, *id) {
            let _ = if hidden { window.hide() } else { window.show() };
        }
    }
    drop(hub);
    announce();
}

// =============================================================================
// Commands
// =============================================================================

async fn youtube_name(video_id: &str) -> Option<String> {
    let body: Value = youtube::client()
        .get("https://www.youtube.com/oembed")
        .query(&[
            ("url", format!("https://www.youtube.com/watch?v={video_id}")),
            ("format", "json".into()),
        ])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    body.get("author_name")
        .and_then(Value::as_str)
        .map(str::to_string)
}

async fn resolve_youtube_channel(path: &str) -> Result<String, String> {
    let html = youtube::client()
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
    source::is_video_id(id).then(|| id.to_string())
}

/// A link, id, or channel -> a chat Aether can follow. TikTok is recognised
/// and refused with `unsupported:tiktok`, which the page explains.
#[tauri::command]
pub async fn chat_resolve(input: String) -> Result<SourceSpec, String> {
    match source::parse(&input)? {
        Parsed::TikTok => Err("unsupported:tiktok".into()),
        Parsed::Twitch(login) => Ok(SourceSpec {
            platform: Platform::Twitch,
            name: login.clone(),
            id: login,
            top_chat: false,
        }),
        Parsed::YoutubeVideo(id) => Ok(SourceSpec {
            platform: Platform::Youtube,
            name: youtube_name(&id).await.unwrap_or_else(|| "YouTube".into()),
            id,
            top_chat: false,
        }),
        Parsed::YoutubeChannel(path) => {
            let id = resolve_youtube_channel(&path).await?;
            Ok(SourceSpec {
                platform: Platform::Youtube,
                name: youtube_name(&id).await.unwrap_or(path),
                id,
                top_chat: false,
            })
        }
    }
}

fn key_set(sources: &[SourceSpec]) -> Vec<String> {
    let mut keys: Vec<String> = sources.iter().map(SourceSpec::key).collect();
    keys.sort();
    keys
}

/// Which open pop-up each request should reuse, and which pop-ups are left
/// over. A pop-up already showing exactly those chats keeps them, so closing
/// one pop-up and applying again does not shuffle chats between windows; the
/// rest are reused in order, keeping their place on screen.
fn match_overlays(
    existing: &[(u32, Vec<String>)],
    wanted: &[Vec<SourceSpec>],
) -> (Vec<Option<u32>>, Vec<u32>) {
    let mut free: Vec<&(u32, Vec<String>)> = existing.iter().collect();
    let mut reuse: Vec<Option<u32>> = wanted
        .iter()
        .map(|sources| {
            let keys = key_set(sources);
            let at = free.iter().position(|(_, have)| *have == keys)?;
            Some(free.remove(at).0)
        })
        .collect();
    for slot in reuse.iter_mut().filter(|slot| slot.is_none()) {
        if free.is_empty() {
            break;
        }
        *slot = Some(free.remove(0).0);
    }
    (reuse, free.into_iter().map(|(id, _)| *id).collect())
}

/// Make the open pop-ups match the page's layout: pop-ups reuse their windows
/// where they can (see `match_overlays`), missing ones open, and extra ones
/// close.
#[tauri::command]
pub async fn chat_apply<R: Runtime>(
    app: AppHandle<R>,
    overlays: Vec<OverlayRequest>,
    style: ChatStyle,
    ghost: bool,
) -> Result<Vec<u32>, String> {
    if overlays.len() > MAX_OVERLAYS {
        return Err(format!("At most {MAX_OVERLAYS} chat pop-ups."));
    }
    for request in &overlays {
        if request.sources.is_empty() || request.sources.len() > MAX_SOURCES_PER_OVERLAY {
            return Err(format!(
                "A pop-up shows 1 to {MAX_SOURCES_PER_OVERLAY} chats."
            ));
        }
        if request.sources.iter().any(|s| !s.is_valid()) {
            return Err("One of the chats is not a valid YouTube or Twitch source.".into());
        }
    }

    // The same chat twice in one pop-up would print every message twice.
    let wanted: Vec<Vec<SourceSpec>> = overlays
        .iter()
        .map(|request| {
            let mut seen = std::collections::HashSet::new();
            let mut sources = request.sources.clone();
            sources.retain(|s| seen.insert(s.key()));
            sources
        })
        .collect();
    let existing: Vec<(u32, Vec<String>)> = hub()
        .overlays
        .iter()
        .map(|(id, overlay)| (*id, key_set(&overlay.sources)))
        .collect();
    let (reuse, extra) = match_overlays(&existing, &wanted);

    let mut ids = Vec::with_capacity(overlays.len());
    let mut created: Vec<(u32, WebviewWindow<R>)> = Vec::new();

    for ((request, sources), reused) in overlays.iter().zip(wanted).zip(reuse) {
        if let Some(id) = reused {
            let mut hub = hub();
            hub.style = style.clone().clamped();
            if let Some(overlay) = hub.overlays.get_mut(&id) {
                let changed = key_set(&overlay.sources) != key_set(&sources);
                overlay.sources = sources;
                sync_connectors(&mut hub);
                push_config(&hub, id, changed);
            }
            ids.push(id);
            continue;
        }

        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        {
            let mut hub = hub();
            hub.style = style.clone().clamped();
            hub.overlays.insert(
                id,
                Overlay {
                    sources,
                    ghost,
                    adjusting: false,
                    hidden: false,
                },
            );
            sync_connectors(&mut hub);
        }
        match create_window(&app, id, &request.placement) {
            Ok(window) => created.push((id, window)),
            Err(error) => {
                forget(id);
                return Err(error);
            }
        }
        ids.push(id);
    }

    for id in extra {
        if let Some(window) = window(&app, id) {
            let _ = window.destroy();
        }
        forget(id);
    }

    // Everyone gets the style; the new ones show themselves once placed.
    {
        let hub = hub();
        for id in hub.overlays.keys() {
            push_config(&hub, *id, false);
        }
        for (id, window) in &created {
            if let Some(overlay) = hub.overlays.get(id) {
                apply_click_through(window, overlay);
            }
            let _ = window.show();
        }
    }
    announce();
    Ok(ids)
}

/// A pop-up asking what to draw, as it loads.
#[tauri::command]
pub fn chat_overlay_init<R: Runtime>(window: WebviewWindow<R>) -> Result<OverlayConfig, String> {
    let id = id_of(window.label()).ok_or("Not a chat pop-up.")?;
    let hub = hub();
    let overlay = hub
        .overlays
        .get(&id)
        .ok_or("This pop-up has been closed.")?;
    Ok(config_for(&hub, overlay, true))
}

#[tauri::command]
pub fn chat_close<R: Runtime>(app: AppHandle<R>, id: u32) {
    if let Some(window) = window(&app, id) {
        let _ = window.destroy();
    }
    forget(id);
}

#[tauri::command]
pub fn chat_close_all<R: Runtime>(app: AppHandle<R>) {
    let ids: Vec<u32> = hub().overlays.keys().copied().collect();
    for id in ids {
        chat_close(app.clone(), id);
    }
}

#[tauri::command]
pub fn chat_style(style: ChatStyle) {
    let mut hub = hub();
    hub.style = style.clamped();
    let ids: Vec<u32> = hub.overlays.keys().copied().collect();
    for id in ids {
        push_config(&hub, id, false);
    }
}

#[tauri::command]
pub fn chat_set_ghost<R: Runtime>(app: AppHandle<R>, id: u32, ghost: bool) {
    let mut hub = hub();
    if let Some(overlay) = hub.overlays.get_mut(&id) {
        overlay.ghost = ghost;
        if let Some(window) = window(&app, id) {
            apply_click_through(&window, overlay);
        }
    }
    drop(hub);
    announce();
}

#[tauri::command]
pub fn chat_set_hidden<R: Runtime>(app: AppHandle<R>, id: u32, hidden: bool) {
    let mut hub = hub();
    if let Some(overlay) = hub.overlays.get_mut(&id) {
        overlay.hidden = hidden;
        if let Some(window) = window(&app, id) {
            let _ = if hidden { window.hide() } else { window.show() };
        }
    }
    drop(hub);
    announce();
}

/// Moving mode: a title bar and borders to drag, clicks accepted, a dashed
/// outline to show the bounds. Leaving it returns where the window ended up,
/// so the page can remember it.
#[tauri::command]
pub fn chat_set_adjusting<R: Runtime>(
    app: AppHandle<R>,
    id: u32,
    adjusting: bool,
) -> Result<Option<PhysicalRect>, String> {
    let window = window(&app, id).ok_or("That chat pop-up is closed.")?;
    let mut hub = hub();
    let overlay = hub
        .overlays
        .get_mut(&id)
        .ok_or("That chat pop-up is closed.")?;
    overlay.adjusting = adjusting;
    if adjusting {
        overlay.hidden = false;
        let _ = window.show();
    }
    window
        .set_decorations(adjusting)
        .map_err(|e| e.to_string())?;
    apply_click_through(&window, overlay);
    push_config(&hub, id, false);
    drop(hub);
    if adjusting {
        let _ = window.set_focus();
    }
    announce();
    Ok(if adjusting {
        None
    } else {
        current_rect(&window)
    })
}

#[tauri::command]
pub async fn chat_snap<R: Runtime>(
    app: AppHandle<R>,
    id: u32,
    corner: Corner,
    size: SizePreset,
) -> Result<(), String> {
    let window = window(&app, id).ok_or("That chat pop-up is closed.")?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    platform::snap(hwnd, corner, chat_size(size), true)?;
    announce();
    Ok(())
}

#[tauri::command]
pub fn chat_status<R: Runtime>(app: AppHandle<R>) -> Vec<OverlayStatus> {
    let hub = hub();
    hub.overlays
        .iter()
        .map(|(id, overlay)| OverlayStatus {
            id: *id,
            sources: overlay.sources.iter().map(|s| status_of(&hub, s)).collect(),
            ghost: overlay.ghost,
            adjusting: overlay.adjusting,
            hidden: overlay.hidden,
            rect: window(&app, *id).as_ref().and_then(current_rect),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_round_trip() {
        assert_eq!(label(7), "aion2-chat-7");
        assert_eq!(id_of("aion2-chat-7"), Some(7));
        assert_eq!(id_of("dps-overlay"), None);
    }

    #[test]
    fn finds_the_live_video_on_a_channel_page() {
        let page = r#"<head><link rel="canonical" href="https://www.youtube.com/watch?v=wYM_8XBICas"></head>"#;
        assert_eq!(live_video_from_page(page), Some("wYM_8XBICas".into()));
        let offline = r#"<link rel="canonical" href="https://www.youtube.com/@someone">"#;
        assert_eq!(live_video_from_page(offline), None);
    }

    #[test]
    fn style_is_kept_readable() {
        let tiny = ChatStyle {
            font_size: 2,
            fade_secs: 1,
            ..ChatStyle::default()
        }
        .clamped();
        assert_eq!((tiny.font_size, tiny.fade_secs), (11, 5));
        let keep = ChatStyle {
            fade_secs: 0,
            ..ChatStyle::default()
        }
        .clamped();
        assert_eq!(keep.fade_secs, 0);
    }

    fn twitch(login: &str) -> SourceSpec {
        SourceSpec {
            platform: Platform::Twitch,
            id: login.into(),
            name: login.into(),
            top_chat: false,
        }
    }

    #[test]
    fn pop_ups_keep_their_chats() {
        let (a, b, c) = (twitch("aaa"), twitch("bbb"), twitch("ccc"));
        // Pop-up 1 showed A and was closed; 2 still shows B. Applying A, B
        // again leaves B where it is and opens a new pop-up for A.
        let existing = vec![(2, key_set(&[b.clone()]))];
        let (reuse, extra) = match_overlays(&existing, &[vec![a.clone()], vec![b.clone()]]);
        assert_eq!(reuse, [None, Some(2)]);
        assert!(extra.is_empty());

        // Merging: the one pop-up left takes both, and the other closes.
        let existing = vec![(1, key_set(&[a.clone()])), (2, key_set(&[b.clone()]))];
        let (reuse, extra) = match_overlays(&existing, &[vec![b.clone(), a.clone()]]);
        assert_eq!(reuse, [Some(1)]);
        assert_eq!(extra, [2]);

        // A merged pop-up matches whatever order its chats come in.
        let existing = vec![(4, key_set(&[a.clone(), c.clone()]))];
        let (reuse, _) = match_overlays(&existing, &[vec![c, a]]);
        assert_eq!(reuse, [Some(4)]);
    }

    /// The page reads these exact keys.
    #[test]
    fn status_matches_the_page_contract() {
        let status = SourceStatus {
            key: "tw:xqc".into(),
            spec: SourceSpec {
                platform: Platform::Twitch,
                id: "xqc".into(),
                name: "xqc".into(),
                top_chat: false,
            },
            state: SourceState::Live,
            detail: None,
        };
        let json = serde_json::to_value(&status).unwrap();
        let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            ["detail", "id", "key", "name", "platform", "state", "topChat"]
        );
        assert_eq!(json["platform"], "twitch");
        assert_eq!(json["state"], "live");
    }
}
