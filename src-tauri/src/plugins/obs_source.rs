//! The meter as an OBS Browser Source: `http://127.0.0.1:45317/obs`.
//!
//! Window Capture on Windows 10 has two problems Aether cannot fix from its
//! side. Windows draws a yellow border around every window captured with
//! Windows Graphics Capture, and Windows 10 22H2 has no API to turn it off
//! (`GraphicsCaptureSession.IsBorderRequired` arrived later). And on a
//! streamer's Windows 10 PC the capture showed the meter's footer but not its
//! title or its rows, which the same overlay captured on Windows 11 shows in
//! full (measured with a probe window of the overlay, frame for frame).
//!
//! A Browser Source sidesteps both: OBS draws the page itself, so nothing is
//! captured. The page is the overlay's own -- same HTML, script and style,
//! read from the app's embedded assets -- with a small shim standing in for
//! the Tauri bridge: commands become requests here, events arrive as
//! Server-Sent Events. The stream shows exactly what the overlay shows.
//!
//! Off unless switched on in Settings (`aion2.overlay.obsBrowserSource`).
//! Switching it off closes the port and every open source at once, and it
//! lives inside Aether's own process, so it ends when Aether does -- `stop` is
//! also called on exit. Bound to 127.0.0.1 only (no firewall prompt, nothing
//! reachable from the network), read-only, and answers only to a Host of
//! 127.0.0.1 or localhost, so a web page cannot reach it through DNS
//! rebinding. Running, it costs a listening socket; the events are formatted
//! only while a source is connected, snapshots reach OBS at most four times a
//! second (the newest each time), and the page there draws numbers without
//! counting them up, so OBS's browser redraws as little as it can.

use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Listener, Manager, Runtime,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, watch};

use super::aion2_overlay::{LanguageStore, OverlayConfigStore};
use crate::dps_meter::engine::meter::DpsMeter;

/// The port the source is served on. Fixed, so the URL saved in OBS keeps
/// working; the next few are tried when it is taken.
pub const DEFAULT_PORT: u16 = 45_317;
const PORTS_TRIED: u16 = 10;
const PAGE: &str = "src/games/aion2/overlay/meter/index.html";
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 64 * 1024;
const KEEPALIVE: Duration = Duration::from_secs(15);
const SNAPSHOT_EVERY: Duration = Duration::from_millis(250);
const SNAPSHOT_EVENT: &str = "event: dps-snapshot\n";

/// What the overlay page listens for, passed on as they are emitted.
const EVENTS: &[&str] = &[
    "dps-snapshot",
    "dps-memory",
    "dps-main-actor-detected",
    "overlay-config-changed",
    "overlay-lock-toggled",
    "language-changed",
    "personal-bests-updated",
];

static PORT: AtomicU16 = AtomicU16::new(0);
static CLIENTS: AtomicUsize = AtomicUsize::new(0);
/// Tells the running server, and every source it is feeding, to stop.
static STOP: Mutex<Option<watch::Sender<bool>>> = Mutex::new(None);

/// The events the overlay page hears, shared by every connected source.
struct Events(broadcast::Sender<Arc<str>>);

/// The URL to give OBS, while the server is running.
pub fn url() -> Option<String> {
    match PORT.load(Ordering::SeqCst) {
        0 => None,
        port => Some(format!("http://127.0.0.1:{port}/obs")),
    }
}

/// Whether a Browser Source is showing the meter right now.
pub fn connected() -> bool {
    CLIENTS.load(Ordering::SeqCst) > 0
}

/// What Settings shows: the URL while running, and whether OBS is reading it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsSourceStatus {
    pub url: Option<String>,
    pub connected: bool,
}

fn status() -> ObsSourceStatus {
    ObsSourceStatus {
        url: url(),
        connected: connected(),
    }
}

#[tauri::command]
pub fn get_obs_source_status() -> ObsSourceStatus {
    status()
}

/// The Settings switch. Starting waits until the port is open, so the URL can
/// be shown at once.
#[tauri::command]
pub async fn set_obs_source_enabled<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<ObsSourceStatus, String> {
    if enabled {
        start(&app).await?;
    } else {
        stop();
    }
    Ok(status())
}

