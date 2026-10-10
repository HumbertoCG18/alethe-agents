use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

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

/// Automatic discovery is development documentation, never a recursive content browser.
fn development_markdown(path: &Path) -> bool {
    let parts: Vec<_> = path.components().collect();
    if parts.iter().any(|p| !matches!(p, Component::Normal(_))) {
        return false;
    }
    if !path.extension().is_some_and(|e| {
        matches!(
            e.to_string_lossy().to_lowercase().as_str(),
            "md" | "markdown" | "mdx"
        )
    }) {
        return false;
    }
    if parts.len() == 1 {
        return true;
    }
    matches!(
        parts[0]
            .as_os_str()
            .to_string_lossy()
            .to_lowercase()
            .as_str(),
        "docs"
            | "doc"
            | "documentation"
            | ".workflow"
            | ".mex"
            | ".github"
            | ".agents"
            | ".alethe"
            | ".superpowers"
            | ".planning"
            | "campaigns"
            | "campanhas"
            | "reports"
            | "relatorios"
            | "handoffs"
            | "planning"
    ) && !parts[..parts.len() - 1].iter().any(|p| {
        matches!(
            p.as_os_str().to_string_lossy().to_lowercase().as_str(),
            ".git"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".venv"
                | "venv"
                | "__pycache__"
        )
    })
}

fn plain_catalog_file(root: &Path, path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file()) && plain_entry(root, path)
}

/// Neither a link nor, on Windows, a reparse point, and really under the canonical `root`.
fn plain_entry(root: &Path, path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    path.canonicalize().is_ok_and(|p| p.starts_with(root))
}

/// Bounded fallback for folders outside Git: only conventional development-document roots.
fn project_markdown_paths(root: &Path) -> Result<Vec<String>, String> {
    let canonical = root.canonicalize().map_err(|_| "directory not found")?;
    if !root.is_dir() {
        return Err("directory not found".into());
    }
    let started = std::time::Instant::now();
    let mut pending = vec![root.to_path_buf()];
    let mut paths = Vec::new();
    let mut entries = 0;
    while let Some(directory) = pending.pop() {
        for entry in
            fs::read_dir(&directory).map_err(|e| format!("{}: {e}", directory.display()))?
        {
            entries += 1;
            if entries > 25_000 || started.elapsed() > std::time::Duration::from_secs(2) {
                return Err("Development documentation scan exceeded its limit; open specific documents manually".into());
            }
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                continue;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if entry
                    .metadata()
                    .map_err(|e| e.to_string())?
                    .file_attributes()
                    & 0x400
                    != 0
                {
                    continue;
                }
            }
            let path = entry.path();
            let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
            if kind.is_dir() {
                // A hypothetical document identifies whether this directory belongs to the index.
                if development_markdown(&relative.join("document.md"))
                    && !path.join(".git").exists()
                {
                    pending.push(path);
                }
            } else if development_markdown(relative) && plain_catalog_file(&canonical, &path) {
                paths.push(path.to_string_lossy().into_owned());
            }
        }
    }
    paths.sort();
    Ok(paths)
}

