// Logging de crash (Rust) e de erros do frontend.
//

use std::fs;
use std::io::Write;
use std::panic;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use crate::diagnostics::timestamp_ms;
use crate::resources::RuntimeSnapshot;

const MAX_FILES_PER_PREFIX: usize = 20;

static LOGS_DIR: OnceLock<PathBuf> = OnceLock::new();

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn logs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(root.join("logs"))
}

pub fn set_logs_dir(app: &AppHandle) {
    if let Ok(dir) = logs_dir(app) {
        let _ = fs::create_dir_all(&dir);
        let _ = LOGS_DIR.set(dir);
    }
}

/// Size past which a continuous log moves to `<name>.1` before its next line, so `resource.log`
/// and `app-events.log` keep at most two files.
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

fn append_log(path: &Path, message: &str) {
    append_log_capped(path, message, MAX_LOG_BYTES);
}

/// One process-wide lock over check, rotate and append: two appends that both saw the log over its
/// cap would otherwise rotate twice, the second moving the fresh log over the history in `.1`.
static APPEND_LOCK: Mutex<()> = Mutex::new(());

fn append_log_capped(path: &Path, message: &str, max_bytes: u64) {
    let _guard = APPEND_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::metadata(path).is_ok_and(|meta| meta.len() > max_bytes) {
        let mut rotated = path.as_os_str().to_owned();
        rotated.push(".1");
        // Replaces an older `.1`, on Windows too (MoveFileExW with MOVEFILE_REPLACE_EXISTING).
        let _ = fs::rename(path, rotated);
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{}] {message}", timestamp_ms());
    }
}

/// Records periodic resource health without changing runtime state. This log is
/// intentionally concise so freezes can be compared with Windows availability
/// and the exact PTY count after the next launch.
pub fn record_resource_snapshot(
    app: &AppHandle,
    level: &str,
    snapshot: &RuntimeSnapshot,
    idle_candidates: usize,
    action: &str,
) {
    let Ok(dir) = logs_dir(app) else {
        return;
    };
    let memory = &snapshot.memory;
    append_log(
        &dir.join("resource.log"),
        &format!(
            "level={level} action={action} app_total_mb={:.0} app_mb={:.0} webview_mb={:.0} ptys_mb={:.0} windows_available_mb={:.0} windows_total_mb={:.0} processes={} live_ptys={} idle_recommendations={idle_candidates}",
            snapshot.effective_total_mb,
            memory.app_mb,
            memory.webview_mb,
            memory.ptys_mb,
            memory.system_available_mb,
            memory.system_total_mb,
            memory.process_count,
            snapshot.ptys.len(),
        ),
    );
}

fn prune(dir: &Path, prefix: &str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(prefix))
                .unwrap_or(false)
        })
        .collect();
    if files.len() <= MAX_FILES_PER_PREFIX {
        return;
    }
    files.sort();
    let remove_count = files.len() - MAX_FILES_PER_PREFIX;
    for path in files.into_iter().take(remove_count) {
        let _ = fs::remove_file(path);
    }
}

pub fn install_panic_hook() {
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        if let Some(dir) = LOGS_DIR.get() {
            let path = dir.join(format!("crash-{}.log", unix_secs()));
            let location = info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_else(|| "<unknown>".to_string());
            let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
                (*s).to_string()
            } else if let Some(s) = info.payload().downcast_ref::<String>() {
                s.clone()
            } else {
                "<non-string panic payload>".to_string()
            };
            let thread = std::thread::current()
                .name()
                .unwrap_or("<unnamed>")
                .to_string();
            let backtrace = std::backtrace::Backtrace::force_capture();
            let msg = format!(
                "PANIC v{} thread={thread} at {location}\n{payload}\nbacktrace:\n{backtrace}",
                env!("CARGO_PKG_VERSION"),
            );
            append_log(&path, &msg);
            prune(dir, "crash-");
        }

        previous(info);
    }));
}

