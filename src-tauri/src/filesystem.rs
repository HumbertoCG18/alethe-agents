use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

const TODO_TEMPLATE_FILE: &str = "alethe-todo.template.jsonc";
const TODO_TEMPLATE: &str = r#"// Alethe Todo template
                                                                                     
// For now, the app stores Todo items in its local profile; this template documents
// the structure expected by the importer/sync layer.
{
  // Schema version for future migrations.
  "version": 1,

  // Global personal task list. Order in this array is the visible order.
  "todos": [
    {
      // Stable id. Any unique string is accepted.
      "id": "task-example-1",

      // Text shown in the Todo sidebar.
      "title": "Example task",

      // false = Active, true = Completed.
      "completed": false
    }
  ]
}
"#;

#[derive(Serialize)]
pub struct DirectoryEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: Option<u64>,
}

#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<DirectoryEntry>, String> {
    let directory = PathBuf::from(path.trim());
    if !directory.is_dir() {
        return Err("directory not found".to_string());
    }

    let mut entries = fs::read_dir(&directory)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let file_type = entry.file_type().ok()?;
            Some(DirectoryEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path().to_string_lossy().into_owned(),
                is_dir: file_type.is_dir(),
                size: entry
                    .metadata()
                    .ok()
                    .filter(|_| file_type.is_file())
                    .map(|value| value.len()),
            })
        })
        .collect::<Vec<_>>();

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseDirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: Option<u64>,
}

/// In-app folder/file browser used by `FsBrowserModal` as an alternative to
/// the native OS picker — separate from `list_directory`/`DirectoryEntry`
/// (used by the sidebar file explorer) since this returns navigation context
/// (parent/home/drive roots) that explorer callers don't need or expect.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub current_path: String,
    pub parent_path: Option<String>,
    pub home_path: String,
    pub system_roots: Vec<String>,
    pub entries: Vec<BrowseDirectoryEntry>,
}

/// The home folder, so the terminal can resolve the `~` in paths it prints. `None` rather than a
/// guess when the platform reports none.
#[tauri::command]
pub fn home_directory() -> Option<String> {
    dirs_next::home_dir().map(|home| home.to_string_lossy().into_owned())
}

fn get_home_dir() -> PathBuf {
    if let Ok(v) = std::env::var("USERPROFILE") {
        PathBuf::from(v)
    } else if let Ok(v) = std::env::var("HOME") {
        PathBuf::from(v)
    } else {
        PathBuf::from(".")
    }
}

