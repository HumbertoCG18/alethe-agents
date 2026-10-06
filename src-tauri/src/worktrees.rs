//! RFC-003 — Worktree Manager (dual-mode).
//!

//!

//!   `<repo>/.alethe/worktrees/<id>/`, compartilhando o `.git` do repo. Nesse

//! - **LocalCopy** (pesado/mais funcional): `git clone --local` gera um repo

//!   dois modos ao listar/remover.
//!

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::filesystem::{release_watchers_under, FileWatchers};
use crate::git_control::{
    checked_output, git_command, main_repository_root, repository_root, with_lock_awareness,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeMode {
    GitWorktree,
    LocalCopy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub agent_id: String,
    pub path: String,
    pub branch: String,
    pub mode: WorktreeMode,
}

fn sanitize_id(agent_id: &str) -> Result<String, String> {
    let trimmed = agent_id.trim();
    if trimmed.is_empty() {
        return Err("invalid_agent_id".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid_agent_id".to_string());
    }
    Ok(trimmed.to_string())
}

fn worktrees_base(root: &Path) -> PathBuf {
    root.join(".alethe").join("worktrees")
}

/// Remove o prefixo verbatim `\\?\` do Windows. `repository_root` canonicaliza os

/// (ex.: destino de `worktree add`/`clone`) — como `current_dir` funciona normal

/// Windows).
pub(crate) fn git_arg(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let stripped = raw
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| raw.strip_prefix(r"\\?\").map(|rest| rest.to_string()))
        .unwrap_or_else(|| raw.into_owned());
    stripped
}

fn detect_mode(dir: &Path) -> Option<WorktreeMode> {
    let marker = dir.join(".git");
    if marker.is_file() {
        Some(WorktreeMode::GitWorktree)
    } else if marker.is_dir() {
        Some(WorktreeMode::LocalCopy)
    } else {
        None
    }
}

fn current_branch(dir: &Path) -> String {
    git_command(dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn worktree_provision(
    repo: String,
    agent_id: String,
    mode: WorktreeMode,
) -> Result<WorktreeInfo, String> {
    tokio::task::spawn_blocking(move || worktree_provision_inner(repo, agent_id, mode))
        .await
        .map_err(|error| format!("worktree_provision: falha na task bloqueante: {error}"))?
}

pub(crate) fn worktree_provision_inner(
    repo: String,
    agent_id: String,
    mode: WorktreeMode,
) -> Result<WorktreeInfo, String> {
    // dentro da outra.
    let root = main_repository_root(&repo)?;
    let id = sanitize_id(&agent_id)?;
    let base = worktrees_base(&root);
    std::fs::create_dir_all(&base).map_err(|error| format!("mkdir_failed:{error}"))?;

    let dest = base.join(&id);
    if dest.exists() {
        return Err("worktree_exists".to_string());
    }
    let branch = format!("alethe/agent-{id}");
    let dest_arg = git_arg(&dest);

    match mode {
        WorktreeMode::GitWorktree => {
            checked_output(
                &root,
                &["worktree", "add", "-b", &branch, &dest_arg, "HEAD"],
            )?;
        }
        WorktreeMode::LocalCopy => {
            let root_arg = git_arg(&root);
            // `--local` usa hardlinks nos objetos: independente do repo original,

            checked_output(&root, &["clone", "--local", &root_arg, &dest_arg])?;
            checked_output(&dest, &["checkout", "-b", &branch])?;
        }
    }

    Ok(WorktreeInfo {
        agent_id: id,
        path: git_arg(&dest),
        branch,
        mode,
    })
}

#[tauri::command]
pub async fn worktree_list(repo: String) -> Result<Vec<WorktreeInfo>, String> {
    tokio::task::spawn_blocking(move || worktree_list_inner(repo))
        .await
        .map_err(|error| format!("worktree_list: falha na task bloqueante: {error}"))?
}

pub(crate) fn worktree_list_inner(repo: String) -> Result<Vec<WorktreeInfo>, String> {
    let root = repository_root(&repo)?;
    let base = worktrees_base(&root);
    let mut result = Vec::new();
    if !base.is_dir() {
        return Ok(result);
    }
    let entries = std::fs::read_dir(&base).map_err(|error| format!("read_dir_failed:{error}"))?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(mode) = detect_mode(&dir) else {
            continue;
        };
        let agent_id = dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        result.push(WorktreeInfo {
            agent_id,
            path: git_arg(&dir),
            branch: current_branch(&dir),
            mode,
        });
    }
    result.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
    Ok(result)
}

/// One checkout from `git worktree list`, whoever created it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckout {
    pub path: String,
    pub branch: Option<String>,
    pub last_commit_ms: Option<i64>,
    /// No commits of its own beyond the main checkout's branch (merged, or behind it) and nothing
    /// uncommitted. Only set by the status pass.
    pub stale: bool,
    /// Uncommitted changes `git status` counts, untracked links left out; `None` without the status
    /// pass or when git could not tell.
    pub uncommitted: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckouts {
    /// The first `git worktree list` entry; `None` for a bare repository.
    pub main: Option<String>,
    /// Every checkout whose folder exists, the main one included.
    pub worktrees: Vec<GitCheckout>,
    /// The main checkout's branch, which stale marks compare against; `None` when it is detached.
    pub base: Option<String>,
}

#[tauri::command]
pub async fn worktree_checkouts(
    path: String,
    status: Option<bool>,
) -> Result<GitCheckouts, String> {
    tokio::task::spawn_blocking(move || worktree_checkouts_inner(&path, status.unwrap_or(false)))
        .await
        .map_err(|error| format!("worktree_checkouts: blocking task failed: {error}"))?
}

/// The repository's checkouts. `status` adds what the worktree picker shows: each checkout's
/// uncommitted count (one `git status` each) and the stale mark.
pub(crate) fn worktree_checkouts_inner(path: &str, status: bool) -> Result<GitCheckouts, String> {
    let cwd = Path::new(path.trim());
    let output = checked_output(cwd, &["worktree", "list", "--porcelain"])?;
    let text = String::from_utf8_lossy(&output.stdout);
    // (path, HEAD, branch, bare) per porcelain block; each block starts with `worktree`.
    let mut entries: Vec<(PathBuf, Option<&str>, Option<String>, bool)> = Vec::new();
    for line in text.lines() {
        if let Some(listed) = line.strip_prefix("worktree ") {
            // Collecting the components turns git's `C:/...` into native separators.
            entries.push((Path::new(listed).components().collect(), None, None, false));
        } else if let Some(entry) = entries.last_mut() {
            if let Some(head) = line.strip_prefix("HEAD ") {
                entry.1 = Some(head);
            } else if let Some(branch) = line.strip_prefix("branch ") {
                let short = branch.strip_prefix("refs/heads/").unwrap_or(branch);
                entry.2 = Some(short.to_string());
            } else if line == "bare" {
                entry.3 = true;
            }
        }
    }

    let heads: Vec<&str> = entries
        .iter()
        .filter_map(|entry| entry.1)
        .filter(|head| head.bytes().any(|byte| byte != b'0'))
        .collect();
    let mut commit_ms = std::collections::HashMap::new();
    if !heads.is_empty() {
        let mut args = vec!["show", "-s", "--format=%H %ct"];
        args.extend(&heads);
        // One process for every worktree; a failure only leaves the times unknown.
        if let Ok(shown) = checked_output(cwd, &args) {
            for line in String::from_utf8_lossy(&shown.stdout).lines() {
                if let Some((sha, seconds)) = line.split_once(' ') {
                    if let Ok(seconds) = seconds.trim().parse::<i64>() {
                        commit_ms.insert(sha.to_string(), seconds * 1000);
                    }
                }
            }
        }
    }

    let main_entry = entries.first().filter(|entry| !entry.3);
    let main = main_entry.map(|entry| entry.0.to_string_lossy().into_owned());
    // The base is the main checkout's branch, the target the merge flow integrates into.
    let base = main_entry.and_then(|entry| entry.2.clone());
    let merged = match base.as_deref() {
        Some(base) if status => merged_branches(cwd, base),
        _ => std::collections::HashSet::new(),
    };
    let worktrees = entries
        .iter()
        .filter(|entry| !entry.3 && entry.0.is_dir())
        .map(|(dir, head, branch, _)| {
            let uncommitted = if status { uncommitted(dir).ok() } else { None };
            GitCheckout {
                path: dir.to_string_lossy().into_owned(),
                branch: branch.clone(),
                last_commit_ms: head.and_then(|sha| commit_ms.get(sha).copied()),
                stale: uncommitted == Some(0)
                    && branch.as_ref().is_some_and(|name| merged.contains(name)),
                uncommitted,
            }
        })
        .collect();
    Ok(GitCheckouts {
        main,
        worktrees,
        base,
    })
}

/// Local branches with no commits `base` lacks: merged, behind, or level with it. `base` itself is
/// left out. One `for-each-ref`; a failure marks nothing stale.
fn merged_branches(cwd: &Path, base: &str) -> std::collections::HashSet<String> {
    let merged = format!("--merged=refs/heads/{base}");
    let args = [
        "for-each-ref",
        merged.as_str(),
        "--format=%(refname)",
        "refs/heads/",
    ];
    checked_output(cwd, &args)
        .map(|listed| {
            String::from_utf8_lossy(&listed.stdout)
                .lines()
                .filter_map(|line| line.strip_prefix("refs/heads/"))
                .filter(|branch| *branch != base)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Uncommitted changes in `dir`, one per `git status` entry. An untracked entry that is only a link,
/// such as a junctioned `node_modules`, is not work and does not count.
fn uncommitted(dir: &Path) -> Result<u32, String> {
    let output = checked_output(dir, &["status", "--porcelain", "-z"])?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut fields = text.split('\0').filter(|field| !field.is_empty());
    let mut count = 0;
    while let Some(entry) = fields.next() {
        let code = entry.get(..2).unwrap_or_default();
        if code.contains(['R', 'C']) {
            // A rename or copy is followed by the path it came from.
            fields.next();
        }
        let path = entry.get(3..).unwrap_or_default().trim_end_matches('/');
        let untracked_link = code == "??"
            && std::fs::symlink_metadata(dir.join(path)).is_ok_and(|found| is_link(&found));
        if !untracked_link {
            count += 1;
        }
    }
    Ok(count)
}

#[tauri::command]
pub async fn worktree_remove_checkout(
    watchers: tauri::State<'_, FileWatchers>,
    sessions: tauri::State<'_, crate::pty::PtySessions>,
    orchestrator: tauri::State<'_, crate::orchestrator::OrchestratorState>,
    path: String,
) -> Result<(), String> {
    use crate::orchestrator_core::{STATUS_BLOCKED, STATUS_QUEUED, STATUS_RUNNING};
    let watchers = watchers.0.clone();
    let sessions = std::sync::Arc::clone(sessions.inner());
    let core = orchestrator.core().clone();
    tokio::task::spawn_blocking(move || {
        let in_use = |target: &Path| {
            // A poisoned lock can't tell: it refuses, as anything else unknown does.
            let terminal = sessions.lock().map_or(true, |open| {
                live_cwd_inside(target, open.values().filter_map(|pty| pty.cwd.as_deref()))
            });
            if terminal {
                return Some("worktree_in_use_terminal".to_string());
            }
            let snapshot = core.snapshot();
            let jobs = snapshot["jobs"].as_array().cloned().unwrap_or_default();
            let live = jobs.iter().filter(|job| {
                matches!(
                    job["status"].as_str(),
                    Some(STATUS_QUEUED | STATUS_RUNNING | STATUS_BLOCKED)
                )
            });
            live_cwd_inside(target, live.filter_map(|job| job["cwd"].as_str()))
                .then(|| "worktree_in_use_worker".to_string())
        };
        worktree_remove_checkout_inner(&path, in_use, |root| {
            release_watchers_under(&watchers, root)
        })
    })
    .await
    .map_err(|error| format!("worktree_remove_checkout: blocking task failed: {error}"))?
}

/// Removes a linked worktree listed by `git worktree list`, wherever it lives. Refuses the main
/// checkout and any worktree with uncommitted or untracked changes (untracked links aside, which
/// go first, as links). Every check that can refuse runs before anything changes. While it runs
/// the path is marked, so nothing starts inside it; `in_use` then names anything already running
/// there, and `release` lets go of what the app still holds inside it.
pub(crate) fn worktree_remove_checkout_inner(
    path: &str,
    in_use: impl FnOnce(&Path) -> Option<String>,
    release: impl FnOnce(&Path),
) -> Result<(), String> {
    let target = Path::new(path.trim())
        .canonicalize()
        .map_err(|_| "worktree_not_found".to_string())?;
    let checkouts = worktree_checkouts_inner(path, false)?;
    let same = |listed: &str| Path::new(listed).canonicalize().ok().as_ref() == Some(&target);
    let main = checkouts.main.ok_or("worktree_not_found")?;
    if same(&main) {
        return Err("worktree_is_main".to_string());
    }
    if !checkouts
        .worktrees
        .iter()
        .any(|checkout| same(&checkout.path))
    {
        return Err("worktree_not_found".to_string());
    }
    if uncommitted(&target)? > 0 {
        return Err("worktree_dirty".to_string());
    }
    // An administrative lock would refuse the removal only after the links are gone.
    with_lock_awareness(&target, || Ok(()))?;
    // A link git tracks is part of the checkout; unlinking it would leave the worktree dirty.
    let tracked = tracked_paths(&target)?;
    let links: Vec<_> = links_inside(&target, LINK_SWEEP_ENTRIES)?
        .into_iter()
        .filter(|(link, _)| !tracked.contains(&relative_path(&target, link)))
        .collect();
    // Marked first, then checked: a terminal or worker starting now is refused at its spawn, and
    // one that started before is seen here. Whatever ends the removal lifts the mark.
    let _mark = mark_removal(&target)?;
    if let Some(reason) = in_use(&target) {
        return Err(reason);
    }
    release(&target);
    // A junctioned `node_modules` points at the main checkout's: only the link may go.
    unlink(&links)?;
    remove_git_worktree(Path::new(&main), &target, false)
}

/// Worktrees being removed and the folders of terminals still starting, as `cwd_key`s, under one
/// lock: a removal refuses while a terminal is starting inside, and nothing starts inside a removal.
struct Guarded {
    removing: Vec<String>,
    starting: Vec<(u64, String)>,
    next: u64,
}

static GUARDED: std::sync::Mutex<Guarded> = std::sync::Mutex::new(Guarded {
    removing: Vec::new(),
    starting: Vec::new(),
    next: 0,
});

fn guarded() -> std::sync::MutexGuard<'static, Guarded> {
    GUARDED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn being_removed(marked: &str) -> String {
    format!("worktree_being_removed: {marked} is being removed, so nothing can start in it")
}

/// A cwd as the user or a caller wrote it, made absolute: trimmed, one pair of surrounding quotes
/// dropped, a leading `~` taken as the home folder, and a relative path joined to the process's
/// folder. `None` when nothing is left. Nothing on disk is touched.
pub(crate) fn absolute_cwd(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    let unquoted = ['"', '\'']
        .iter()
        .find_map(|quote| trimmed.strip_prefix(*quote)?.strip_suffix(*quote))
        .unwrap_or(trimmed)
        .trim();
    if unquoted.is_empty() {
        return None;
    }
    let path = match unquoted.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => dirs_next::home_dir()
            .map(|home| home.join(rest.trim_start_matches(['/', '\\'])))
            .unwrap_or_else(|| PathBuf::from(unquoted)),
        _ => PathBuf::from(unquoted),
    };
    Some(std::path::absolute(&path).unwrap_or(path))
}

/// One spelling per folder: no `\\?\` prefix, one separator, no trailing one and, on Windows, one
/// case. A UNC or WSL path keeps its `\\server\share` form.
pub(crate) fn path_key(path: &Path) -> String {
    let plain = git_arg(path);
    #[cfg(windows)]
    let plain = plain.replace('/', "\\").to_lowercase();
    plain
        .trim_end_matches(std::path::MAIN_SEPARATOR)
        .to_string()
}

/// `path` made absolute and resolved as far as it exists (a junction or a symlink to where it
/// points), then keyed: a folder not created yet compares by its parents.
fn cwd_key(path: &Path) -> String {
    let path = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut missing = Vec::new();
    let mut current = path.as_path();
    loop {
        if let Ok(found) = current.canonicalize() {
            return path_key(&missing.iter().rev().fold(found, |at, part| at.join(part)));
        }
        match (current.parent(), current.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name.to_os_string());
                current = parent;
            }
            _ => return path_key(&path),
        }
    }
}

/// Whether the folder keyed `key` is `root`'s or lies under it.
fn key_inside(key: &str, root: &str) -> bool {
    key == root
        || key
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with(std::path::MAIN_SEPARATOR))
}

/// Holds a path as being removed until dropped, whatever ends the removal.
pub(crate) struct RemovalMark(String);

impl Drop for RemovalMark {
    fn drop(&mut self) {
        guarded().removing.retain(|marked| marked != &self.0);
    }
}

/// Marks `root` as being removed; refuses when a removal of it is already running or a terminal is
/// still starting inside it.
pub(crate) fn mark_removal(root: &Path) -> Result<RemovalMark, String> {
    let root = cwd_key(root);
    let mut state = guarded();
    if state.removing.contains(&root) {
        return Err("worktree_being_removed".to_string());
    }
    if state.starting.iter().any(|(_, cwd)| key_inside(cwd, &root)) {
        return Err("worktree_in_use_terminal".to_string());
    }
    state.removing.push(root.clone());
    Ok(RemovalMark(root))
}

/// A terminal still starting in a folder, from `begin_spawn` until dropped.
pub(crate) struct PendingSpawn(Option<u64>);

impl Drop for PendingSpawn {
    fn drop(&mut self) {
        if let Some(id) = self.0 {
            guarded().starting.retain(|(starting, _)| *starting != id);
        }
    }
}

/// Begins a terminal's spawn in `cwd`: refused inside a worktree being removed, else held as
/// starting there until the returned guard is dropped.
pub(crate) fn begin_spawn(cwd: Option<&Path>) -> Result<PendingSpawn, String> {
    let Some(cwd) = cwd else {
        return Ok(PendingSpawn(None));
    };
    let at = cwd_key(cwd);
    let mut state = guarded();
    if let Some(marked) = state.removing.iter().find(|marked| key_inside(&at, marked)) {
        return Err(being_removed(marked));
    }
    state.next += 1;
    let id = state.next;
    state.starting.push((id, at));
    Ok(PendingSpawn(Some(id)))
}

/// Whether any of `cwds` lies inside `root`.
pub(crate) fn live_cwd_inside<'a>(root: &Path, cwds: impl IntoIterator<Item = &'a str>) -> bool {
    let root = cwd_key(root);
    cwds.into_iter()
        .filter_map(absolute_cwd)
        .any(|cwd| key_inside(&cwd_key(&cwd), &root))
}

/// Refuses to start a terminal or a worker in a worktree being removed.
pub(crate) fn refuse_spawn_in_removal(cwd: Option<&str>) -> Result<(), String> {
    let Some(at) = cwd.and_then(absolute_cwd).map(|cwd| cwd_key(&cwd)) else {
        return Ok(());
    };
    match guarded()
        .removing
        .iter()
        .find(|marked| key_inside(&at, marked))
    {
        Some(marked) => Err(being_removed(marked)),
        None => Ok(()),
    }
}

/// Entries the link sweep reads before refusing to guess. Linked worktrees here hold about 1,100
/// (Alethe, its `node_modules` a junction the sweep never enters) or fewer; one with its own
/// installed dependencies or build output passes this and is refused, to be cleaned first.
const LINK_SWEEP_ENTRIES: usize = 50_000;

/// What `git ls-files` lists for the checkout at `root`, as `/`-separated paths.
fn tracked_paths(root: &Path) -> Result<std::collections::HashSet<String>, String> {
    let listed = checked_output(root, &["ls-files", "-z"])?;
    Ok(String::from_utf8_lossy(&listed.stdout)
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect())
}

/// `path` under `root`, `/`-separated as git writes it.
fn relative_path(root: &Path, path: &Path) -> String {
    let inner = path.strip_prefix(root).unwrap_or(path);
    inner
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// A symlink or, on Windows, any reparse point, a directory junction included.
fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

/// A link to a folder: Windows takes it out with `remove_dir`, which never touches the target.
fn is_folder_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
        metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

/// Every link inside `root`, each with whether it is a folder link. Never walks into a link;
/// refuses once it has read more than `max_entries`.
fn links_inside(root: &Path, max_entries: usize) -> Result<Vec<(PathBuf, bool)>, String> {
    let mut links = Vec::new();
    let mut folders = vec![root.to_path_buf()];
    let mut read = 0;
    while let Some(folder) = folders.pop() {
        let entries =
            std::fs::read_dir(&folder).map_err(|error| format!("read_dir_failed:{error}"))?;
        for entry in entries {
            read += 1;
            if read > max_entries {
                return Err("worktree_too_large_to_check".to_string());
            }
            let path = entry
                .map_err(|error| format!("read_dir_failed:{error}"))?
                .path();
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|error| format!("metadata_failed:{error}"))?;
            if is_link(&metadata) {
                links.push((path, is_folder_link(&metadata)));
            } else if metadata.is_dir() {
                folders.push(path);
            }
        }
    }
    Ok(links)
}

/// Removes each link itself, never what it points at.
fn unlink(links: &[(PathBuf, bool)]) -> Result<(), String> {
    for (link, folder) in links {
        let removed = if *folder {
            std::fs::remove_dir(link)
        } else {
            std::fs::remove_file(link)
        };
        removed.map_err(|error| format!("unlink_failed:{}:{error}", link.display()))?;
    }
    Ok(())
}

/// `git worktree remove`, waiting out a transient index lock and reporting an admin lock.
fn remove_git_worktree(root: &Path, dest: &Path, force: bool) -> Result<(), String> {
    let dest_arg = git_arg(dest);
    with_lock_awareness(dest, || {
        if force {
            checked_output(root, &["worktree", "remove", "--force", &dest_arg])
        } else {
            checked_output(root, &["worktree", "remove", &dest_arg])
        }
    })
    .map(|_| ())
}

#[tauri::command]
pub async fn worktree_remove(repo: String, agent_id: String, force: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || worktree_remove_inner(repo, agent_id, force))
        .await
        .map_err(|error| format!("worktree_remove: falha na task bloqueante: {error}"))?
}

pub(crate) fn worktree_remove_inner(
    repo: String,
    agent_id: String,
    force: bool,
) -> Result<(), String> {
    let root = repository_root(&repo)?;
    let id = sanitize_id(&agent_id)?;
    let base = worktrees_base(&root);
    let dest = base.join(&id);
    if !dest.exists() {
        return Err("worktree_not_found".to_string());
    }

    // que o destino esteja dentro de `<repo>/.alethe/worktrees`.
    let canon_base = base
        .canonicalize()
        .map_err(|_| "invalid_worktree_path".to_string())?;
    let canon_dest = dest
        .canonicalize()
        .map_err(|_| "invalid_worktree_path".to_string())?;
    if !canon_dest.starts_with(&canon_base) {
        return Err("invalid_worktree_path".to_string());
    }

    match detect_mode(&dest) {
        Some(WorktreeMode::GitWorktree) => remove_git_worktree(&root, &canon_dest, force)?,

        _ => {
            std::fs::remove_dir_all(&canon_dest)
                .map_err(|error| format!("remove_failed:{error}"))?;
        }
    }
    Ok(())
}

/// Trava administrativamente um worktree (`git worktree lock`), com motivo

#[tauri::command]
pub async fn worktree_lock(
    repo: String,
    agent_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || worktree_lock_inner(repo, agent_id, reason))
        .await
        .map_err(|error| format!("worktree_lock: falha na task bloqueante: {error}"))?
}

