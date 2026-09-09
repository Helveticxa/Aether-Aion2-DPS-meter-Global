use std::fs::{create_dir_all, rename, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Emitter, Manager, Runtime, State,
};

/// Roll the log over at this size. Without a cap the file grows for the life of
/// the install, and reading its tail gets slower every session.
const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;

/// How many lines the log window backfills when it opens.
const BACKFILL_LINES: usize = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub level: String,
    pub message: String,
    pub line: String,
    pub timestamp: f64,
}

pub struct AppLogger {
    emit: Box<dyn Fn(LogEvent) + Send + Sync>,
    file_path: PathBuf,
    debug_enabled: Mutex<bool>,
    write_lock: Mutex<()>,
}

impl AppLogger {
    fn new<R: Runtime>(app: &AppHandle<R>) -> Self {
        let file_path = resolve_log_path(app);
        if let Some(parent) = file_path.parent() {
            let _ = create_dir_all(parent);
        }
        let app = app.clone();

        Self {
            emit: Box::new(move |event| {
                let _ = app.emit("app-logger", event);
            }),
            file_path,
            debug_enabled: Mutex::new(false),
            write_lock: Mutex::new(()),
        }
    }

    pub fn set_debug_enabled(&self, enabled: bool) {
        *self.debug_enabled.lock().unwrap() = enabled;
    }

    pub fn is_debug_enabled(&self) -> bool {
        *self.debug_enabled.lock().unwrap()
    }

    pub fn debug(&self, message: impl AsRef<str>) {
        if *self.debug_enabled.lock().unwrap() {
            self.write_line("DEBUG", message.as_ref());
        }
    }

    pub fn info(&self, message: impl AsRef<str>) {
        self.write_line("INFO", message.as_ref());
    }

    #[allow(dead_code)]
    pub fn error(&self, message: impl AsRef<str>) {
        self.write_line("ERROR", message.as_ref());
    }

    /// Keep one previous log alongside the current one and discard the rest.
    ///
    /// One rollover is enough to survive a crash-and-restart, which is when the
    /// interesting lines are in the older file.
    fn rotate_if_large(&self) {
        let Ok(meta) = std::fs::metadata(&self.file_path) else {
            return;
        };
        if meta.len() < MAX_LOG_BYTES {
            return;
        }

        let previous = self.file_path.with_extension("log.1");
        let _ = std::fs::remove_file(&previous);
        let _ = rename(&self.file_path, &previous);
    }

    /// The last lines already on disk, so a window opened mid-session shows the
    /// session rather than waiting for the next thing to happen.
    pub fn tail(&self, limit: usize) -> Vec<String> {
        let _guard = self.write_lock.lock().unwrap();
        let Ok(contents) = std::fs::read_to_string(&self.file_path) else {
            return Vec::new();
        };

        let lines: Vec<&str> = contents.lines().filter(|line| !line.is_empty()).collect();
        let start = lines.len().saturating_sub(limit);
        lines[start..].iter().map(|line| (*line).to_string()).collect()
    }

    fn write_line(&self, level: &str, message: &str) {
        let _guard = self.write_lock.lock().unwrap();
        self.rotate_if_large();

        let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file_path)
        else {
            return;
        };

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs_f64())
            .unwrap_or_default();

        let line = format!("[{timestamp:.3}] [{level}] {message}");
        let _ = writeln!(file, "{line}");
        (self.emit)(LogEvent {
            level: level.to_string(),
            message: message.to_string(),
            line,
            timestamp,
        });
    }
}

fn resolve_log_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    if let Ok(dir) = app.path().app_log_dir() {
        return dir.join("aether.log");
    }
    if let Ok(dir) = app.path().app_data_dir() {
        return dir.join("logs").join("aether.log");
    }
    std::env::temp_dir().join("aether").join("aether.log")
}

#[tauri::command]
pub fn get_app_logger_debug_enabled(logger: State<'_, Arc<AppLogger>>) -> bool {
    logger.is_debug_enabled()
}

#[tauri::command]
pub fn set_app_logger_debug_enabled(logger: State<'_, Arc<AppLogger>>, enabled: bool) -> bool {
    logger.set_debug_enabled(enabled);
    logger.is_debug_enabled()
}

/// Backfill for the log window.
///
/// The window only ever listened for live `app-logger` events, so opening it
/// after startup -- which is when nearly everything is logged -- showed an empty
/// pane and read as a broken feature.
#[tauri::command]
pub fn read_app_log_tail(logger: State<'_, Arc<AppLogger>>) -> Vec<String> {
    logger.tail(BACKFILL_LINES)
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("logger")
        .setup(|app, _| {
            app.manage(Arc::new(AppLogger::new(app.app_handle())));
            Ok(())
        })
        .build()
}