fn get_system_roots() -> Vec<String> {
    let mut roots = Vec::new();
    #[cfg(target_os = "windows")]
    {
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if Path::new(&drive).exists() {
                roots.push(drive);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        roots.push("/".to_string());
        if Path::new("/home").exists() {
            roots.push("/home".to_string());
        }
        if Path::new("/media").exists() {
            roots.push("/media".to_string());
        }
        if Path::new("/mnt").exists() {
            roots.push("/mnt".to_string());
        }
        if Path::new("/Volumes").exists() {
            roots.push("/Volumes".to_string());
        }
    }
    roots
}

#[tauri::command]
pub fn browse_directory(path: String) -> Result<DirectoryListing, String> {
    let home = get_home_dir();
    let trimmed = path.trim();
    let directory = if trimmed.is_empty() || trimmed == "~" {
        home.clone()
    } else {
        let p = PathBuf::from(trimmed);
        if p.exists() {
            if p.is_file() {
                p.parent().map(|parent| parent.to_path_buf()).unwrap_or(home.clone())
            } else {
                p
            }
        } else {
            home.clone()
        }
    };

    let canonical = directory.canonicalize().unwrap_or_else(|_| directory.clone());
    let current_path_str = canonical.to_string_lossy().into_owned();
    let clean_current_path = current_path_str
        .strip_prefix(r"\\?\")
        .unwrap_or(&current_path_str)
        .to_string();

    let parent_path = canonical.parent().map(|p| {
        let s = p.to_string_lossy().into_owned();
        s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
    });

    let mut entries = match fs::read_dir(&canonical) {
        Ok(read_dir) => read_dir
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let file_type = entry.file_type().ok()?;
                let metadata = entry.metadata().ok();
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('$') || name == "System Volume Information" {
                    return None;
                }
                let full_path = entry.path().to_string_lossy().into_owned();
                let clean_path = full_path.strip_prefix(r"\\?\").unwrap_or(&full_path).to_string();
                Some(BrowseDirectoryEntry {
                    name,
                    path: clean_path,
                    is_dir: file_type.is_dir(),
                    size_bytes: metadata.map(|m| m.len()),
                })
            })
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let clean_home = home.to_string_lossy().into_owned();
    let home_path = clean_home.strip_prefix(r"\\?\").unwrap_or(&clean_home).to_string();

    Ok(DirectoryListing {
        current_path: clean_current_path,
        parent_path,
        home_path,
        system_roots: get_system_roots(),
        entries,
    })
}

fn existing_entry(path: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() || !target.exists() {
        return Err("entry not found".to_string());
    }
    if target.parent().is_none() {
        return Err("filesystem roots cannot be modified".to_string());
    }
    Ok(target)
}

#[tauri::command]
pub fn rename_filesystem_entry(path: String, new_name: String) -> Result<String, String> {
    let target = existing_entry(&path)?;
    let trimmed_name = new_name.trim();
    let name_path = Path::new(trimmed_name);
    if trimmed_name.is_empty()
        || name_path.components().count() != 1
        || matches!(trimmed_name, "." | "..")
    {
        return Err("invalid entry name".to_string());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "filesystem roots cannot be renamed".to_string())?;
    let destination = parent.join(name_path);
    if destination.exists() {
        return Err("an entry with this name already exists".to_string());
    }
    fs::rename(&target, &destination).map_err(|error| error.to_string())?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn delete_filesystem_entry(path: String) -> Result<(), String> {
    let target = existing_entry(&path)?;
    let metadata = fs::symlink_metadata(&target).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(&target).map_err(|error| error.to_string())
    } else if metadata.is_dir() {
        fs::remove_dir_all(&target).map_err(|error| error.to_string())
    } else {
        Err("unsupported filesystem entry".to_string())
    }
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let file = PathBuf::from(path.trim());
    if !file.is_file() {
        return Err("file not found".to_string());
    }
    fs::read_to_string(&file).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    let file = PathBuf::from(path.trim());
    if !file.is_file() {
        return Err("file not found".to_string());
    }
    fs::write(&file, content).map_err(|error| error.to_string())
}

/// Writes the `.alethe/project.json` mirror inside the project's own folder
/// (not app data) — creates `.alethe/` if it doesn't exist yet. Unlike
/// `write_text_file`, this command can create the file from scratch (doesn't
/// require it to already exist), because the whole point is to initialize
/// the mirror the first time the project is saved.
#[tauri::command]
pub fn write_project_marker(project_dir: String, content: String) -> Result<(), String> {
    let dir = PathBuf::from(project_dir.trim());
    if !dir.is_dir() {
        return Err("directory not found".to_string());
    }
    let marker_dir = dir.join(".alethe");
    fs::create_dir_all(&marker_dir).map_err(|error| error.to_string())?;
    fs::write(marker_dir.join("project.json"), content).map_err(|error| error.to_string())
}

/// Reads a folder's `.alethe/project.json`, if it exists — used to detect an
/// "already-configured project" when pointing a new project at that folder.
/// `None` (not an error) when the marker simply doesn't exist yet, which is
/// the normal case for any folder new to / never used by Alethe.
#[tauri::command]
pub fn read_project_marker(project_dir: String) -> Option<String> {
    let marker = PathBuf::from(project_dir.trim())
        .join(".alethe")
        .join("project.json");
    fs::read_to_string(marker).ok()
}

#[tauri::command]
pub fn ensure_todo_template(directory: String) -> Result<String, String> {
    let dir = PathBuf::from(directory.trim());
    if dir.as_os_str().is_empty() {
        return Err("empty directory".to_string());
    }
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    if !dir.is_dir() {
        return Err("directory not found".to_string());
    }
    let template_path = dir.join(TODO_TEMPLATE_FILE);
    if !template_path.exists() {
        fs::write(&template_path, TODO_TEMPLATE).map_err(|error| error.to_string())?;
    }
    Ok(template_path.to_string_lossy().into_owned())
}

#[derive(Default)]
pub struct FileWatchers(pub Arc<Mutex<HashMap<String, (RecommendedWatcher, usize)>>>);

fn normalize(path: &str) -> String {
    path.trim().to_string()
}

/// Calls `changed` when `target` is created or modified. A file is watched through its parent
/// folder, so it is still seen after an atomic replace; a folder that exists is watched itself and
/// also reports the files directly inside it.
fn path_watcher(
    target: PathBuf,
    changed: impl Fn() + Send + 'static,
) -> Result<RecommendedWatcher, String> {
    let folder = target.is_dir();
    let watched_dir = if folder {
        target.clone()
    } else {
        target
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "invalid path".to_string())?
    };
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            if !matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                return;
            }
            let concerns = |path: &PathBuf| {
                path == &target || (folder && path.parent() == Some(target.as_path()))
            };
            if event.paths.iter().any(concerns) {
                changed();
            }
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&watched_dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    Ok(watcher)
}

#[tauri::command]
pub fn watch_file(
    app: AppHandle,
    state: tauri::State<'_, FileWatchers>,
    path: String,
) -> Result<(), String> {
    let key = normalize(&path);
    let mut map = state.0.lock().map_err(|e| e.to_string())?;

    if let Some(entry) = map.get_mut(&key) {
        entry.1 += 1;
        return Ok(());
    }

    let emit_path = key.clone();
    let watcher = path_watcher(PathBuf::from(&key), move || {
        let _ = app.emit("md://changed", serde_json::json!({ "path": emit_path }));
    })?;
    map.insert(key, (watcher, 1));
    Ok(())
}

#[tauri::command]
pub fn unwatch_file(state: tauri::State<'_, FileWatchers>, path: String) -> Result<(), String> {
    let key = normalize(&path);
    let mut map = state.0.lock().map_err(|e| e.to_string())?;

    if let Some(entry) = map.get_mut(&key) {
        if entry.1 <= 1 {
            map.remove(&key); // drop do watcher para o watch
        } else {
            entry.1 -= 1;
        }
    }
    Ok(())
}

/// Where a path printed in a terminal really is. Agents often write in another
/// git worktree of the project while the pane stays in the main checkout, so
/// when a relative path is not under `cwd` it is looked up under every worktree
/// root, and under the worktree whose folder is the path's first segment
/// (`repo-feature/docs/x.md`). A missing absolute path inside one checkout is
/// looked up at the same place in the others. The most recently modified match
/// wins.
#[tauri::command]
pub async fn find_relative_path(cwd: String, path: String) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        find_relative_path_inner(Path::new(cwd.trim()), path.trim())
    })
    .await
    .ok()
    .flatten()
    .map(|found| found.to_string_lossy().into_owned())
}