/// Close the port and every open source. Called by the switch and on exit.
pub fn stop() {
    if let Some(stop) = STOP.lock().unwrap().take() {
        let _ = stop.send(true);
    }
    PORT.store(0, Ordering::SeqCst);
}

async fn start<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if STOP.lock().unwrap().is_some() {
        return Ok(());
    }
    let mut bound = None;
    // The usual port first, a few times: switched off and straight back on,
    // the last server may still be letting go of it, and a new port would
    // break the URL saved in OBS.
    for _ in 0..10 {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", DEFAULT_PORT)).await {
            bound = Some((DEFAULT_PORT, listener));
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    if bound.is_none() {
        for port in DEFAULT_PORT + 1..DEFAULT_PORT + PORTS_TRIED {
            if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)).await {
                bound = Some((port, listener));
                break;
            }
        }
    }
    let (port, listener) = bound.ok_or_else(|| {
        format!(
            "Ports {DEFAULT_PORT}-{} are all in use by other programs.",
            DEFAULT_PORT + PORTS_TRIED - 1
        )
    })?;
    let (stop_sender, stop_receiver) = watch::channel(false);
    {
        let mut slot = STOP.lock().unwrap();
        if slot.is_some() {
            // Switched on twice at once: the other start won.
            return Ok(());
        }
        *slot = Some(stop_sender);
    }
    PORT.store(port, Ordering::SeqCst);
    tauri::async_runtime::spawn(serve(app.clone(), listener, stop_receiver));
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("obs-source")
        .setup(|app, _| {
            let (sender, _) = broadcast::channel::<Arc<str>>(64);
            for &name in EVENTS {
                let sender = sender.clone();
                app.listen_any(name, move |event| {
                    // Formatted only for someone listening: the snapshot is
                    // emitted ten times a second whether or not OBS is open.
                    if sender.receiver_count() > 0 {
                        let message = format!("event: {name}\ndata: {}\n\n", event.payload());
                        let _ = sender.send(Arc::from(message));
                    }
                });
            }
            app.manage(Events(sender));
            Ok(())
        })
        .build()
}

async fn serve<R: Runtime>(app: AppHandle<R>, listener: TcpListener, mut stop: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else {
                    continue;
                };
                let Some(events) = app.try_state::<Events>().map(|events| events.0.subscribe()) else {
                    continue;
                };
                let app = app.clone();
                let stop = stop.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = handle(app, stream, events, stop).await;
                });
            }
            _ = stop.changed() => break,
        }
    }
    // The listener is dropped here: the port is free again.
}

struct Request {
    method: String,
    path: String,
    host: String,
    body: Vec<u8>,
}

async fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    let head_end = loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(at) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
        if buffer.len() > MAX_HEAD {
            return Ok(None);
        }
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let method = first.next().unwrap_or_default().to_string();
    let path = first.next().unwrap_or_default().to_string();
    let mut host = String::new();
    let mut length = 0usize;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "host" => host = value.trim().to_ascii_lowercase(),
            "content-length" => length = value.trim().parse().unwrap_or(0),
            _ => {}
        }
    }
    if length > MAX_BODY {
        return Ok(None);
    }
    let mut body = buffer[head_end..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(length);
    Ok(Some(Request {
        method,
        path,
        host,
        body,
    }))
}

async fn respond(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await
}

/// Only this PC, by name or address: a page elsewhere that resolves its own
/// domain to 127.0.0.1 still sends its own name as the Host.
fn host_allowed(host: &str) -> bool {
    let name = host.rsplit_once(':').map_or(host, |(name, _)| name);
    matches!(name, "127.0.0.1" | "localhost")
}