#[tauri::command]
pub async fn list_project_markdown(path: String) -> Result<Vec<String>, String> {
    let root = PathBuf::from(path.trim());
    if !root.is_dir() {
        return Err("directory not found".into());
    }
    let output = crate::cli_resolver::background_output(
        Path::new("git"),
        &[
            "-C",
            root.to_string_lossy().as_ref(),
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ":(icase)*.md",
            ":(icase)*.markdown",
            ":(icase)*.mdx",
        ],
        std::time::Duration::from_secs(8),
    )
    .await;
    if let Ok(output) = output {
        return tauri::async_runtime::spawn_blocking(move || {
            let canonical = root.canonicalize().map_err(|e| e.to_string())?;
            let mut paths: Vec<String> = output
                .stdout
                .split(|b| *b == 0)
                .filter(|p| !p.is_empty())
                .filter_map(|bytes| {
                    let relative = PathBuf::from(String::from_utf8_lossy(bytes).as_ref());
                    let file = root.join(&relative);
                    (development_markdown(&relative) && plain_catalog_file(&canonical, &file))
                        .then(|| file.to_string_lossy().into_owned())
                })
                .collect();
            paths.sort();
            paths.dedup();
            Ok(paths)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    if root.join(".git").exists() {
        return Err("Could not index development documents with Git; retry discovery".into());
    }
    tauri::async_runtime::spawn_blocking(move || project_markdown_paths(&root))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct DirectoryEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: Option<u64>,
}

#[tauri::command]
pub async fn list_directory(path: String) -> Result<Vec<DirectoryEntry>, String> {
    tokio::task::spawn_blocking(move || list_directory_inner(path))
        .await
        .map_err(|error| format!("list_directory: blocking task failed: {error}"))?
}

fn list_directory_inner(path: String) -> Result<Vec<DirectoryEntry>, String> {
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
        for distro in crate::wsl::installed_distros() {
            roots.push(crate::wsl::distro_root_unc(&distro));
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

pub fn strip_extended_prefix(path: &str) -> String {
    path.strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| path.strip_prefix(r"\\?\").map(str::to_string))
        .unwrap_or_else(|| path.to_string())
}

#[tauri::command]
pub async fn browse_directory(path: String) -> Result<DirectoryListing, String> {
    tokio::task::spawn_blocking(move || browse_directory_inner(path))
        .await
        .map_err(|error| format!("browse_directory: blocking task failed: {error}"))?
}

fn browse_directory_inner(path: String) -> Result<DirectoryListing, String> {
    let home = get_home_dir();
    let trimmed = path.trim();
    let directory = if trimmed.is_empty() || trimmed == "~" {
        home.clone()
    } else {
        let p = PathBuf::from(trimmed);
        if p.exists() {
            if p.is_file() {
                p.parent()
                    .map(|parent| parent.to_path_buf())
                    .unwrap_or(home.clone())
            } else {
                p
            }
        } else {
            home.clone()
        }
    };

    let canonical = directory
        .canonicalize()
        .unwrap_or_else(|_| directory.clone());
    let current_path_str = canonical.to_string_lossy().into_owned();
    let clean_current_path = strip_extended_prefix(&current_path_str);

    let parent_path = canonical
        .parent()
        .map(|p| strip_extended_prefix(&p.to_string_lossy()));

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
                let clean_path = strip_extended_prefix(&entry.path().to_string_lossy());
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

    let home_path = strip_extended_prefix(&home.to_string_lossy());

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

/// Reads a text file. "file not found" means nothing is at the path; something else there, such
/// as a folder, is "not a file", and a path that cannot be checked gives the system's reason.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let file = PathBuf::from(path.trim());
    existing_file(&file)?;
    fs::read_to_string(&file).map_err(|error| error.to_string())
}

fn existing_file(file: &Path) -> Result<(), String> {
    match file.try_exists() {
        Ok(false) => Err("file not found".to_string()),
        Err(error) => Err(error.to_string()),
        Ok(true) if !file.is_file() => Err("not a file".to_string()),
        Ok(true) => Ok(()),
    }
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
pub struct FileWatchers(
    pub Arc<Mutex<HashMap<String, (RecommendedWatcher, HashMap<String, usize>)>>>,
);

pub(crate) fn release_window_watchers(state: &FileWatchers, label: &str) {
    if let Ok(mut map) = state.0.lock() {
        map.retain(|_, (_, owners)| {
            owners.remove(label);
            !owners.is_empty()
        });
    }
}

/// Drops every watch on a path inside `root` (canonical), whoever holds it, so the folder can
/// leave the disk: on Windows a watched folder blocks the removal of its parent.
pub(crate) fn release_watchers_under<T>(watchers: &Mutex<HashMap<String, T>>, root: &Path) {
    let inside = |key: &String| {
        let path = Path::new(key);
        [Some(path), path.parent()]
            .into_iter()
            .flatten()
            .find_map(|candidate| candidate.canonicalize().ok())
            .is_some_and(|found| found.starts_with(root))
    };
    if let Ok(mut map) = watchers.lock() {
        map.retain(|key, _| !inside(key));
    }
}

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
    // Events can carry the canonical spelling instead: macOS reports `/private/var/...` for a
    // target under `/var/...`.
    let real = watched_dir.canonicalize().ok().and_then(|dir| {
        if folder {
            Some(dir)
        } else {
            target.file_name().map(|name| dir.join(name))
        }
    });
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            if !matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                return;
            }
            let concerns = |path: &PathBuf| {
                [Some(&target), real.as_ref()]
                    .into_iter()
                    .flatten()
                    .any(|wanted| {
                        path == wanted || (folder && path.parent() == Some(wanted.as_path()))
                    })
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
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileWatchers>,
    path: String,
) -> Result<(), String> {
    let key = normalize(&path);
    let mut map = state.0.lock().map_err(|e| e.to_string())?;

    if app.get_webview_window(window.label()).is_none() {
        return Err("Window closed".into());
    }
    if let Some(entry) = map.get_mut(&key) {
        *entry.1.entry(window.label().into()).or_default() += 1;
        return Ok(());
    }

    let emit_path = key.clone();
    let watcher = path_watcher(PathBuf::from(&key), move || {
        let _ = app.emit("md://changed", serde_json::json!({ "path": emit_path }));
    })?;
    map.insert(key, (watcher, HashMap::from([(window.label().into(), 1)])));
    Ok(())
}

#[tauri::command]
pub fn unwatch_file(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileWatchers>,
    path: String,
) -> Result<(), String> {
    let key = normalize(&path);
    let mut map = state.0.lock().map_err(|e| e.to_string())?;

    if let Some(entry) = map.get_mut(&key) {
        if let Some(count) = entry.1.get_mut(window.label()) {
            *count -= 1;
            if *count == 0 {
                entry.1.remove(window.label());
            }
        }
        if entry.1.is_empty() {
            map.remove(&key);
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

pub(crate) const OUTSIDE_REPOSITORY: &str = "outside_repository";

/// `find_relative_path` for a path named by repository text (campaign registry, night diary): the
/// match must be a plain file or folder inside a checkout, not reached through a link (the rule of
/// the Markdown catalog's scan), else the lookup fails with `OUTSIDE_REPOSITORY`.
#[tauri::command]
pub async fn find_repository_file(cwd: String, path: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let cwd = Path::new(cwd.trim());
        match find_relative_path_inner(cwd, path.trim()) {
            Some(found) if !in_checkouts(cwd, &found) => Err(OUTSIDE_REPOSITORY.to_string()),
            found => Ok(found.map(|found| found.to_string_lossy().into_owned())),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// `read_text_file` for a path named by repository text. The file is opened once and that open file
/// is what is checked against `cwd`'s checkouts and then read, so a link swapped in after the lookup,
/// or between the check and the read, is refused too.
#[tauri::command]
pub async fn read_repository_text_file(cwd: String, path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut opened = open_in_checkouts(&cwd, &path, false)?;
        let mut text = String::new();
        opened
            .read_to_string(&mut text)
            .map_err(|error| error.to_string())?;
        Ok(text)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The largest file `read_repository_file_base64` returns: 32 MiB, about 43 MB once encoded.
const MAX_REPOSITORY_FILE_BYTES: u64 = 32 * 1024 * 1024;

/// `read_repository_text_file` for an image, as base64 for a `data:` URL (the CSP's `img-src` has no
/// `blob:`); "file too large" past `MAX_REPOSITORY_FILE_BYTES`.
#[tauri::command]
pub async fn read_repository_file_base64(cwd: String, path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        use base64::Engine;
        use std::io::Read;
        let mut bytes = Vec::new();
        open_in_checkouts(&cwd, &path, false)?
            .take(MAX_REPOSITORY_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_REPOSITORY_FILE_BYTES {
            return Err("file too large".to_string());
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Whether the file at `path` is inside `cwd`'s checkouts right now, by the same open-file check as
/// `read_repository_text_file`, for a video the player then loads by path.
#[tauri::command]
pub async fn check_repository_file(cwd: String, path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || open_in_checkouts(&cwd, &path, false).map(drop))
        .await
        .map_err(|error| error.to_string())?
}

/// `write_text_file` for a file pane opened from repository text: the existing file is opened
/// without following a last-component link, checked like `read_repository_text_file`, and only
/// then truncated and written through that same handle, so no link leads the write out of the
/// checkouts.
#[tauri::command]
pub async fn write_repository_text_file(
    cwd: String,
    path: String,
    content: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        let mut opened = open_in_checkouts(&cwd, &path, true)?;
        opened
            .set_len(0)
            .and_then(|()| opened.write_all(content.as_bytes()))
            .and_then(|()| opened.flush())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Opens the existing file at `path`, for writing too when `write`, without following a link at its
/// last component, and keeps it only when that open file lies inside `cwd`'s checkouts.
fn open_in_checkouts(cwd: &str, path: &str, write: bool) -> Result<fs::File, String> {
    let file = PathBuf::from(path.trim());
    existing_file(&file)?;
    let opened = open_unlinked(&file, write).map_err(|error| {
        // O_NOFOLLOW refuses a symlink at the last component.
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ELOOP) {
            return OUTSIDE_REPOSITORY.to_string();
        }
        error.to_string()
    })?;
    if !opened_inside(&opened, &canonical_checkouts(Path::new(cwd.trim()))) {
        return Err(OUTSIDE_REPOSITORY.to_string());
    }
    Ok(opened)
}

/// Opens `path` for reading, and writing when `write`, without following a link at its last
/// component. Nothing is truncated or created.
fn open_unlinked(path: &Path, write: bool) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(write);
    #[cfg(windows)]
    std::os::windows::fs::OpenOptionsExt::custom_flags(
        &mut options,
        windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
    );
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    options.open(path)
}

/// Whether the open `file` is a plain file under one of the canonical `roots`, by the place the
/// system reports for the open file itself: no path is resolved again, so no swap can match it.
/// A file with another hard link is refused too: that name may lie outside the roots, and a read
/// or write through this one reaches the same content.
fn opened_inside(file: &fs::File, roots: &[PathBuf]) -> bool {
    let Ok(metadata) = file.metadata() else {
        return false;
    };
    #[cfg(windows)]
    let plain = {
        use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
        let mut information = Default::default();
        // SAFETY: the handle is open for the whole call, which only fills `information`.
        let read =
            unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) };
        metadata.is_file()
            && metadata.file_attributes() & 0x400 == 0
            && read != 0
            && information.nNumberOfLinks == 1
    };
    #[cfg(not(windows))]
    let plain = {
        use std::os::unix::fs::MetadataExt;
        metadata.is_file() && metadata.nlink() == 1
    };
    plain && final_path(file).is_some_and(|real| roots.iter().any(|root| real.starts_with(root)))
}

/// The place of the open `file`, as the system resolved it; `None` where the system cannot tell,
/// which refuses the read.
#[cfg(unix)]
fn final_path(file: &fs::File) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::io::AsRawFd;
        fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::{ffi::OsStrExt, io::AsRawFd};
        let mut buffer = vec![0u8; libc::PATH_MAX as usize];
        // SAFETY: F_GETPATH writes a NUL-terminated path of at most MAXPATHLEN (PATH_MAX) bytes.
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
            return None;
        }
        let end = buffer.iter().position(|&byte| byte == 0)?;
        Some(std::ffi::OsStr::from_bytes(&buffer[..end]).into())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = file;
        None
    }
}

/// The path of the open `file`, spelled as `canonicalize` spells it (`\\?\C:\...`).
#[cfg(windows)]
fn final_path(file: &fs::File) -> Option<PathBuf> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let mut buffer = vec![0u16; 512];
    loop {
        // SAFETY: the handle is open for the whole call, which writes at most `buffer.len()` units.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle() as _,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        } as usize;
        match length {
            0 => return None,
            fits if fits < buffer.len() => {
                return Some(std::ffi::OsString::from_wide(&buffer[..fits]).into())
            }
            needed => buffer.resize(needed, 0),
        }
    }
}

/// Whether `path` passes `plain_entry` under one of the checkouts of `cwd`'s repository, or under
/// `cwd` itself outside git.
pub(crate) fn in_checkouts(cwd: &Path, path: &Path) -> bool {
    canonical_checkouts(cwd)
        .iter()
        .any(|root| plain_entry(root, path))
}

/// The canonical roots of `cwd`'s checkouts, or of `cwd` itself outside git.
fn canonical_checkouts(cwd: &Path) -> Vec<PathBuf> {
    checkout_roots(cwd)
        .unwrap_or_else(|| vec![cwd.to_path_buf()])
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .collect()
}

/// The roots of every checkout of `cwd`'s repository, as git lists them.
fn checkout_roots(cwd: &Path) -> Option<Vec<PathBuf>> {
    let output = crate::git_control::git_command(cwd, &["worktree", "list", "--porcelain"]).ok()?;
    if !output.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.strip_prefix("worktree "))
            .map(PathBuf::from)
            .collect(),
    )
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

    let roots = checkout_roots(cwd)?;
    let candidates: Vec<PathBuf> = if path.has_root() {
        // The innermost checkout holding it, since a worktree can live inside the main one. A path
        // spelled unlike git's roots (a `RUNNER~1` short name, macOS `/var` for `/private/var`) is
        // matched through the canonical spelling of both.
        let inner = innermost_inside(path, roots.iter().cloned()).or_else(|| {
            innermost_inside(
                &canonical_spelling(path)?,
                roots.iter().filter_map(|root| root.canonicalize().ok()),
            )
        })?;
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

/// `path` relative to the innermost of `roots` that holds it.
fn innermost_inside(path: &Path, roots: impl Iterator<Item = PathBuf>) -> Option<PathBuf> {
    roots
        .filter_map(|root| strip_checkout(path, &root))
        .min_by_key(|inner| inner.components().count())
}

/// `path` with its deepest existing ancestor canonicalized, since the file itself may exist only
/// in another checkout.
fn canonical_spelling(path: &Path) -> Option<PathBuf> {
    let (base, real) = path
        .ancestors()
        .find_map(|base| base.canonicalize().ok().map(|real| (base, real)))?;
    Some(real.join(path.strip_prefix(base).ok()?))
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

    #[test]
    fn markdown_catalog_includes_nested_reports_but_skips_dependencies() {
        let root = scratch("markdown-catalog");
        for name in [
            "docs/reports/deep/result.MD",
            ".workflow/campaigns/run.md",
            "node_modules/pkg/no.md",
            "target/no.md",
            "docs/readme.txt",
        ] {
            let file = root.join(name);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, "test").unwrap();
        }
        let found = project_markdown_paths(&root).unwrap();
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found.iter().any(|p| p.ends_with("result.MD")));
        assert!(found.iter().any(|p| p.ends_with("run.md")));
        assert!(project_markdown_paths(&root.join("missing")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn catalog_excludes_ignored_artifacts_and_tutor_content() {
        let root = scratch("development-catalog");
        checked_output(&root, &["init"]).unwrap();
        fs::write(root.join(".gitignore"), ".frzero/\n").unwrap();
        for name in [
            "docs/reports/real.md",
            ".workflow/campaigns/open.md",
            ".frzero/tutor.md",
            "tutors/student.md",
        ] {
            let file = root.join(name);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, "test").unwrap();
        }
        checked_output(&root, &["add", "."]).unwrap();
        let paths = list_project_markdown(root.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(paths.len(), 2, "{paths:?}");
        assert!(paths.iter().any(|p| p.ends_with("real.md")));
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    #[ignore = "Requires an explicit local development repository"]
    async fn measure_development_catalog() {
        let root =
            std::env::var("ALETHE_CATALOG_BENCH_ROOT").expect("Provide the repository to measure");
        let start = std::time::Instant::now();
        let files = list_project_markdown(root).await.unwrap();
        println!(
            "Development catalog: {} files in {:.3} seconds",
            files.len(),
            start.elapsed().as_secs_f64()
        );
        assert!(!files.is_empty());
        assert!(files
            .iter()
            .all(|p| !p.replace('\\', "/").contains("/.frzero/")));
    }

    #[test]
    fn closing_window_releases_only_its_watches() {
        let dir = scratch("window");
        let state = FileWatchers::default();
        state.0.lock().unwrap().insert(
            "shared".into(),
            (
                path_watcher(dir.clone(), || {}).unwrap(),
                HashMap::from([("main".into(), 1), ("reader".into(), 2)]),
            ),
        );
        release_window_watchers(&state, "reader");
        assert_eq!(
            state.0.lock().unwrap()["shared"].1,
            HashMap::from([("main".into(), 1)])
        );
        release_window_watchers(&state, "main");
        assert!(state.0.lock().unwrap().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    // Only a path with nothing at it reads as missing: a folder in its place is another failure.
    #[test]
    fn tells_a_missing_file_from_a_path_that_is_no_file() {
        let dir = scratch("read");
        let missing = dir.join("campanhas.json");
        assert_eq!(
            read_text_file(missing.to_string_lossy().into_owned()),
            Err("file not found".to_string())
        );
        fs::create_dir_all(&missing).unwrap();
        assert_eq!(
            read_text_file(missing.to_string_lossy().into_owned()),
            Err("not a file".to_string())
        );
        let file = dir.join("ok.json");
        fs::write(&file, "{}").unwrap();
        assert_eq!(
            read_text_file(file.to_string_lossy().into_owned()),
            Ok("{}".to_string())
        );
        fs::remove_dir_all(&dir).ok();
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
        let (sender, changes) = mpsc::channel();
        // The file is written only after the watch starts: FSEvents (macOS) can deliver a write
        // made just before its stream began, which then lands in the sibling's window below.
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

        // The temp folder has aliases git does not print (`/var` is `/private/var` on macOS, and
        // Windows may hand out an 8.3 short name), so a match is compared by the file it names.
        let found = |path: &str| {
            find_relative_path_inner(&main, path).map(|found| fs::canonicalize(found).unwrap())
        };
        let resolved = |path: &Path| Some(fs::canonicalize(path).unwrap());

        assert_eq!(found("a.txt"), resolved(&main.join("a.txt")));
        assert_eq!(found("repo-feature/docs/report.md"), resolved(&feature));
        assert_eq!(found("docs/missing.md"), None);
        touch(&other, 2);
        assert_eq!(found("docs/report.md"), resolved(&feature));
        touch(&feature, 3);
        assert_eq!(found("docs/report.md"), resolved(&other));

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
        // Compared canonically: git and the temp folder may spell one path differently (a
        // `RUNNER~1` short name on Windows runners, `/private/var` on macOS).
        let real = |found: Option<PathBuf>| found.map(|found| fs::canonicalize(found).unwrap());
        let find = |path: &Path| real(find_relative_path_inner(&main, path.to_str().unwrap()));
        let handoff = fs::canonicalize(&handoff).unwrap();

        assert_eq!(
            find(&main.join("a.txt")),
            Some(fs::canonicalize(main.join("a.txt")).unwrap())
        );
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
                real(find_relative_path_inner(&main, &printed.replace('\\', "/"))),
                Some(handoff.clone())
            );
            // A verbatim path names the same checkout.
            let verbatim = format!(r"\\?\{}", main.join("docs").join("handoff.md").display());
            assert_eq!(
                real(find_relative_path_inner(&main, &verbatim)),
                Some(handoff.clone())
            );
        }

        for worktree in [&night, &nested] {
            let at = worktree.to_str().unwrap();
            let _ = checked_output(&main, &["worktree", "remove", "--force", at]);
        }
        let _ = fs::remove_dir_all(&parent);
    }

    /// A junction on Windows, a symlink elsewhere. The tests that need it fail without it.
    fn link_directory(link: &Path, target: &Path) {
        #[cfg(windows)]
        {
            let output = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .expect("cmd could not run mklink");
            assert!(
                output.status.success(),
                "mklink /J could not create the junction: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).expect("could not create the symlink");
    }

    // Repository text (registry, night diary) names files in the checkouts: a link in one must not
    // lead the lookup or the read out of them (#114).
    #[tokio::test]
    async fn repository_files_reached_through_a_link_are_refused() {
        let parent = scratch("repository-file");
        let main = parent.join("repo");
        fs::create_dir_all(main.join("docs")).unwrap();
        checked_output(&main, &["init", "-b", "main"]).unwrap();
        checked_output(&main, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(&main, &["config", "user.email", "alethe@example.invalid"]).unwrap();
        fs::write(main.join("a.txt"), "a\n").unwrap();
        checked_output(&main, &["add", "-A"]).unwrap();
        checked_output(&main, &["commit", "-m", "base"]).unwrap();
        let nested = main.join(".claude").join("worktrees").join("nested");
        let at = nested.to_str().unwrap();
        checked_output(&main, &["worktree", "add", "-b", "nested", at, "HEAD"]).unwrap();
        fs::write(main.join("docs").join("plain.md"), "plain").unwrap();
        fs::create_dir_all(nested.join("docs")).unwrap();
        fs::write(nested.join("docs").join("nested.md"), "nested").unwrap();
        let outside = parent.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("report.md"), "private").unwrap();
        let text = |path: &Path| path.to_string_lossy().into_owned();
        let find = |cwd: &Path, path: &str| find_repository_file(text(cwd), path.into());
        let read = |path: &Path| read_repository_text_file(text(&main), text(path));
        let refused = Some(OUTSIDE_REPOSITORY.to_string());

        assert!(matches!(find(&main, "docs/plain.md").await, Ok(Some(_))));
        assert_eq!(
            read(&main.join("docs").join("plain.md")).await,
            Ok("plain".into())
        );
        assert_eq!(find(&main, "docs/missing.md").await, Ok(None));
        // A worktree inside the main checkout is still one of the checkouts.
        assert!(matches!(find(&nested, "docs/nested.md").await, Ok(Some(_))));
        let inner = nested.join("docs").join("nested.md");
        assert!(matches!(find(&main, &text(&inner)).await, Ok(Some(_))));
        assert_eq!(read(&inner).await, Ok("nested".into()));
        // Outside git, the folder itself is the checkout.
        assert!(matches!(find(&outside, "report.md").await, Ok(Some(_))));

        let linked = main.join("linked");
        link_directory(&linked, &outside);
        assert_eq!(find(&main, "linked/report.md").await.err(), refused);
        assert_eq!(find(&main, "linked").await.err(), refused);
        assert_eq!(read(&linked.join("report.md")).await.err(), refused);
        // A file the user picks still opens through the link.
        assert_eq!(
            read_text_file(text(&linked.join("report.md"))),
            Ok("private".into())
        );
        let _ = fs::remove_dir(&linked).or_else(|_| fs::remove_file(&linked));
        #[cfg(unix)]
        {
            let link = main.join("docs").join("link.md");
            std::os::unix::fs::symlink(outside.join("report.md"), &link).unwrap();
            assert_eq!(find(&main, "docs/link.md").await.err(), refused);
            assert_eq!(read(&link).await.err(), refused);
        }

        let _ = checked_output(&main, &["worktree", "remove", "--force", at]);
        let _ = fs::remove_dir_all(&parent);
    }

    // The read checks the file it opened, not its path a second time: a link there at the open and
    // gone before the check still reads as outside, even though the path now names a file inside.
    #[test]
    fn the_read_checks_the_file_it_opened_not_the_path() {
        let parent = scratch("repository-swap");
        let main = parent.join("repo");
        let outside = parent.join("outside");
        fs::create_dir_all(&main).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("report.md"), "private").unwrap();
        let docs = main.join("docs");
        let path = docs.join("report.md");
        let roots = [main.canonicalize().unwrap()];

        link_directory(&docs, &outside);
        let opened = open_unlinked(&path, false).unwrap();
        fs::remove_dir(&docs)
            .or_else(|_| fs::remove_file(&docs))
            .unwrap();
        fs::create_dir_all(&docs).unwrap();
        fs::write(&path, "inside").unwrap();
        assert!(in_checkouts(&main, &path));
        assert!(!opened_inside(&opened, &roots));
        drop(opened);
        assert!(opened_inside(&open_unlinked(&path, false).unwrap(), &roots));
        let _ = fs::remove_dir_all(&parent);
    }

    // The open file names its own place, whatever link led to it: the check never resolves a path
    // again, so no later swap can make it match (/proc/self/fd on Linux, F_GETPATH on macOS,
    // GetFinalPathNameByHandleW on Windows).
    #[test]
    fn an_open_file_reports_its_real_place_behind_a_linked_folder() {
        let parent = scratch("final-path");
        let main = parent.join("repo");
        let outside = parent.join("outside");
        fs::create_dir_all(&main).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("report.md"), "private").unwrap();
        link_directory(&main.join("docs"), &outside);

        let opened = open_unlinked(&main.join("docs").join("report.md"), false).unwrap();
        let real = outside.canonicalize().unwrap().join("report.md");
        assert_eq!(final_path(&opened), Some(real));
        assert!(!opened_inside(&opened, &[main.canonicalize().unwrap()]));
        drop(opened);
        let _ = fs::remove_dir(main.join("docs")).or_else(|_| fs::remove_file(main.join("docs")));
        let _ = fs::remove_dir_all(&parent);
    }

    // Images and videos opened from repository text, and saves from such a pane, hold to the
    // checkouts like its text reads (#123, #124): a link swapped in after the lookup is refused, and
    // the save never writes through it.
    #[tokio::test]
    async fn repository_media_and_saves_refuse_a_link_swapped_in_after_the_lookup() {
        let parent = scratch("repository-media");
        let main = parent.join("repo");
        let docs = main.join("docs");
        let outside = parent.join("outside");
        fs::create_dir_all(&docs).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let file = docs.join("shot.png");
        fs::write(&file, "the original content").unwrap();
        fs::write(outside.join("shot.png"), "private").unwrap();
        let text = |path: &Path| path.to_string_lossy().into_owned();
        let bytes = |path: &Path| read_repository_file_base64(text(&main), text(path));
        let check = |path: &Path| check_repository_file(text(&main), text(path));
        let save = |path: &Path, content: &str| {
            write_repository_text_file(text(&main), text(path), content.into())
        };
        let untouched = || fs::read_to_string(outside.join("shot.png")).unwrap() == "private";
        let refused = Some(OUTSIDE_REPOSITORY.to_string());

        assert!(matches!(
            find_repository_file(text(&main), "docs/shot.png".into()).await,
            Ok(Some(_))
        ));
        assert_eq!(check(&file).await, Ok(()));
        // The save replaces the whole content, even with a shorter one.
        assert_eq!(save(&file, "saved").await, Ok(()));
        assert_eq!(fs::read_to_string(&file).unwrap(), "saved");
        assert_eq!(bytes(&file).await, Ok("c2F2ZWQ=".into()));
        let large = docs.join("large.png");
        fs::File::create(&large)
            .unwrap()
            .set_len(MAX_REPOSITORY_FILE_BYTES + 1)
            .unwrap();
        assert_eq!(bytes(&large).await, Err("file too large".into()));

        // Once looked up, `docs` is swapped for a link out of the repository.
        fs::remove_dir_all(&docs).unwrap();
        link_directory(&docs, &outside);
        assert_eq!(bytes(&file).await.err(), refused);
        assert_eq!(check(&file).await.err(), refused);
        assert_eq!(save(&file, "leaked").await.err(), refused);
        assert!(untouched());
        let _ = fs::remove_dir(&docs).or_else(|_| fs::remove_file(&docs));
        #[cfg(unix)]
        {
            fs::create_dir_all(&docs).unwrap();
            let link = docs.join("link.png");
            std::os::unix::fs::symlink(outside.join("shot.png"), &link).unwrap();
            assert_eq!(bytes(&link).await.err(), refused);
            assert_eq!(check(&link).await.err(), refused);
            assert_eq!(save(&link, "leaked").await.err(), refused);
            assert!(untouched());
        }
        let _ = fs::remove_dir_all(&parent);
    }

    // A hard link in the checkout is the outside file under another name: it is refused before any
    // read or truncation.
    #[tokio::test]
    async fn repository_files_with_another_hard_link_are_refused() {
        let parent = scratch("repository-hard-link");
        let main = parent.join("repo");
        let outside = parent.join("outside");
        fs::create_dir_all(&main).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let private = outside.join("shot.png");
        fs::write(&private, "private").unwrap();
        let link = main.join("shot.png");
        fs::hard_link(&private, &link).unwrap();
        let cwd = main.to_string_lossy().into_owned();
        let path = link.to_string_lossy().into_owned();
        let refused = Some(OUTSIDE_REPOSITORY.to_string());

        let read = read_repository_text_file(cwd.clone(), path.clone());
        assert_eq!(read.await.err(), refused);
        let bytes = read_repository_file_base64(cwd.clone(), path.clone());
        assert_eq!(bytes.await.err(), refused);
        assert_eq!(
            check_repository_file(cwd.clone(), path.clone()).await.err(),
            refused
        );
        let save = write_repository_text_file(cwd, path, "leaked".into());
        assert_eq!(save.await.err(), refused);
        assert_eq!(fs::read_to_string(&private).unwrap(), "private");
        let _ = fs::remove_dir_all(&parent);
    }

    // A blank scope names no checkout, not the folder the app runs in: this crate's own files, in a
    // checkout, are refused under it.
    #[tokio::test]
    async fn a_blank_scope_refuses_every_repository_file() {
        let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let path = file.to_string_lossy().into_owned();
        let refused = Some(OUTSIDE_REPOSITORY.to_string());
        let own = check_repository_file(env!("CARGO_MANIFEST_DIR").into(), path.clone());
        assert_eq!(own.await, Ok(()));
        for cwd in ["", "  "] {
            let read = read_repository_text_file(cwd.into(), path.clone());
            assert_eq!(read.await.err(), refused);
            let bytes = read_repository_file_base64(cwd.into(), path.clone());
            assert_eq!(bytes.await.err(), refused);
            assert_eq!(
                check_repository_file(cwd.into(), path.clone()).await.err(),
                refused
            );
        }
        assert!(!in_checkouts(Path::new(""), &file));
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

    #[test]
    fn strips_the_extended_length_prefix_from_a_drive_path() {
        assert_eq!(
            strip_extended_prefix(r"\\?\C:\projects\app"),
            r"C:\projects\app"
        );
    }

    #[test]
    fn maps_an_extended_unc_path_back_to_its_double_backslash_form() {
        assert_eq!(
            strip_extended_prefix(r"\\?\UNC\wsl.localhost\Ubuntu\home\dev"),
            r"\\wsl.localhost\Ubuntu\home\dev"
        );
    }

    #[test]
    fn a_cleaned_wsl_path_is_still_parsed_as_a_wsl_path() {
        let cleaned = strip_extended_prefix(r"\\?\UNC\wsl.localhost\Ubuntu\home\dev");
        assert_eq!(
            crate::wsl::parse_wsl_unc(&cleaned).map(|target| target.distro),
            Some("Ubuntu".to_string())
        );
    }

    #[test]
    fn leaves_an_ordinary_path_untouched() {
        assert_eq!(
            strip_extended_prefix(r"C:\projects\app"),
            r"C:\projects\app"
        );
        assert_eq!(
            strip_extended_prefix(r"\\wsl.localhost\Ubuntu"),
            r"\\wsl.localhost\Ubuntu"
        );
    }
}