fn find_relative_path_inner(cwd: &Path, path: &str) -> Option<PathBuf> {
    let path = Path::new(path);
    if path.as_os_str().is_empty() {
        return None;
    }
    // Collecting the components turns git's `C:/...` into native separators.
    let direct: PathBuf = cwd.join(path).components().collect();
    if direct.exists() {
        return Some(direct);
    }

    let output = crate::git_control::git_command(cwd, &["worktree", "list", "--porcelain"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let roots: Vec<PathBuf> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .map(PathBuf::from)
        .collect();
    let candidates: Vec<PathBuf> = if path.has_root() {
        // The innermost checkout holding it, since a worktree can live inside the main one.
        let inner = roots
            .iter()
            .filter_map(|root| strip_checkout(path, root))
            .min_by_key(|inner| inner.components().count())?;
        roots.iter().map(|root| root.join(&inner)).collect()
    } else {
        let mut components = path.components();
        let first = components.next()?.as_os_str().to_owned();
        let rest = components.as_path();
        roots
            .iter()
            .flat_map(|root| {
                let named = (root.file_name() == Some(first.as_os_str())).then(|| root.join(rest));
                [Some(root.join(path)), named]
            })
            .flatten()
            .collect()
    };
    candidates
        .into_iter()
        .filter_map(|candidate| {
            let modified = fs::metadata(&candidate).ok()?.modified().ok()?;
            Some((modified, candidate.components().collect::<PathBuf>()))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, candidate)| candidate)
}

/// `path` relative to the checkout `root`, refused unless it is plain names: joined to the other
/// checkouts, a `..` would lead out of them. Windows compares the components as its file system
/// does; the separators never matter since both are parsed as such.
fn strip_checkout(path: &Path, root: &Path) -> Option<PathBuf> {
    let mut rest = path.components();
    for part in root.components() {
        let next = rest.next()?;
        let same = if cfg!(windows) {
            windows_key(part) == windows_key(next)
        } else {
            part == next
        };
        if !same {
            return None;
        }
    }
    rest.clone()
        .all(|part| matches!(part, Component::Normal(_)))
        .then(|| rest.as_path().to_path_buf())
}

/// A path component without case, reading a verbatim prefix (`\\?\C:`, `\\?\UNC\server\share`)
/// as the plain one it stands for.
fn windows_key(part: Component) -> String {
    let key = match part {
        Component::Prefix(prefix) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => format!("{}:", drive as char),
            Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                format!(
                    r"\\{}\{}",
                    server.to_string_lossy(),
                    share.to_string_lossy()
                )
            }
            _ => part.as_os_str().to_string_lossy().into_owned(),
        },
        _ => part.as_os_str().to_string_lossy().into_owned(),
    };
    key.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_control::checked_output;
    use std::sync::mpsc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn scratch(tag: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("alethe-watch-{tag}-{suffix}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // A folder target reports the files written directly inside it, such as a new night diary.
    #[test]
    fn a_watched_folder_reports_a_file_written_inside_it() {
        let dir = scratch("folder");
        let folder = dir.join("noites");
        fs::create_dir_all(&folder).unwrap();
        let (sender, changes) = mpsc::channel();
        let _watcher = path_watcher(folder.clone(), move || {
            let _ = sender.send(());
        })
        .unwrap();

        fs::write(folder.join("2026-10-03.json"), "{}").unwrap();
        assert!(changes.recv_timeout(Duration::from_secs(5)).is_ok());
        drop(_watcher);
        let _ = fs::remove_dir_all(&dir);
    }

    // A file target keeps its behaviour: its own changes count, its siblings' do not.
    #[test]
    fn a_watched_file_reports_only_itself() {
        let dir = scratch("file");
        let file = dir.join("campanhas.json");
        fs::write(&file, "{}").unwrap();
        let (sender, changes) = mpsc::channel();
        let _watcher = path_watcher(file.clone(), move || {
            let _ = sender.send(());
        })
        .unwrap();

        fs::write(dir.join("other.json"), "{}").unwrap();
        assert!(changes.recv_timeout(Duration::from_millis(700)).is_err());
        fs::write(&file, "{\"edited\": true}").unwrap();
        assert!(changes.recv_timeout(Duration::from_secs(5)).is_ok());
        drop(_watcher);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_a_relative_path_in_a_sibling_worktree() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let parent = std::env::temp_dir().join(format!("alethe-relative-path-{suffix}"));
        let main = parent.join("repo");
        fs::create_dir_all(&main).unwrap();
        checked_output(&main, &["init", "-b", "main"]).unwrap();
        checked_output(&main, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(&main, &["config", "user.email", "alethe@example.invalid"]).unwrap();
        fs::write(main.join("a.txt"), "a\n").unwrap();
        checked_output(&main, &["add", "-A"]).unwrap();
        checked_output(&main, &["commit", "-m", "base"]).unwrap();
        // Two sibling worktrees holding the same report, so the newest one has to be picked.
        let add_report = |name: &str| {
            let worktree = parent.join(name);
            checked_output(
                &main,
                &[
                    "worktree",
                    "add",
                    "-b",
                    name,
                    worktree.to_str().unwrap(),
                    "HEAD",
                ],
            )
            .unwrap();
            fs::create_dir_all(worktree.join("docs")).unwrap();
            let report = worktree.join("docs").join("report.md");
            fs::write(&report, name).unwrap();
            report
        };
        let feature = add_report("repo-feature");
        let other = add_report("repo-other");
        let touch = |path: &Path, hours_ago: u64| {
            let at = SystemTime::now() - std::time::Duration::from_secs(hours_ago * 3600);
            let file = fs::File::options().write(true).open(path).unwrap();
            file.set_modified(at).unwrap();
        };

        assert_eq!(
            find_relative_path_inner(&main, "a.txt"),
            Some(main.join("a.txt"))
        );
        assert_eq!(
            find_relative_path_inner(&main, "repo-feature/docs/report.md"),
            Some(feature.clone())
        );
        assert_eq!(find_relative_path_inner(&main, "docs/missing.md"), None);
        touch(&other, 2);
        assert_eq!(
            find_relative_path_inner(&main, "docs/report.md"),
            Some(feature.clone())
        );
        touch(&feature, 3);
        assert_eq!(
            find_relative_path_inner(&main, "docs/report.md"),
            Some(other)
        );

        for name in ["repo-feature", "repo-other"] {
            let worktree = parent.join(name);
            let _ = checked_output(
                &main,
                &["worktree", "remove", "--force", worktree.to_str().unwrap()],
            );
        }
        let _ = fs::remove_dir_all(&parent);
    }

    // An agent in the main checkout prints the absolute path of a file that only exists, untracked,
    // in a sibling worktree (#54).
    #[test]
    fn finds_an_absolute_path_of_another_checkout() {
        let parent = scratch("absolute-path");
        let main = parent.join("repo");
        fs::create_dir_all(&main).unwrap();
        checked_output(&main, &["init", "-b", "main"]).unwrap();
        checked_output(&main, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(&main, &["config", "user.email", "alethe@example.invalid"]).unwrap();
        fs::write(main.join("a.txt"), "a\n").unwrap();
        checked_output(&main, &["add", "-A"]).unwrap();
        checked_output(&main, &["commit", "-m", "base"]).unwrap();
        let add_worktree = |worktree: &Path, branch: &str| {
            let at = worktree.to_str().unwrap();
            checked_output(&main, &["worktree", "add", "-b", branch, at, "HEAD"]).unwrap();
        };
        let night = parent.join("repo-night");
        add_worktree(&night, "night");
        // Nested like Claude Code's own worktrees: the path belongs to it, not to the main checkout.
        let nested = main.join(".claude").join("worktrees").join("nested");
        add_worktree(&nested, "nested");
        fs::create_dir_all(night.join("docs")).unwrap();
        let handoff = night.join("docs").join("handoff.md");
        fs::write(&handoff, "night").unwrap();
        let find = |path: &Path| find_relative_path_inner(&main, path.to_str().unwrap());

        assert_eq!(find(&main.join("a.txt")), Some(main.join("a.txt")));
        assert_eq!(
            find(&main.join("docs").join("handoff.md")),
            Some(handoff.clone())
        );
        assert_eq!(
            find(&nested.join("docs").join("handoff.md")),
            Some(handoff.clone())
        );
        assert_eq!(find(&parent.join("docs").join("handoff.md")), None);
        assert_eq!(find(&main.join("docs").join("missing.md")), None);
        // A `..` never carries the lookup out of a checkout: joined to the nested worktree, the one
        // printed from the main checkout would reach a file that no checkout holds.
        fs::write(nested.join("..").join("private.md"), "private").unwrap();
        assert_eq!(find(&main.join("..").join("private.md")), None);
        if cfg!(windows) {
            // Windows compares checkouts without case, whichever separator was printed.
            let printed = format!("{}/docs/handoff.md", main.to_str().unwrap().to_uppercase());
            assert_eq!(
                find_relative_path_inner(&main, &printed.replace('\\', "/")),
                Some(handoff.clone())
            );
            // A verbatim path names the same checkout.
            let verbatim = format!(r"\\?\{}", main.join("docs").join("handoff.md").display());
            assert_eq!(
                find_relative_path_inner(&main, &verbatim),
                Some(handoff.clone())
            );
        }

        for worktree in [&night, &nested] {
            let at = worktree.to_str().unwrap();
            let _ = checked_output(&main, &["worktree", "remove", "--force", at]);
        }
        let _ = fs::remove_dir_all(&parent);
    }

    // Git prints `//server/share/repo`; a printed path may come canonicalized, as `\\?\UNC\...`.
    #[cfg(windows)]
    #[test]
    fn a_verbatim_prefix_names_the_same_checkout() {
        let inner = Some(PathBuf::from(r"docs\x.md"));
        assert_eq!(
            strip_checkout(
                Path::new(r"\\?\UNC\server\share\repo\docs\x.md"),
                Path::new("//server/share/repo")
            ),
            inner
        );
        assert_eq!(
            strip_checkout(Path::new(r"\\?\c:\Repo\docs\x.md"), Path::new("C:/repo")),
            inner
        );
        assert_eq!(
            strip_checkout(
                Path::new(r"\\other\share\repo\docs\x.md"),
                Path::new("//server/share/repo")
            ),
            None
        );
    }
}