pub(crate) fn worktree_lock_inner(
    repo: String,
    agent_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    let root = repository_root(&repo)?;
    let id = sanitize_id(&agent_id)?;
    let dest = worktrees_base(&root).join(&id);
    if !dest.exists() {
        return Err("worktree_not_found".to_string());
    }
    let dest_arg = git_arg(&dest);
    match reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => checked_output(&root, &["worktree", "lock", "--reason", value, &dest_arg])?,
        None => checked_output(&root, &["worktree", "lock", &dest_arg])?,
    };
    Ok(())
}

#[tauri::command]
pub async fn worktree_unlock(repo: String, agent_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || worktree_unlock_inner(repo, agent_id))
        .await
        .map_err(|error| format!("worktree_unlock: falha na task bloqueante: {error}"))?
}

pub(crate) fn worktree_unlock_inner(repo: String, agent_id: String) -> Result<(), String> {
    let root = repository_root(&repo)?;
    let id = sanitize_id(&agent_id)?;
    let dest = worktrees_base(&root).join(&id);
    if !dest.exists() {
        return Err("worktree_not_found".to_string());
    }
    let dest_arg = git_arg(&dest);

    checked_output(&root, &["worktree", "unlock", &dest_arg])?;
    Ok(())
}

#[tauri::command]
pub async fn worktree_fetch_branch(repo: String, agent_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || worktree_fetch_branch_inner(repo, agent_id))
        .await
        .map_err(|error| format!("worktree_fetch_branch: falha na task bloqueante: {error}"))?
}