async fn handle<R: Runtime>(
    app: AppHandle<R>,
    mut stream: TcpStream,
    events: broadcast::Receiver<Arc<str>>,
    stop: watch::Receiver<bool>,
) -> std::io::Result<()> {
    let Some(request) = read_request(&mut stream).await? else {
        return Ok(());
    };
    if !host_allowed(&request.host) {
        return respond(&mut stream, "403 Forbidden", "text/plain", b"forbidden").await;
    }
    let path = request.path.split('?').next().unwrap_or_default().to_string();
    match (request.method.as_str(), path.as_str()) {
        ("GET", "/obs") | ("GET", "/obs/") => match page(&app) {
            Some(html) => respond(&mut stream, "200 OK", "text/html; charset=utf-8", html.as_bytes()).await,
            None => respond(&mut stream, "503 Service Unavailable", "text/plain", b"overlay page not found").await,
        },
        ("GET", "/obs/events") => stream_events(&app, stream, events, stop).await,
        ("POST", command) if command.starts_with("/obs/invoke/") => {
            let command = &command["/obs/invoke/".len()..];
            let args: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
            let answer = invoke(&app, command, &args);
            respond(&mut stream, "200 OK", "application/json", answer.to_string().as_bytes()).await
        }
        ("GET", asset) if asset_allowed(asset) => match app.asset_resolver().get(asset.to_string()) {
            // The resolver falls back to the app's index.html for a path it
            // does not have; that is a 404 here, not a page.
            Some(found) if !found.mime_type().starts_with("text/html") => {
                respond(&mut stream, "200 OK", found.mime_type(), found.bytes()).await
            }
            _ => respond(&mut stream, "404 Not Found", "text/plain", b"not found").await,
        },
        _ => respond(&mut stream, "404 Not Found", "text/plain", b"not found").await,
    }
}

/// The overlay's scripts, styles and images, and nothing else of the app.
fn asset_allowed(path: &str) -> bool {
    (path.starts_with("/assets/") || path.starts_with("/aion2/")) && !path.contains("..")
}

/// The overlay page with the shim in front of its own script.
fn page<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let asset = app.asset_resolver().get(PAGE.to_string())?;
    let html = String::from_utf8_lossy(asset.bytes()).to_string();
    let shim = format!("<head>\n<script>{SHIM}</script>");
    Some(html.replacen("<head>", &shim, 1))
}

/// Answers for the commands the overlay asks while it starts. Anything that
/// would change something in the app is answered with nothing and ignored:
/// the source only ever reads.
fn invoke<R: Runtime>(app: &AppHandle<R>, command: &str, args: &Value) -> Value {
    match command {
        "get_language" => app
            .try_state::<LanguageStore>()
            .map(|store| Value::String(store.0.read().unwrap().clone()))
            .unwrap_or(Value::Null),
        "get_overlay_config" => app
            .try_state::<OverlayConfigStore>()
            .map(|store| store.0.read().unwrap().clone())
            .unwrap_or(Value::Null),
        "get_dps_overlay_locked" => Value::Bool(super::aion2_overlay::get_dps_overlay_locked()),
        // The overlay's width on screen, so the card on stream is the same
        // shape whatever width the source was given in OBS.
        "get_obs_layout" => app
            .get_webview_window(super::aion2_overlay::DPS_OVERLAY_LABEL)
            .and_then(|window| {
                let size = window.inner_size().ok()?;
                let scale = window.scale_factor().ok()?;
                Some(serde_json::json!({ "width": f64::from(size.width) / scale }))
            })
            .unwrap_or(Value::Null),
        // The stream is no place for "start the meter": the overlay's own
        // diagnostics stay on the overlay.
        "check_dps_meter_state" => serde_json::json!({
            "npcapAvailable": true,
            "meterRunning": true,
            "hasGameData": true,
            "playerIdentified": true,
            "bossOnlyFiltered": 0
        }),
        "get_dps_meter_config" => app
            .try_state::<DpsMeter>()
            .and_then(|meter| serde_json::to_value(meter.current_config()).ok())
            .unwrap_or(Value::Null),
        "get_personal_best" => {
            let character = args.get("character").and_then(Value::as_str).unwrap_or_default();
            let mob_code = args.get("mobCode").and_then(Value::as_u64).unwrap_or_default() as u32;
            app.try_state::<DpsMeter>()
                .and_then(|meter| meter.personal_best(character, mob_code))
                .and_then(|best| serde_json::to_value(best).ok())
                .unwrap_or(Value::Null)
        }
        _ => Value::Null,
    }
}