/// Persiste um erro vindo do frontend (window.onerror / unhandledrejection /

#[tauri::command]
pub fn record_frontend_error(
    message: String,
    stack: Option<String>,
    kind: String,
) -> Result<(), String> {
    let Some(dir) = LOGS_DIR.get() else {
        return Ok(());
    };
    let path = dir.join(format!("frontend-{}.log", unix_secs()));
    let body = match stack {
        Some(s) if !s.trim().is_empty() => format!("[{kind}] {message}\n{s}"),
        _ => format!("[{kind}] {message}"),
    };
    append_log(&path, &body);
    prune(dir, "frontend-");
    Ok(())
}

/// Records non-sensitive lifecycle facts used to diagnose persistence and UI
/// restoration. Callers must send counts/flags only, never project names or paths.
#[tauri::command]
pub fn record_app_event(kind: String, message: String) -> Result<(), String> {
    let Some(dir) = LOGS_DIR.get() else {
        return Ok(());
    };
    let safe_kind: String = kind
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
        .take(64)
        .collect();
    let safe_message = message.replace('\r', " ").replace('\n', " ");
    append_log(
        &dir.join("app-events.log"),
        &format!(
            "[{}] {}",
            safe_kind,
            safe_message.chars().take(512).collect::<String>()
        ),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_log_past_its_cap_moves_to_dot_1_so_it_keeps_two_files() {
        let dir = std::env::temp_dir().join(format!(
            "alethe-log-cap-{}-{}",
            std::process::id(),
            unix_secs()
        ));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("app-events.log");
        let rotated = dir.join("app-events.log.1");
        let read = |path: &Path| fs::read_to_string(path).unwrap_or_default();

        append_log_capped(&path, "one", 8);
        append_log_capped(&path, "two", 8);
        assert!(read(&path).contains("two") && !read(&path).contains("one"));
        assert!(read(&rotated).contains("one"));

        // The older `.1` is replaced, never kept as a third file.
        append_log_capped(&path, "three", 8);
        assert!(read(&path).contains("three") && !read(&path).contains("two"));
        assert!(read(&rotated).contains("two") && !read(&rotated).contains("one"));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);

        // Under the cap, lines keep going to the same file.
        append_log_capped(&path, "four", 1024);
        assert!(read(&path).contains("three") && read(&path).contains("four"));

        let _ = fs::remove_dir_all(&dir);
    }

    /// Two appends at once could both see the log over its cap: the second then moved the log the
    /// first had just recreated over `.1`, erasing the history the first had rotated.
    #[test]
    fn concurrent_appends_only_ever_rotate_a_full_log() {
        let dir = std::env::temp_dir().join(format!(
            "alethe-log-race-{}-{}",
            std::process::id(),
            unix_secs()
        ));
        let _ = fs::remove_dir_all(&dir);
        // Lines all have the same width, so the cap holds exactly PER_FILE of them.
        let line = |thread: usize, n: usize| format!("t{thread:02}-{n:04}");
        let probe = dir.join("probe.log");
        append_log_capped(&probe, &line(0, 0), u64::MAX);
        let width = fs::metadata(&probe).unwrap().len();
        let _ = fs::remove_file(&probe);
        const PER_FILE: usize = 5;
        const THREADS: usize = 8;
        const EACH: usize = 250;
        let cap = width * (PER_FILE as u64 - 1);
        let path = dir.join("resource.log");

        std::thread::scope(|scope| {
            for thread in 0..THREADS {
                let path = &path;
                scope.spawn(move || {
                    for n in 0..EACH {
                        append_log_capped(path, &line(thread, n), cap);
                    }
                });
            }
        });

        let lines = |path: &Path| fs::read_to_string(path).unwrap_or_default().lines().count();
        let mut rotated = path.as_os_str().to_owned();
        rotated.push(".1");
        assert_eq!(lines(Path::new(&rotated)), PER_FILE);
        assert_eq!(lines(&path), (THREADS * EACH - 1) % PER_FILE + 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