pub(crate) fn worktree_fetch_branch_inner(repo: String, agent_id: String) -> Result<(), String> {
    let root = repository_root(&repo)?;
    let id = sanitize_id(&agent_id)?;
    let env = worktrees_base(&root).join(&id);
    let branch = format!("alethe/agent-{id}");

    match detect_mode(&env) {
        Some(WorktreeMode::LocalCopy) => {
            let env_arg = git_arg(&env);
            let refspec = format!("+refs/heads/{branch}:refs/heads/{branch}");
            checked_output(&root, &["fetch", &env_arg, &refspec])?;
            Ok(())
        }
        Some(WorktreeMode::GitWorktree) => Ok(()),
        None => Err("worktree_not_found".to_string()),
    }
}

/// `git merge` only moves commits — an agent that wrote files in the worktree
/// without ever running `git commit` leaves its branch with no new commit
/// relative to the target, so the merge silently no-ops (`merged: true`
/// reported, nothing actually changes upstream). Called before
/// `merge_prepare`/`merge_analyze` in the "Integrate" flow to auto-commit
/// whatever is pending, so the user/agent never has to remember to commit by
/// hand. No-op on an already-clean worktree.
#[tauri::command]
pub async fn worktree_commit_pending(repo: String, agent_id: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || worktree_commit_pending_inner(repo, agent_id))
        .await
        .map_err(|error| format!("worktree_commit_pending: blocking task failed: {error}"))?
}