async fn stream_events<R: Runtime>(
    app: &AppHandle<R>,
    mut stream: TcpStream,
    mut events: broadcast::Receiver<Arc<str>>,
    mut stop: watch::Receiver<bool>,
) -> std::io::Result<()> {
    stream
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n",
        )
        .await?;
    CLIENTS.fetch_add(1, Ordering::SeqCst);
    let result = async {
        // The fight already on the meter, so a source added mid-fight is not
        // blank until the next hit.
        if let Some(snapshot) = app.try_state::<DpsMeter>().and_then(|meter| meter.get_last_snapshot()) {
            if let Ok(json) = serde_json::to_string(&snapshot) {
                stream
                    .write_all(format!("event: dps-snapshot\ndata: {json}\n\n").as_bytes())
                    .await?;
            }
        }
        // Snapshots go out at most four times a second, the newest one each
        // time: OBS's browser then redraws a quarter as often as the overlay
        // is sent updates, and a viewer cannot tell the difference.
        let mut pending: Option<Arc<str>> = None;
        let mut flush = tokio::time::interval(SNAPSHOT_EVERY);
        flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut keepalive = tokio::time::interval(KEEPALIVE);
        loop {
            tokio::select! {
                message = events.recv() => match message {
                    Ok(message) if message.starts_with(SNAPSHOT_EVENT) => pending = Some(message),
                    Ok(message) => stream.write_all(message.as_bytes()).await?,
                    // Fell behind: the next snapshot replaces what was missed.
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return Ok(()),
                },
                _ = flush.tick() => {
                    if let Some(message) = pending.take() {
                        stream.write_all(message.as_bytes()).await?;
                    }
                }
                _ = keepalive.tick() => stream.write_all(b": keepalive\n\n").await?,
                // Switched off, or Aether is closing: the source goes blank.
                _ = stop.changed() => return Ok(()),
            }
        }
    }
    .await;
    CLIENTS.fetch_sub(1, Ordering::SeqCst);
    result
}

/// Stands in for the Tauri bridge inside OBS's browser: commands go to
/// `/obs/invoke`, events come from `/obs/events`, window calls do nothing.
const SHIM: &str = r#"
(function () {
  var callbacks = {}, next = 1, listeners = {};
  document.documentElement.classList.add("is-obs");
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "obs-source" }, currentWebview: { label: "obs-source", windowLabel: "obs-source" } },
    transformCallback: function (cb) { var id = next++; callbacks[id] = cb; return id; },
    unregisterCallback: function (id) { delete callbacks[id]; },
    convertFileSrc: function (path) { return path; },
    invoke: function (cmd, args) {
      if (cmd === "plugin:event|listen") {
        (listeners[args.event] = listeners[args.event] || []).push(args.handler);
        return Promise.resolve(args.handler);
      }
      if (cmd.indexOf("plugin:") === 0) return Promise.resolve(null);
      return fetch("/obs/invoke/" + cmd, { method: "POST", body: JSON.stringify(args || {}) })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (value) {
          // The card sizes itself to its rows; OBS sizes the source.
          if (cmd === "get_overlay_config" && value) value.autoResizeHeight = true;
          return value;
        })
        .catch(function () { return null; });
    }
  };
  function deliver(event, payload) {
    if (event === "overlay-config-changed" && payload) payload.autoResizeHeight = true;
    (listeners[event] || []).forEach(function (id) {
      var cb = callbacks[id];
      if (cb) cb({ event: event, payload: payload, id: 0 });
    });
  }
  function layout() {
    window.__TAURI_INTERNALS__.invoke("get_obs_layout").then(function (value) {
      var root = document.documentElement.style;
      if (value && value.width > 0) root.setProperty("--obs-width", value.width + "px");
      else root.removeProperty("--obs-width");
    });
  }
  layout();
  setInterval(layout, 5000);
  var source = new EventSource("/obs/events");
  ["dps-snapshot", "dps-memory", "dps-main-actor-detected", "overlay-config-changed",
   "overlay-lock-toggled", "language-changed", "personal-bests-updated"].forEach(function (name) {
    source.addEventListener(name, function (e) {
      try { deliver(name, JSON.parse(e.data)); } catch (_) {}
    });
  });
})();
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_pc_may_ask() {
        assert!(host_allowed("127.0.0.1:45317"));
        assert!(host_allowed("localhost:45317"));
        assert!(!host_allowed("evil.example:45317"));
        assert!(!host_allowed(""));
    }

    #[test]
    fn only_the_overlays_assets_are_served() {
        assert!(asset_allowed("/assets/index-abc.js"));
        assert!(asset_allowed("/aion2/class/ranger.png"));
        assert!(!asset_allowed("/index.html"));
        assert!(!asset_allowed("/assets/../tauri.conf.json"));
    }
}
