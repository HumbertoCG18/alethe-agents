//! Watches the Claude and Codex session folders: a new or grown transcript is announced as
//! `session://new` and handed to the session reader. Panes that poll keep working without it.

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

struct Watch {
    watcher: RecommendedWatcher,
    /// The folders watched, and whether with what is inside them.
    watched: HashMap<PathBuf, bool>,
}

static WATCH: OnceLock<Mutex<Watch>> = OnceLock::new();

/// What to watch for a session folder: itself and everything inside once it exists; until then
/// its nearest existing parent alone, to see it appear.
fn watch_target(root: &Path) -> Option<(PathBuf, bool)> {
    let dir = root.ancestors().find(|dir| dir.is_dir())?;
    Some((dir.to_path_buf(), dir == root))
}

/// Watches the session folders, including ones created after the app started (Claude's first run
/// on this machine creates its folder only then). Run at start, on each creation seen, and on
/// each session subscribed.
pub(crate) fn watch_session_folders() {
    let Some(Ok(mut watch)) = WATCH.get().map(Mutex::lock) else {
        return;
    };
    let roots = [
        crate::claude_sessions::claude_projects_dir(),
        crate::codex_sessions::codex_sessions_dir(),
    ];
    for root in roots.into_iter().flatten() {
        let Some((dir, inside)) = watch_target(&root) else {
            continue;
        };
        if watch.watched.get(&dir).is_some_and(|&done| done || !inside) {
            continue;
        }
        let mode = if inside {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        // ponytail: a parent watched while its session folder was missing stays watched.
        if watch.watcher.watch(&dir, mode).is_ok() {
            watch.watched.insert(dir, inside);
        }
    }
}

pub fn start_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let (tx, rx) = channel();
        let watcher = match RecommendedWatcher::new(tx, Config::default()) {
            Ok(watcher) => watcher,
            Err(error) => {
                eprintln!("[session_watcher] could not create the watcher: {error}");
                return;
            }
        };
        let watched = HashMap::new();
        if WATCH.set(Mutex::new(Watch { watcher, watched })).is_err() {
            return;
        }
        watch_session_folders();

        let claude = crate::claude_sessions::claude_projects_dir();
        let codex = crate::codex_sessions::codex_sessions_dir();

        for res in rx {
            let Ok(event) = res else { continue };
            if matches!(event.kind, EventKind::Create(_)) {
                watch_session_folders();
            }
            if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                continue;
            }
            for path in event.paths {
                if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Some(readers) = app.try_state::<crate::session_reader::SessionReaders>() {
                    readers.file_changed(&path);
                }
                let agent = if claude.as_ref().is_some_and(|c| path.starts_with(c)) {
                    "claude"
                } else if codex.as_ref().is_some_and(|c| path.starts_with(c)) {
                    "codex"
                } else {
                    continue;
                };
                let _ = app.emit("session://new", serde_json::json!({ "agent": agent }));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::watch_target;

    #[test]
    fn watches_the_nearest_folder_until_the_session_folder_appears() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let base = std::env::temp_dir().join(format!("alethe-watch-{suffix}"));
        let root = base.join("projects");
        std::fs::create_dir_all(&base).expect("base");
        assert_eq!(watch_target(&root), Some((base.clone(), false)));
        std::fs::create_dir_all(&root).expect("root");
        assert_eq!(watch_target(&root), Some((root.clone(), true)));
        std::fs::remove_dir_all(base).ok();
    }
}