pub(crate) fn worktree_commit_pending_inner(
    repo: String,
    agent_id: String,
) -> Result<bool, String> {
    let env = resolve_worktree_env(&repo, &agent_id)?;
    commit_all_pending(&env, "Agent work (auto-commit before integration)")
}

/// Shared by the three pending-commit operations (auto/list/commit-with-message).
fn resolve_worktree_env(repo: &str, agent_id: &str) -> Result<PathBuf, String> {
    // main_repository_root, not repository_root: same reason as
    // worktree_provision_inner — `repo` may already be an isolated worktree
    // if the project has no "plain" terminal left to use as a reference.
    let root = main_repository_root(repo)?;
    let id = sanitize_id(agent_id)?;
    let env = worktrees_base(&root).join(&id);
    if detect_mode(&env).is_none() {
        return Err("worktree_not_found".to_string());
    }
    Ok(env)
}

/// Mirrors `isRealWork()` in `assets/opencode-plugins/alethe-gsd-state.ts` —
/// Alethe's own infrastructure (GSD plugin in `.opencode/`, GSD Sync state in
/// `.planning/`, the `opencode.json` Alethe writes on every spawn) is never
/// real agent work in this worktree and must not be auto-committed/merged.
fn is_real_work(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with(".planning/")
        && !path.starts_with(".opencode/")
        && path != "opencode.json"
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChange {
    pub path: String,
    pub status: String,
}

fn parse_porcelain(output: &str) -> Vec<PendingChange> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| PendingChange {
            status: line.get(0..2).unwrap_or("").trim().to_string(),
            path: line.get(3..).unwrap_or("").trim().to_string(),
        })
        .filter(|change| is_real_work(&change.path))
        .collect()
}

fn commit_all_pending(env: &Path, message: &str) -> Result<bool, String> {
    let status = checked_output(env, &["status", "--porcelain"])?;
    let changes = parse_porcelain(&String::from_utf8_lossy(&status.stdout));
    if changes.is_empty() {
        return Ok(false);
    }
    let message = if message.trim().is_empty() {
        "Agent work (auto-commit before integration)"
    } else {
        message
    };
    // Never `add -A`: stage only the real paths (filtered above) so Alethe's
    // own infrastructure never rides along into the commit.
    let mut add_args: Vec<&str> = vec!["add", "--"];
    add_args.extend(changes.iter().map(|change| change.path.as_str()));
    checked_output(env, &add_args)?;
    checked_output(env, &["commit", "-m", message])?;
    Ok(true)
}

/// Lists what's pending (staged/unstaged/untracked) in an agent worktree
/// without touching anything — used by the confirmation dialog before
/// integrating, so the user can review and write the commit message before
/// `worktree_commit_worktree` actually runs.
#[tauri::command]
pub async fn worktree_pending_changes(
    repo: String,
    agent_id: String,
) -> Result<Vec<PendingChange>, String> {
    tokio::task::spawn_blocking(move || worktree_pending_changes_inner(repo, agent_id))
        .await
        .map_err(|error| format!("worktree_pending_changes: blocking task failed: {error}"))?
}

pub(crate) fn worktree_pending_changes_inner(
    repo: String,
    agent_id: String,
) -> Result<Vec<PendingChange>, String> {
    let env = resolve_worktree_env(&repo, &agent_id)?;
    let status = checked_output(&env, &["status", "--porcelain"])?;
    Ok(parse_porcelain(&String::from_utf8_lossy(&status.stdout)))
}

/// Like `worktree_commit_pending`, but with the message the user chose in the
/// confirmation dialog instead of the generic text — still a no-op on an
/// already-clean worktree.
#[tauri::command]
pub async fn worktree_commit_worktree(
    repo: String,
    agent_id: String,
    message: String,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || worktree_commit_worktree_inner(repo, agent_id, message))
        .await
        .map_err(|error| format!("worktree_commit_worktree: blocking task failed: {error}"))?
}

pub(crate) fn worktree_commit_worktree_inner(
    repo: String,
    agent_id: String,
    message: String,
) -> Result<bool, String> {
    let env = resolve_worktree_env(&repo, &agent_id)?;
    commit_all_pending(&env, &message)
}

#[tauri::command]
pub async fn worktree_cleanup(repo: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || worktree_cleanup_inner(repo))
        .await
        .map_err(|error| format!("worktree_cleanup: falha na task bloqueante: {error}"))?
}

pub(crate) fn worktree_cleanup_inner(repo: String) -> Result<(), String> {
    let root = repository_root(&repo)?;
    checked_output(&root, &["worktree", "prune"])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::worktree_cleanup_inner as worktree_cleanup;
    use super::worktree_fetch_branch_inner as worktree_fetch_branch;
    use super::worktree_list_inner as worktree_list;
    use super::worktree_provision_inner as worktree_provision;
    use super::worktree_remove_inner as worktree_remove;
    use super::worktree_unlock_inner as worktree_unlock;

    fn temp_repo() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("alethe-worktrees-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        let run = |args: &[&str]| checked_output(&root, args).unwrap();
        run(&["init"]);
        run(&["config", "user.name", "Alethe Test"]);
        run(&["config", "user.email", "alethe@example.invalid"]);
        fs::write(root.join("file.txt"), "one\n").unwrap();
        run(&["add", "file.txt"]);
        run(&["commit", "-m", "init"]);
        root
    }

    #[test]
    fn rejects_unsafe_ids() {
        assert!(sanitize_id("../evil").is_err());
        assert!(sanitize_id("a/b").is_err());
        assert!(sanitize_id("has space").is_err());
        assert!(sanitize_id("").is_err());
        assert!(sanitize_id("agent-01_x").is_ok());
    }

    #[test]
    fn checkouts_list_the_main_checkout_and_every_linked_worktree() {
        let root = temp_repo();
        let name = root.file_name().unwrap().to_string_lossy().into_owned();
        let sibling = |suffix: &str| root.with_file_name(format!("{name}-{suffix}"));
        let same = |listed: &str, expected: &Path| {
            fs::canonicalize(listed).unwrap() == fs::canonicalize(expected).unwrap()
        };
        let git = |cwd: &Path, args: &[&str]| checked_output(cwd, args).unwrap();
        let linked = sibling("feature");
        let linked_arg = git_arg(&linked);
        git(&root, &["worktree", "add", "-b", "feature", &linked_arg]);
        fs::write(linked.join("file.txt"), "two\n").unwrap();
        git(&linked, &["commit", "-am", "feature work"]);
        let committed = git(&linked, &["log", "-1", "--format=%ct"]);
        let committed_ms = String::from_utf8_lossy(&committed.stdout)
            .trim()
            .parse::<i64>()
            .unwrap()
            * 1000;

        // Asked from the linked worktree, the main checkout is still the first entry.
        let found = worktree_checkouts_inner(&linked.to_string_lossy(), false).unwrap();
        assert!(same(found.main.as_deref().unwrap(), &root));
        assert_eq!(found.worktrees.len(), 2);
        let feature = found
            .worktrees
            .iter()
            .find(|checkout| same(&checkout.path, &linked))
            .unwrap();
        assert_eq!(feature.branch.as_deref(), Some("feature"));
        assert_eq!(feature.last_commit_ms, Some(committed_ms));
        #[cfg(windows)]
        assert!(!feature.path.contains('/'), "{}", feature.path);

        // A bare repository has no main checkout, only its linked worktrees.
        let bare = sibling("bare.git");
        let bare_linked = sibling("bare-wt");
        let (root_arg, bare_arg) = (git_arg(&root), git_arg(&bare));
        let bare_linked_arg = git_arg(&bare_linked);
        git(&root, &["clone", "--bare", &root_arg, &bare_arg]);
        git(&bare, &["worktree", "add", &bare_linked_arg, "feature"]);
        let from_bare = worktree_checkouts_inner(&bare_linked.to_string_lossy(), false).unwrap();
        assert_eq!(from_bare.main, None);
        assert_eq!(from_bare.worktrees.len(), 1);
        assert!(same(&from_bare.worktrees[0].path, &bare_linked));

        for dir in [&linked, &bare, &bare_linked, &root] {
            let _ = fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn fetch_branch_brings_local_copy_work_into_main_repo() {
        let root = temp_repo();
        let root_str = root.to_string_lossy().into_owned();

        let lc = worktree_provision(root_str.clone(), "fetchme".into(), WorktreeMode::LocalCopy)
            .unwrap();
        let env = Path::new(&lc.path);

        fs::write(env.join("file.txt"), "changed in copy\n").unwrap();
        checked_output(env, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(env, &["config", "user.email", "alethe@example.invalid"]).unwrap();
        checked_output(env, &["commit", "-am", "copy work"]).unwrap();

        let missing = git_command(
            &root,
            &["rev-parse", "--verify", "refs/heads/alethe/agent-fetchme"],
        )
        .unwrap();
        assert!(
            !missing.status.success(),
            "branch não devia existir antes do fetch"
        );

        worktree_fetch_branch(root_str.clone(), "fetchme".into()).unwrap();
        let present = git_command(
            &root,
            &["rev-parse", "--verify", "refs/heads/alethe/agent-fetchme"],
        )
        .unwrap();
        assert!(
            present.status.success(),
            "branch devia existir após o fetch"
        );

        // GitWorktree: no-op ok. Inexistente: erro limpo.
        let wt = worktree_provision(root_str.clone(), "wtnoop".into(), WorktreeMode::GitWorktree)
            .unwrap();
        assert_eq!(wt.mode, WorktreeMode::GitWorktree);
        worktree_fetch_branch(root_str.clone(), "wtnoop".into()).unwrap();
        assert!(worktree_fetch_branch(root_str.clone(), "nope".into()).is_err());

        worktree_remove(root_str.clone(), "fetchme".into(), true).unwrap();
        worktree_remove(root_str, "wtnoop".into(), true).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn commit_pending_commits_untracked_and_modified_work() {
        use super::worktree_commit_pending_inner as worktree_commit_pending;

        let root = temp_repo();
        let root_str = root.to_string_lossy().into_owned();
        let wt =
            worktree_provision(root_str.clone(), "op1".into(), WorktreeMode::GitWorktree).unwrap();
        let env = Path::new(&wt.path);
        checked_output(env, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(env, &["config", "user.email", "alethe@example.invalid"]).unwrap();

        // Nothing pending yet — no-op, no new commit.
        assert!(!worktree_commit_pending(root_str.clone(), "op1".into()).unwrap());
        let before = git_command(env, &["rev-parse", "HEAD"]).unwrap();

        // Agent "forgot" to commit: new untracked file.
        fs::write(env.join("README.md"), "agent work\n").unwrap();
        assert!(worktree_commit_pending(root_str.clone(), "op1".into()).unwrap());

        let after = git_command(env, &["rev-parse", "HEAD"]).unwrap();
        assert_ne!(before.stdout, after.stdout, "should have a new commit");
        let status = checked_output(env, &["status", "--porcelain"]).unwrap();
        assert!(
            String::from_utf8_lossy(&status.stdout).trim().is_empty(),
            "worktree should be clean after the commit"
        );

        // Repeat with no change: no-op again.
        assert!(!worktree_commit_pending(root_str.clone(), "op1".into()).unwrap());

        assert!(worktree_commit_pending(root_str.clone(), "nope".into()).is_err());

        worktree_remove(root_str, "op1".into(), true).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pending_changes_lists_without_mutating_and_commit_worktree_uses_chosen_message() {
        use super::worktree_commit_worktree_inner as worktree_commit_worktree;
        use super::worktree_pending_changes_inner as worktree_pending_changes;

        let root = temp_repo();
        let root_str = root.to_string_lossy().into_owned();
        let wt =
            worktree_provision(root_str.clone(), "op2".into(), WorktreeMode::GitWorktree).unwrap();
        let env = Path::new(&wt.path);
        checked_output(env, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(env, &["config", "user.email", "alethe@example.invalid"]).unwrap();

        assert!(worktree_pending_changes(root_str.clone(), "op2".into())
            .unwrap()
            .is_empty());

        fs::write(env.join("README.md"), "agent work\n").unwrap();
        let pending = worktree_pending_changes(root_str.clone(), "op2".into()).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].path, "README.md");
        assert_eq!(pending[0].status, "??");
        // Listing must not touch anything — still untracked, no new commit.
        let status_after_list = checked_output(env, &["status", "--porcelain"]).unwrap();
        assert!(!String::from_utf8_lossy(&status_after_list.stdout)
            .trim()
            .is_empty());

        assert!(worktree_commit_worktree(
            root_str.clone(),
            "op2".into(),
            "real work summary".into()
        )
        .unwrap());
        let log = git_command(env, &["log", "-1", "--format=%s"]).unwrap();
        assert_eq!(
            String::from_utf8_lossy(&log.stdout).trim(),
            "real work summary"
        );
        assert!(worktree_pending_changes(root_str.clone(), "op2".into())
            .unwrap()
            .is_empty());

        // Blank message falls back to the generic text instead of failing the commit.
        fs::write(env.join("README.md"), "one more change\n").unwrap();
        assert!(worktree_commit_worktree(root_str.clone(), "op2".into(), "   ".into()).unwrap());
        let log2 = git_command(env, &["log", "-1", "--format=%s"]).unwrap();
        assert_eq!(
            String::from_utf8_lossy(&log2.stdout).trim(),
            "Agent work (auto-commit before integration)"
        );

        worktree_remove(root_str, "op2".into(), true).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn infra_files_never_show_up_pending_and_never_get_committed() {
        use super::worktree_commit_worktree_inner as worktree_commit_worktree;
        use super::worktree_pending_changes_inner as worktree_pending_changes;

        let root = temp_repo();
        let root_str = root.to_string_lossy().into_owned();
        let wt =
            worktree_provision(root_str.clone(), "op3".into(), WorktreeMode::GitWorktree).unwrap();
        let env = Path::new(&wt.path);
        checked_output(env, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(env, &["config", "user.email", "alethe@example.invalid"]).unwrap();

        // Only Alethe infrastructure pending (GSD plugin + OpenCode config
        // auto-written on spawn) — no real agent work.
        fs::create_dir_all(env.join(".opencode").join("plugins")).unwrap();
        fs::write(
            env.join(".opencode")
                .join("plugins")
                .join("alethe-gsd-state.ts"),
            "// alethe-managed: v1\n",
        )
        .unwrap();
        fs::create_dir_all(env.join(".planning")).unwrap();
        fs::write(env.join(".planning").join("goal.md"), "goal\n").unwrap();
        fs::write(env.join("opencode.json"), "{}\n").unwrap();

        assert!(
            worktree_pending_changes(root_str.clone(), "op3".into())
                .unwrap()
                .is_empty(),
            "Alethe infrastructure files must not show up as pending"
        );
        assert!(
            !worktree_commit_worktree(root_str.clone(), "op3".into(), "infra only".into()).unwrap(),
            "with no real work, no commit should be created"
        );

        // Mix of infra + real work: only the real part enters the list and the commit.
        fs::write(env.join("README.md"), "real work\n").unwrap();
        let pending = worktree_pending_changes(root_str.clone(), "op3".into()).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].path, "README.md");

        assert!(
            worktree_commit_worktree(root_str.clone(), "op3".into(), "summary".into()).unwrap()
        );
        let committed = checked_output(env, &["show", "--stat", "--format=", "HEAD"]).unwrap();
        let committed_files = String::from_utf8_lossy(&committed.stdout);
        assert!(committed_files.contains("README.md"));
        assert!(!committed_files.contains("opencode.json"));
        assert!(!committed_files.contains(".planning"));
        assert!(!committed_files.contains(".opencode"));
        // Infra stays untracked (never committed), nothing else broken.
        let final_status = checked_output(env, &["status", "--porcelain"]).unwrap();
        assert!(String::from_utf8_lossy(&final_status.stdout).contains("opencode.json"));

        worktree_remove(root_str, "op3".into(), true).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn provisions_lists_and_removes_both_modes() {
        let root = temp_repo();
        let root_str = root.to_string_lossy().into_owned();

        let wt =
            worktree_provision(root_str.clone(), "wt1".into(), WorktreeMode::GitWorktree).unwrap();
        assert_eq!(wt.mode, WorktreeMode::GitWorktree);
        assert!(Path::new(&wt.path).join(".git").is_file());

        let lc =
            worktree_provision(root_str.clone(), "lc1".into(), WorktreeMode::LocalCopy).unwrap();
        assert_eq!(lc.mode, WorktreeMode::LocalCopy);
        assert!(Path::new(&lc.path).join(".git").is_dir());

        let listed = worktree_list(root_str.clone()).unwrap();
        assert_eq!(listed.len(), 2);

        // Reprovisioning the same id should fail (destination already exists).
        assert!(
            worktree_provision(root_str.clone(), "wt1".into(), WorktreeMode::GitWorktree).is_err()
        );

        worktree_remove(root_str.clone(), "wt1".into(), false).unwrap();
        worktree_remove(root_str.clone(), "lc1".into(), false).unwrap();
        assert_eq!(worktree_list(root_str.clone()).unwrap().len(), 0);

        worktree_cleanup(root_str).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn worktree_remove_reports_admin_lock_reason_without_retry() {
        let root = temp_repo();
        let root_str = root.to_string_lossy().into_owned();

        let wt = worktree_provision(
            root_str.clone(),
            "ambiente-a".into(),
            WorktreeMode::GitWorktree,
        )
        .unwrap();

        // Real administrative lock via `git worktree lock --reason`, like a
        // user would do outside Alethe.
        checked_output(
            &root,
            &[
                "worktree",
                "lock",
                "--reason",
                "Aguardando homologacao",
                &wt.path,
            ],
        )
        .unwrap();

        // timing em git_control::tests::admin_lock_takes_precedence_and_is_never_retried.

        // motivo correto.
        let error = worktree_remove(root_str.clone(), "ambiente-a".into(), true).unwrap_err();
        assert_eq!(error, "admin_locked:Aguardando homologacao");

        worktree_unlock(root_str.clone(), "ambiente-a".into()).unwrap();
        worktree_remove(root_str.clone(), "ambiente-a".into(), true).unwrap();
        assert_eq!(worktree_list(root_str).unwrap().len(), 0);

        fs::remove_dir_all(root).unwrap();
    }

    /// Adds a sibling worktree on a new branch at `start`.
    fn add_sibling(root: &Path, branch: &str, start: &str) -> PathBuf {
        let name = root.file_name().unwrap().to_string_lossy().into_owned();
        let dir = root.with_file_name(format!("{name}-{branch}"));
        let dir_arg = git_arg(&dir);
        checked_output(root, &["worktree", "add", "-b", branch, &dir_arg, start]).unwrap();
        dir
    }

    /// `mklink /J`: a directory junction, which needs no admin rights.
    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[cfg(windows)]
    #[test]
    fn remove_checkout_takes_a_junction_out_without_touching_its_target() {
        let root = temp_repo();
        fs::write(root.join(".gitignore"), "node_modules\n").unwrap();
        checked_output(&root, &["add", ".gitignore"]).unwrap();
        checked_output(&root, &["commit", "-m", "ignore"]).unwrap();
        // The main checkout's dependencies, which a worktree reaches through a junction.
        let deps = root.join("node_modules");
        fs::create_dir_all(&deps).unwrap();
        fs::write(deps.join("sentinel.txt"), "keep").unwrap();
        let linked = add_sibling(&root, "linked", "HEAD");
        junction(&linked.join("node_modules"), &deps);

        worktree_remove_checkout_inner(&linked.to_string_lossy(), |_| None, |_| {}).unwrap();

        assert!(
            deps.join("sentinel.txt").is_file(),
            "the junction's target is untouched"
        );
        assert!(fs::symlink_metadata(linked.join("node_modules")).is_err());
        assert!(!linked.exists(), "the worktree folder is gone");
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn remove_checkout_takes_out_a_junction_however_deep() {
        let root = temp_repo();
        let deep = Path::new("a").join("b").join("c").join("d");
        fs::create_dir_all(root.join(&deep)).unwrap();
        commit_in(&root, &deep.join("keep.txt").to_string_lossy());
        let deps = root.with_extension("deps");
        fs::create_dir_all(&deps).unwrap();
        fs::write(deps.join("sentinel.txt"), "keep").unwrap();
        let linked = add_sibling(&root, "deep", "HEAD");
        let link = linked.join(&deep).join("node_modules");
        junction(&link, &deps);

        worktree_remove_checkout_inner(&linked.to_string_lossy(), |_| None, |_| {}).unwrap();

        assert!(
            deps.join("sentinel.txt").is_file(),
            "the junction's target is untouched"
        );
        assert!(
            fs::symlink_metadata(&link).is_err(),
            "the deep junction is gone"
        );
        assert!(!linked.exists());
        for dir in [&deps, &root] {
            let _ = fs::remove_dir_all(dir);
        }
    }

    /// A symlink git tracks belongs to the checkout: unlinking it would make the worktree dirty.
    #[cfg(windows)]
    #[test]
    fn remove_checkout_leaves_a_tracked_symlink_to_git() {
        let root = temp_repo();
        checked_output(&root, &["config", "core.symlinks", "true"]).unwrap();
        fs::create_dir_all(root.join("real")).unwrap();
        fs::write(root.join("real").join("x.txt"), "x").unwrap();
        if std::os::windows::fs::symlink_dir("real", root.join("tracked-link")).is_err() {
            eprintln!("skipped: creating symlinks needs Developer Mode or admin rights");
            let _ = fs::remove_dir_all(&root);
            return;
        }
        checked_output(&root, &["add", "-A"]).unwrap();
        checked_output(&root, &["commit", "-m", "tracked link"]).unwrap();
        let linked = add_sibling(&root, "symlinked", "HEAD");
        assert!(fs::symlink_metadata(linked.join("tracked-link"))
            .unwrap()
            .file_type()
            .is_symlink());

        worktree_remove_checkout_inner(&linked.to_string_lossy(), |_| None, |_| {}).unwrap();

        assert!(!linked.exists());
        assert!(root.join("real").join("x.txt").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_detached_main_checkout_leaves_the_base_unknown() {
        let root = temp_repo();
        let merged = add_sibling(&root, "merged", "HEAD");
        checked_output(&root, &["checkout", "--detach"]).unwrap();

        let found = worktree_checkouts_inner(&root.to_string_lossy(), true).unwrap();

        assert_eq!(found.base, None);
        assert!(found.worktrees.iter().all(|checkout| !checkout.stale));
        for dir in [&merged, &root] {
            let _ = fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn removal_refuses_a_live_session_inside_and_marks_the_path_while_it_runs() {
        let root = temp_repo();
        let linked = add_sibling(&root, "busy", "HEAD");
        let inside = linked.join("src");
        let path = linked.to_string_lossy().into_owned();
        // Terminal sessions: one in the main checkout, one in a subfolder of the worktree.
        let cwds = [
            root.to_string_lossy().into_owned(),
            inside.to_string_lossy().into_owned(),
        ];
        let terminal = |target: &Path| {
            live_cwd_inside(target, cwds.iter().map(String::as_str))
                .then(|| "worktree_in_use_terminal".to_string())
        };

        let refused = worktree_remove_checkout_inner(&path, terminal, |_| {});
        assert_eq!(refused.unwrap_err(), "worktree_in_use_terminal");
        assert!(linked.is_dir());
        // The refusal let go of the mark: nothing there refuses a spawn any more.
        assert!(refuse_spawn_in_removal(Some(&inside.to_string_lossy())).is_ok());

        let mut meanwhile = None;
        worktree_remove_checkout_inner(
            &path,
            |_| None,
            |target| {
                meanwhile = Some((
                    refuse_spawn_in_removal(Some(&target.join("src").to_string_lossy())),
                    refuse_spawn_in_removal(Some(&root.to_string_lossy())),
                ));
            },
        )
        .unwrap();
        let (in_worktree, in_main) = meanwhile.unwrap();
        assert!(in_worktree
            .unwrap_err()
            .starts_with("worktree_being_removed"));
        assert!(in_main.is_ok());
        assert!(refuse_spawn_in_removal(Some(&inside.to_string_lossy())).is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn removal_is_refused_while_a_spawn_into_the_worktree_is_still_starting() {
        let root = temp_repo();
        let linked = add_sibling(&root, "pending", "HEAD");
        let path = linked.to_string_lossy().into_owned();
        // A terminal waiting for memory before its shell starts: no session yet, only its cwd.
        let starting = begin_spawn(Some(&linked.join("src"))).unwrap();

        let refused = worktree_remove_checkout_inner(&path, |_| None, |_| {});
        assert_eq!(refused.unwrap_err(), "worktree_in_use_terminal");
        assert!(linked.is_dir());

        drop(starting);
        worktree_remove_checkout_inner(&path, |_| None, |_| {}).unwrap();
        assert!(!linked.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_relative_cwd_not_created_yet_is_seen_inside_a_worktree_being_removed() {
        // A relative cwd lands under the process's own folder, which stands in for the worktree.
        let here = std::env::current_dir().unwrap().canonicalize().unwrap();
        let relative = Path::new("alethe-nova-not-created-yet");

        let mark = mark_removal(&here).unwrap();
        let refused = begin_spawn(Some(relative)).err().unwrap_or_default();
        assert!(refused.starts_with("worktree_being_removed"), "{refused}");
        drop(mark);

        let starting = begin_spawn(Some(relative)).unwrap();
        assert_eq!(
            mark_removal(&here).err().as_deref(),
            Some("worktree_in_use_terminal")
        );
        drop(starting);
    }

    #[cfg(windows)]
    #[test]
    fn a_unc_folder_has_one_spelling_and_resolves_without_touching_it() {
        let listed = path_key(Path::new(r"\\wsl$\Ubuntu\home\Me"));
        assert_eq!(listed, r"\\wsl$\ubuntu\home\me");
        assert_eq!(listed, path_key(Path::new(r"\\?\UNC\wsl$\Ubuntu\home\Me\")));
        assert_eq!(
            absolute_cwd(r"\\wsl$\Ubuntu\home\Me"),
            Some(PathBuf::from(r"\\wsl$\Ubuntu\home\Me"))
        );
    }

    #[test]
    fn a_cwd_is_trimmed_unquoted_and_expanded_before_it_resolves() {
        let home = dirs_next::home_dir().unwrap();
        let temp = std::env::temp_dir();
        assert_eq!(absolute_cwd("  "), None);
        assert_eq!(absolute_cwd("\"\""), None);
        assert_eq!(absolute_cwd("~"), Some(home.clone()));
        assert_eq!(absolute_cwd("~/x"), Some(home.join("x")));
        assert_eq!(absolute_cwd(r"~\x"), Some(home.join("x")));
        assert_eq!(
            absolute_cwd("~x"),
            Some(std::env::current_dir().unwrap().join("~x"))
        );
        assert_eq!(
            absolute_cwd(&format!("\"{}\"", temp.display())),
            Some(temp.clone())
        );
        assert_eq!(
            absolute_cwd(&format!(" '{}' ", temp.display())),
            Some(temp.clone())
        );
        assert_eq!(
            absolute_cwd("nova"),
            Some(std::env::current_dir().unwrap().join("nova"))
        );
    }

    #[test]
    fn a_spawn_cannot_begin_in_a_path_being_removed() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("alethe-begin-{nanos}"));
        fs::create_dir_all(dir.join("inner")).unwrap();
        let inside = dir.join("inner");

        let mark = mark_removal(&dir.canonicalize().unwrap()).unwrap();
        assert!(begin_spawn(Some(&inside))
            .err()
            .unwrap_or_default()
            .starts_with("worktree_being_removed"));
        assert!(begin_spawn(None).is_ok());
        drop(mark);
        assert!(begin_spawn(Some(&inside)).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_spawn_inside_a_path_being_removed_is_refused_until_the_mark_goes() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("alethe-mark-{nanos}"));
        fs::create_dir_all(dir.join("inner")).unwrap();
        let root = dir.canonicalize().unwrap();
        let inside = dir.join("inner").to_string_lossy().into_owned();

        let mark = mark_removal(&root).unwrap();
        assert!(refuse_spawn_in_removal(Some(&inside))
            .unwrap_err()
            .starts_with("worktree_being_removed"));
        assert!(
            refuse_spawn_in_removal(Some(&dir.with_extension("other").to_string_lossy())).is_ok()
        );
        assert!(refuse_spawn_in_removal(None).is_ok());
        assert_eq!(
            mark_removal(&root).err().as_deref(),
            Some("worktree_being_removed")
        );
        drop(mark);
        assert!(refuse_spawn_in_removal(Some(&inside)).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn link_sweep_refuses_past_its_bound() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("alethe-sweep-{nanos}"));
        fs::create_dir_all(dir.join("a").join("b")).unwrap();
        for name in ["one", "two", "three"] {
            fs::write(dir.join(name), name).unwrap();
        }

        assert_eq!(
            links_inside(&dir, 3).unwrap_err(),
            "worktree_too_large_to_check"
        );
        assert!(links_inside(&dir, 100).unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    fn commit_in(dir: &Path, file: &str) {
        fs::write(dir.join(file), file).unwrap();
        checked_output(dir, &["add", file]).unwrap();
        checked_output(dir, &["commit", "-m", file]).unwrap();
    }

    #[test]
    fn checkouts_mark_merged_and_behind_worktrees_stale() {
        let root = temp_repo();
        let behind = add_sibling(&root, "behind", "HEAD");
        let ahead = add_sibling(&root, "ahead", "HEAD");
        commit_in(&ahead, "ahead.txt");
        let merged = add_sibling(&root, "merged", "HEAD");
        commit_in(&merged, "merged.txt");
        checked_output(&root, &["merge", "--no-ff", "-m", "merge", "merged"]).unwrap();
        let fresh = add_sibling(&root, "fresh", "HEAD");
        // Behind the base branch too, but holding work nobody committed yet.
        let wip = add_sibling(&root, "wip", "HEAD~1");
        fs::write(wip.join("file.txt"), "changed\n").unwrap();
        fs::write(wip.join("new.txt"), "new\n").unwrap();
        let detached = root.with_file_name(format!(
            "{}-detached",
            root.file_name().unwrap().to_string_lossy()
        ));
        let detached_arg = git_arg(&detached);
        checked_output(
            &root,
            &["worktree", "add", "--detach", &detached_arg, "HEAD~1"],
        )
        .unwrap();

        let found = worktree_checkouts_inner(&root.to_string_lossy(), true).unwrap();
        let checkout = |branch: Option<&str>| {
            found
                .worktrees
                .iter()
                .find(|checkout| checkout.branch.as_deref() == branch)
                .unwrap()
        };
        let stale = |branch: &str| checkout(Some(branch)).stale;
        let base = current_branch(&root);
        assert!(!stale(&base), "the main checkout is never stale");
        assert!(stale("merged"), "merged into the base branch");
        assert!(
            stale("behind"),
            "behind the base branch with no own commits"
        );
        assert!(!stale("ahead"), "has commits the base branch lacks");
        assert!(
            stale("fresh"),
            "level with the base branch, nothing of its own"
        );
        assert_eq!(found.base.as_deref(), Some(base.as_str()));
        assert!(!stale("wip"), "uncommitted work is not stale");
        assert_eq!(checkout(Some("wip")).uncommitted, Some(2));
        assert_eq!(checkout(Some("merged")).uncommitted, Some(0));
        assert!(!checkout(None).stale, "a detached worktree is never stale");

        // Without the status pass nothing is counted, nor marked.
        let quick = worktree_checkouts_inner(&root.to_string_lossy(), false).unwrap();
        assert!(quick
            .worktrees
            .iter()
            .all(|checkout| !checkout.stale && checkout.uncommitted.is_none()));

        for dir in [&behind, &ahead, &merged, &fresh, &wip, &detached, &root] {
            let _ = fs::remove_dir_all(dir);
        }
    }

    #[cfg(windows)]
    #[test]
    fn an_untracked_junction_alone_leaves_a_merged_worktree_stale_and_removable() {
        let root = temp_repo();
        let deps = root.join("deps");
        fs::create_dir_all(&deps).unwrap();
        fs::write(deps.join("sentinel.txt"), "keep").unwrap();
        let linked = add_sibling(&root, "linked", "HEAD");
        commit_in(&root, "base-moved.txt");
        junction(&linked.join("node_modules"), &deps);

        let found = worktree_checkouts_inner(&root.to_string_lossy(), true).unwrap();
        let listed = found
            .worktrees
            .iter()
            .find(|checkout| checkout.branch.as_deref() == Some("linked"))
            .unwrap();
        assert!(listed.stale);
        assert_eq!(listed.uncommitted, Some(0));

        worktree_remove_checkout_inner(&linked.to_string_lossy(), |_| None, |_| {}).unwrap();
        assert!(deps.join("sentinel.txt").is_file());
        assert!(!linked.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_checkout_refuses_the_main_dirty_and_unknown_ones() {
        let root = temp_repo();
        let dirty = add_sibling(&root, "dirty", "HEAD");
        fs::write(dirty.join("file.txt"), "changed\n").unwrap();
        let untracked = add_sibling(&root, "untracked", "HEAD");
        fs::write(untracked.join("new.txt"), "new\n").unwrap();
        let clean = add_sibling(&root, "clean", "HEAD");
        // A watch the app holds inside the clean worktree, and one in the main checkout.
        let mut watcher = notify::recommended_watcher(|_| {}).unwrap();
        notify::Watcher::watch(&mut watcher, &clean, notify::RecursiveMode::NonRecursive).unwrap();
        let key = |dir: &Path| dir.join("file.txt").to_string_lossy().into_owned();
        let watchers = std::sync::Mutex::new(std::collections::HashMap::from([
            (key(&clean), Some(watcher)),
            (key(&root), None),
        ]));
        let released = std::cell::Cell::new(false);
        let remove = |dir: &Path| {
            worktree_remove_checkout_inner(
                &dir.to_string_lossy(),
                |_| None,
                |target| {
                    released.set(true);
                    release_watchers_under(&watchers, target);
                },
            )
        };

        assert_eq!(remove(&root).unwrap_err(), "worktree_is_main");
        assert_eq!(remove(&dirty).unwrap_err(), "worktree_dirty");
        assert_eq!(remove(&untracked).unwrap_err(), "worktree_dirty");
        assert!(dirty.is_dir() && untracked.is_dir());
        assert_eq!(
            remove(&root.join("not-a-checkout")).unwrap_err(),
            "worktree_not_found"
        );
        assert!(!released.get(), "nothing is released for a refused removal");

        remove(&clean).unwrap();
        assert!(!clean.exists());
        let kept: Vec<String> = watchers.lock().unwrap().keys().cloned().collect();
        assert_eq!(kept, vec![key(&root)]);
        let listed = worktree_checkouts_inner(&root.to_string_lossy(), false).unwrap();
        assert_eq!(listed.worktrees.len(), 3);

        for dir in [&dirty, &untracked, &root] {
            let _ = fs::remove_dir_all(dir);
        }
    }

    // ========================================================================

    //

    //

    // manualmente com `cargo test --lib worktrees::tests::opencode_e2e -- --ignored --nocapture`.
    #[cfg(test)]
    mod opencode_e2e {
        use super::temp_repo;
        use crate::worktrees::WorktreeMode;
        use crate::worktrees::{
            worktree_list_inner as worktree_list, worktree_provision_inner as worktree_provision,
            worktree_remove_inner as worktree_remove,
        };
        use std::fs;
        use std::path::{Path, PathBuf};
        use std::process::{Command, Stdio};
        use std::time::{SystemTime, UNIX_EPOCH};

        /// corrida nenhuma, ainda mais com N agentes paralelos.
        fn opencode_binary() -> Option<PathBuf> {
            crate::cli_resolver::find_windows_cli_launcher("opencode")
        }

        const FREE_MODEL: &str = "opencode/deepseek-v4-flash-free";

        fn task_pool() -> Vec<(&'static str, &'static str, &'static str)> {
            vec![
                (
                    "Crie um arquivo chamado resultado.txt contendo exatamente a palavra ALFA (maiúsculas, sem mais nada). Não peça confirmação, apenas crie.",
                    "resultado.txt",
                    "ALFA",
                ),
                (
                    "Crie um arquivo chamado resultado.txt contendo exatamente a palavra BETA (maiúsculas, sem mais nada). Não peça confirmação, apenas crie.",
                    "resultado.txt",
                    "BETA",
                ),
                (
                    "Crie um arquivo chamado resultado.txt contendo exatamente a palavra GAMA (maiúsculas, sem mais nada). Não peça confirmação, apenas crie.",
                    "resultado.txt",
                    "GAMA",
                ),
            ]
        }

        fn pick_pseudo_random<T: Copy>(pool: &[T], salt: u128) -> T {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
                .wrapping_add(salt);
            pool[(nanos as usize) % pool.len()]
        }

        struct OpenCodeRunOutcome {
            session_id: String,
            raw_events: Vec<serde_json::Value>,
        }

        /// Runs `opencode run` non-interactively, without --pure (graphify needs
        /// to show up), with --auto (approves permissions without stalling the
        /// script), and captures the --format json stream line by line.
        fn run_opencode(
            bin: &Path,
            cwd: &Path,
            prompt: &str,
            session_id: Option<&str>,
        ) -> Result<OpenCodeRunOutcome, String> {
            let mut cmd = Command::new(bin);
            cmd.current_dir(cwd)
                .args(["run", "--format", "json", "--auto", "-m", FREE_MODEL]);
            if let Some(id) = session_id {
                cmd.args(["--session", id]);
            }
            cmd.arg(prompt);
            cmd.stdout(Stdio::piped());
            cmd.stderr(Stdio::piped());

            let output = cmd
                .output()
                .map_err(|e| format!("falha ao rodar opencode: {e}"))?;
            if !output.status.success() {
                return Err(format!(
                    "opencode run saiu com codigo {:?}\nstderr: {}\nstdout (ultimos 2000 chars): {}",
                    output.status.code(),
                    String::from_utf8_lossy(&output.stderr),
                    String::from_utf8_lossy(&output.stdout)
                        .chars()
                        .rev()
                        .take(2000)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>()
                ));
            }

            let mut raw_events = Vec::new();
            let mut session_id_found: Option<String> = None;
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                if session_id_found.is_none() {
                    if let Some(sid) = value.get("sessionID").and_then(|v| v.as_str()) {
                        session_id_found = Some(sid.to_string());
                    }
                }
                raw_events.push(value);
            }

            let session_id = session_id_found
                .ok_or_else(|| "sessionID nunca apareceu no stream de eventos".to_string())?;
            Ok(OpenCodeRunOutcome {
                session_id,
                raw_events,
            })
        }

        #[test]
        #[ignore]
        fn parallel_opencode_agents_respect_worktree_isolation_and_session_continuity() {
            let Some(bin) = opencode_binary() else {
                eprintln!("[e2e] opencode não encontrado no PATH — pulando (instale o CLI pra rodar este teste)");
                return;
            };

            const N: usize = 2; // paralelismo real, mas contido (custo/tempo de rede).
            let root = temp_repo();
            let root_str = root.to_string_lossy().into_owned();

            let pool = task_pool();

            // 1) Provisiona N worktrees.
            let mut worktrees = Vec::new();
            for i in 0..N {
                let agent_id = format!("e2e-{i}");
                let wt = worktree_provision(
                    root_str.clone(),
                    agent_id.clone(),
                    WorktreeMode::GitWorktree,
                )
                .expect("worktree_provision falhou");
                let wt_path = PathBuf::from(&wt.path);

                let _ = crate::graphify::graphify_opencode_config_write_inner(
                    wt_path.to_string_lossy().into_owned(),
                    None,
                );
                let (prompt, expected_file, expected_content) =
                    pick_pseudo_random(&pool, i as u128 * 7919);
                worktrees.push((agent_id, wt_path, prompt, expected_file, expected_content));
            }

            // 2) Dispara os N `opencode run` em paralelo de verdade (threads,

            let handles: Vec<_> = worktrees
                .iter()
                .map(|(agent_id, wt_path, prompt, _, _)| {
                    let bin = bin.clone();
                    let wt_path = wt_path.clone();
                    let prompt = prompt.to_string();
                    let agent_id = agent_id.clone();
                    std::thread::spawn(move || {
                        let result = run_opencode(&bin, &wt_path, &prompt, None);
                        (agent_id, result)
                    })
                })
                .collect();

            let mut outcomes = std::collections::HashMap::new();
            for h in handles {
                let (agent_id, result) = h
                    .join()
                    .expect("thread do opencode paralelo entrou em pânico");
                match result {
                    Ok(outcome) => {
                        outcomes.insert(agent_id, outcome);
                    }
                    Err(e) => panic!("agente {agent_id} falhou: {e}"),
                }
            }

            //    no repo principal.
            for (agent_id, wt_path, _, expected_file, expected_content) in &worktrees {
                let own_file = wt_path.join(expected_file);
                assert!(
                    own_file.is_file(),
                    "agente {agent_id} devia ter criado {expected_file} na própria worktree"
                );
                let content = fs::read_to_string(&own_file).unwrap_or_default();
                assert!(
                    content.contains(expected_content),
                    "conteúdo de {expected_file} do agente {agent_id} não bate com o esperado ({expected_content}): {content:?}"
                );

                for (other_id, other_path, _, _, other_expected_content) in &worktrees {
                    if other_id == agent_id || expected_content == other_expected_content {
                        continue;
                    }
                    let other_file = other_path.join(expected_file);
                    if !other_file.is_file() {
                        continue;
                    }
                    let other_content = fs::read_to_string(&other_file).unwrap_or_default();
                    assert!(
                        !other_content.contains(expected_content),
                        "vazamento: conteúdo do agente {agent_id} ({expected_content}) apareceu na worktree do agente {other_id}"
                    );
                }
                assert!(
                    !root.join(expected_file).is_file(),
                    "vazamento: arquivo do agente {agent_id} apareceu no repo principal (fora de qualquer worktree)"
                );
            }

            for (agent_id, wt_path, _, _, _) in &worktrees {
                let outcome = outcomes.get(agent_id).unwrap();
                let resumed = run_opencode(
                    &bin,
                    wt_path,
                    "Confirme rapidamente: qual arquivo voce acabou de criar?",
                    Some(&outcome.session_id),
                )
                .unwrap_or_else(|e| panic!("retomada de sessão falhou pro agente {agent_id}: {e}"));
                assert_eq!(
                    resumed.session_id, outcome.session_id,
                    "retomada com --session {} devia continuar a MESMA sessão pro agente {agent_id}, não criar uma nova",
                    outcome.session_id
                );
                assert!(
                    !resumed.raw_events.is_empty(),
                    "retomada da sessão do agente {agent_id} não produziu nenhum evento"
                );
            }

            for (agent_id, _, _, _, _) in &worktrees {
                worktree_remove(root_str.clone(), agent_id.clone(), true).unwrap_or_else(|e| {
                    panic!("worktree_remove falhou pro agente {agent_id}: {e}")
                });
            }
            assert_eq!(
                worktree_list(root_str).unwrap().len(),
                0,
                "nenhuma worktree deveria sobrar depois da limpeza"
            );

            fs::remove_dir_all(root).unwrap();
        }
    }
}
