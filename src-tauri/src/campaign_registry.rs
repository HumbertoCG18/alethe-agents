//! Writes the campaign registry (`.workflow/campanhas.json`) and its night diaries
//! (`.workflow/local/noites/<YYYY-MM-DD>.json`) with the protocol of
//! agent-workflow-lab/bin/campanhas.py, so the Todo panel and the script never lose each other's
//! updates: a `<file>.lock` file next to it, a check that the file is still the version the panel
//! read, and a temporary file in the same folder renamed over it.

use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

/// How long to wait for another writer, and the age after which its lock is taken over.
const LOCK_TIMEOUT: Duration = Duration::from_secs(10);
const LOCK_STALE: Duration = Duration::from_secs(60);

/// The error returned when the file changed since the panel read it.
pub const CONFLICT: &str = "conflict";

/// Replaces the registry or a night diary at `path` with `content`, formatted like campanhas.py
/// writes it, when the file is still exactly `expected_content`, the text the panel read (empty
/// for a diary not written yet); otherwise returns [`CONFLICT`].
#[tauri::command]
pub async fn campaign_registry_write(
    path: String,
    expected_content: String,
    content: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        write_registry(
            Path::new(path.trim()),
            &expected_content,
            &content,
            LOCK_TIMEOUT,
        )
    })
    .await
    .map_err(|error| format!("campaign_registry_write: blocking task failed: {error}"))?
}

/// A symlink, or on Windows any reparse point (junctions included).
fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

/// The files this command writes.
#[derive(Clone, Copy, PartialEq)]
enum Target {
    /// `.workflow/campanhas.json`
    Registry,
    /// `.workflow/local/noites/<YYYY-MM-DD>.json`, written by `campanhas.py noite`.
    Diary,
}

const REFUSED: &str =
    "not a campaign registry or night diary: .workflow/campanhas.json or .workflow/local/noites/<date>.json";

fn named(path: &Path, name: &str) -> bool {
    path.file_name().is_some_and(|own| own == name)
}

/// `YYYY-MM-DD.json`
fn is_diary_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    name.len() == 15
        && name.ends_with(".json")
        && bytes[..10].iter().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                *byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
}

/// What `path` names by its shape alone, with the `.workflow` folder above it.
fn target_of(path: &Path) -> Option<(Target, &Path)> {
    if !path.is_absolute() {
        return None;
    }
    let name = path.file_name()?.to_str()?;
    let folder = path.parent()?;
    if name == "campanhas.json" && named(folder, ".workflow") {
        return Some((Target::Registry, folder));
    }
    let local = folder.parent()?;
    let workflow = local.parent()?;
    (is_diary_name(name)
        && named(folder, "noites")
        && named(local, "local")
        && named(workflow, ".workflow"))
    .then_some((Target::Diary, workflow))
}

fn real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir() && !is_link(&meta))
}

/// Creates a diary's `local/noites` folders as campanhas.py does, one level at a time below a real
/// `.workflow` so a link is never followed; the registry and `.workflow` are never created.
fn create_folders(path: &Path, target: Target, workflow: &Path) -> Result<(), String> {
    if target != Target::Diary || !real_dir(workflow) {
        return Ok(());
    }
    let folder = path.parent().ok_or(REFUSED)?;
    for dir in [folder.parent().ok_or(REFUSED)?, folder] {
        if let Err(error) = fs::create_dir(dir) {
            if error.kind() != ErrorKind::AlreadyExists {
                return Err(error.to_string());
            }
        }
        if !real_dir(dir) {
            return Err(REFUSED.to_string());
        }
    }
    Ok(())
}

/// Checks that nothing from `.workflow` down to the file is a link: a junction would lead the write
/// to a folder anywhere on disk. Made before the lock, again under it, and again before the rename.
fn checked_path(path: &Path, target: Target, workflow: &Path) -> Result<(), String> {
    let folder = path.parent().ok_or(REFUSED)?;
    let folders = match target {
        Target::Registry => vec![workflow],
        Target::Diary => vec![workflow, folder.parent().ok_or(REFUSED)?, folder],
    };
    if !folders.into_iter().all(real_dir) {
        return Err(REFUSED.to_string());
    }
    let file = match fs::symlink_metadata(path) {
        Ok(meta) => meta.is_file() && !is_link(&meta),
        Err(error) => target == Target::Diary && error.kind() == ErrorKind::NotFound,
    };
    let below: PathBuf = match target {
        Target::Registry => [".workflow"].iter().collect(),
        Target::Diary => [".workflow", "local", "noites"].iter().collect(),
    };
    if file && fs::canonicalize(folder).is_ok_and(|real| real.ends_with(&below)) {
        Ok(())
    } else {
        Err(REFUSED.to_string())
    }
}

/// `content` as campanhas.py writes it, when it is the kind of file `path` names: a registry has a
/// `campanhas` list, a diary an `entradas` list and the date of its file name.
fn formatted(path: &Path, target: Target, content: &str) -> Result<String, String> {
    let data: Value =
        serde_json::from_str(content).map_err(|error| format!("invalid content: {error}"))?;
    let valid = match target {
        Target::Registry => data.get("campanhas").is_some_and(Value::is_array),
        Target::Diary => {
            data.get("entradas").is_some_and(Value::is_array)
                && data
                    .get("data")
                    .and_then(Value::as_str)
                    .is_some_and(|day| path.file_stem().is_some_and(|stem| stem == day))
        }
    };
    if !valid {
        return Err(match target {
            Target::Registry => "invalid registry: no campanhas list",
            Target::Diary => "invalid night diary: no entradas list for its date",
        }
        .to_string());
    }
    // `json.dumps(data, ensure_ascii=False, indent=2) + "\n"`; preserve_order keeps the key order.
    Ok(serde_json::to_string_pretty(&data).map_err(|error| error.to_string())? + "\n")
}

/// The lock file, removed when dropped so every exit path releases it.
struct RegistryLock(PathBuf);

impl Drop for RegistryLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// `registry_lock` of campanhas.py: create `<file>.lock` exclusively, retrying until `timeout`,
/// and take over a lock older than `LOCK_STALE`.
fn lock(file: &Path, timeout: Duration) -> Result<RegistryLock, String> {
    let name = file.file_name().ok_or(REFUSED)?.to_string_lossy();
    let path = file.with_file_name(format!("{name}.lock"));
    let deadline = Instant::now() + timeout;
    loop {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => return Ok(RegistryLock(path)),
            // Windows reports a lock file being deleted by its owner as access denied.
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::AlreadyExists | ErrorKind::PermissionDenied
                ) =>
            {
                let stale = fs::metadata(&path)
                    .and_then(|meta| meta.modified())
                    .is_ok_and(|modified| modified.elapsed().is_ok_and(|age| age > LOCK_STALE));
                // Retry at once only after taking a stale lock over; anything else, including a
                // stale lock that cannot be removed, waits and counts against the deadline.
                if stale && fs::remove_file(&path).is_ok() {
                    continue;
                }
                if Instant::now() > deadline {
                    return Err(format!("registry in use: {}", path.display()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn write_registry(
    file: &Path,
    expected_content: &str,
    content: &str,
    timeout: Duration,
) -> Result<(), String> {
    let (target, workflow) = target_of(file).ok_or(REFUSED)?;
    let text = formatted(file, target, content)?;
    create_folders(file, target, workflow)?;
    checked_path(file, target, workflow)?;

    let _lock = lock(file, timeout)?;
    #[cfg(test)]
    tests::after_lock();
    // A folder may have been swapped for a link since the first check.
    checked_path(file, target, workflow)?;
    // Read under the lock: a write from the script after the panel's read is a conflict.
    let current = match fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) if target == Target::Diary && error.kind() == ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.to_string()),
    };
    if current != expected_content.as_bytes() {
        return Err(CONFLICT.to_string());
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let name = file.file_name().ok_or(REFUSED)?.to_string_lossy();
    let temporary = file.with_file_name(format!("{name}.{}.{stamp}.tmp", std::process::id()));
    let renamed = fs::write(&temporary, text)
        .map_err(|error| error.to_string())
        .and_then(|()| checked_path(file, target, workflow))
        .and_then(|()| fs::rename(&temporary, file).map_err(|error| error.to_string()));
    if renamed.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    renamed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    const ORIGINAL: &str = "{\n  \"campanhas\": []\n}\n";

    thread_local! {
        /// Runs once inside the next write of this thread, right after it takes the lock.
        static AFTER_LOCK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
            std::cell::RefCell::new(None);
    }

    pub(super) fn after_lock() {
        if let Some(hook) = AFTER_LOCK.with(|slot| slot.borrow_mut().take()) {
            hook();
        }
    }

    /// A folder swapped for a junction after the checks and the lock, before the write: the
    /// junction leads to another `.workflow`, so only a check made under the lock refuses it.
    #[cfg(windows)]
    #[test]
    fn refuses_a_folder_swapped_for_a_junction_while_it_held_the_lock() {
        let registry = registry();
        let workflow = registry.parent().unwrap().to_path_buf();
        let base = workflow.parent().unwrap().to_path_buf();
        let elsewhere = base.join("elsewhere").join(".workflow");
        fs::create_dir_all(elsewhere.join("local").join("noites")).unwrap();
        fs::write(elsewhere.join("campanhas.json"), ORIGINAL).unwrap();
        let diary = diary_of(&registry);
        fs::create_dir_all(diary.parent().unwrap()).unwrap();

        // (file, folder swapped, where its junction leads, expected content)
        let cases = [
            (
                registry.clone(),
                workflow.clone(),
                elsewhere.clone(),
                ORIGINAL,
            ),
            (
                diary.clone(),
                workflow.join("local"),
                elsewhere.join("local"),
                "",
            ),
        ];
        for (file, swapped, target, expected) in cases {
            let (moved, link) = (swapped.with_extension("real"), swapped.clone());
            AFTER_LOCK.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(move || {
                    fs::rename(&link, &moved).unwrap();
                    let made = std::process::Command::new("cmd")
                        .args(["/c", "mklink", "/J"])
                        .arg(&link)
                        .arg(&target)
                        .output()
                        .unwrap();
                    assert!(made.status.success(), "{made:?}");
                }))
            });
            let content = if expected.is_empty() { DIARY } else { SAMPLE };
            assert!(write_registry(&file, expected, content, LOCK_TIMEOUT).is_err());
            fs::remove_dir(&swapped).unwrap();
            fs::rename(swapped.with_extension("real"), &swapped).unwrap();
        }
        assert_eq!(
            fs::read_to_string(elsewhere.join("campanhas.json")).unwrap(),
            ORIGINAL
        );
        assert!(names_in(&elsewhere.join("local").join("noites")).is_empty());
        cleanup(&registry);
    }

    /// A fresh `<temp>/<unique>/.workflow/campanhas.json` holding `ORIGINAL`.
    fn registry() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let folder = std::env::temp_dir()
            .join(format!("alethe-campaign-registry-{suffix}"))
            .join(".workflow");
        fs::create_dir_all(&folder).unwrap();
        let path = folder.join("campanhas.json");
        fs::write(&path, ORIGINAL).unwrap();
        path
    }

    fn lock_of(path: &Path) -> PathBuf {
        path.with_file_name("campanhas.json.lock")
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    const SAMPLE: &str = r#"{"versao":1,"projeto":"p","campanhas":[{"id":"Z","titulo":"Concluída → \"q\" \\ x\n\t\u0001","prioridade":1.5,"depende_de":[],"extra":{},"decomposta":false,"nada":null,"tarefas":[{"id":"Z-01","estado":"em execução","a":true}]}]}"#;

    /// `json.dumps(json.loads(SAMPLE), ensure_ascii=False, indent=2) + "\n"`, printed by Python.
    const PYTHON: &str = "{\n  \"versao\": 1,\n  \"projeto\": \"p\",\n  \"campanhas\": [\n    {\n      \"id\": \"Z\",\n      \"titulo\": \"Concluída → \\\"q\\\" \\\\ x\\n\\t\\u0001\",\n      \"prioridade\": 1.5,\n      \"depende_de\": [],\n      \"extra\": {},\n      \"decomposta\": false,\n      \"nada\": null,\n      \"tarefas\": [\n        {\n          \"id\": \"Z-01\",\n          \"estado\": \"em execução\",\n          \"a\": true\n        }\n      ]\n    }\n  ]\n}\n";

    #[test]
    fn writes_in_the_format_campanhas_py_writes() {
        let path = registry();
        write_registry(&path, ORIGINAL, SAMPLE, LOCK_TIMEOUT).unwrap();
        // Key order kept, two-space indent, UTF-8 unescaped, trailing newline.
        assert_eq!(fs::read_to_string(&path).unwrap(), PYTHON);
        cleanup(&path);
    }

    #[test]
    fn replaces_the_file_atomically_and_leaves_no_temporary_or_lock_behind() {
        let path = registry();
        write_registry(&path, ORIGINAL, SAMPLE, LOCK_TIMEOUT).unwrap();
        let mut names: Vec<String> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["campanhas.json"]);
        // The new version is the base for the next write.
        write_registry(&path, PYTHON, ORIGINAL, LOCK_TIMEOUT).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), ORIGINAL);
        cleanup(&path);
    }

    #[test]
    fn refuses_with_conflict_when_the_file_changed_since_it_was_read() {
        let path = registry();
        let error = write_registry(&path, "older text", SAMPLE, LOCK_TIMEOUT).unwrap_err();
        assert_eq!(error, CONFLICT);
        assert_eq!(fs::read_to_string(&path).unwrap(), ORIGINAL);
        assert!(!lock_of(&path).exists());
        cleanup(&path);
    }

    #[test]
    fn waits_for_a_held_lock_and_never_writes_under_it() {
        let path = registry();
        fs::write(lock_of(&path), "").unwrap();
        let error =
            write_registry(&path, ORIGINAL, SAMPLE, Duration::from_millis(200)).unwrap_err();
        assert!(error.contains("in use"), "{error}");
        assert_eq!(fs::read_to_string(&path).unwrap(), ORIGINAL);
        // The other writer's lock is not ours to remove.
        assert!(lock_of(&path).exists());

        // Released while waiting: the write goes through and removes its own lock.
        let lock = lock_of(&path);
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            fs::remove_file(lock).unwrap();
        });
        write_registry(&path, ORIGINAL, SAMPLE, LOCK_TIMEOUT).unwrap();
        release.join().unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), PYTHON);
        assert!(!lock_of(&path).exists());
        cleanup(&path);
    }

    #[test]
    fn takes_over_a_stale_lock() {
        let path = registry();
        let lock = fs::File::create(lock_of(&path)).unwrap();
        lock.set_modified(SystemTime::now() - Duration::from_secs(120))
            .unwrap();
        drop(lock);
        write_registry(&path, ORIGINAL, SAMPLE, Duration::from_millis(200)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), PYTHON);
        assert!(!lock_of(&path).exists());
        cleanup(&path);
    }

    #[test]
    fn refuses_a_path_that_is_not_a_campaign_registry() {
        let path = registry();
        let folder = path.parent().unwrap();
        let other = folder.join("other.json");
        fs::write(&other, ORIGINAL).unwrap();
        let outside = folder.parent().unwrap().join("campanhas.json");
        fs::write(&outside, ORIGINAL).unwrap();
        for target in [&other, &outside] {
            assert!(write_registry(target, ORIGINAL, SAMPLE, LOCK_TIMEOUT).is_err());
            assert_eq!(fs::read_to_string(target).unwrap(), ORIGINAL);
        }
        // Content that is not a registry is refused too.
        assert!(write_registry(&path, ORIGINAL, "[1]", LOCK_TIMEOUT).is_err());
        assert!(write_registry(&path, ORIGINAL, "{", LOCK_TIMEOUT).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), ORIGINAL);
        assert!(!lock_of(&path).exists());
        cleanup(&path);
    }

    /// A `.workflow` junction leads to another folder: the file behind it is not this registry,
    /// whatever that folder is named.
    #[cfg(windows)]
    #[test]
    fn refuses_a_registry_reached_through_a_junction() {
        let path = registry();
        let base = path.parent().unwrap().parent().unwrap().to_path_buf();
        for (repo, target) in [("repo-a", "elsewhere"), ("repo-b", "other\\.workflow")] {
            let target = base.join(target);
            fs::create_dir_all(&target).unwrap();
            let outside = target.join("campanhas.json");
            fs::write(&outside, ORIGINAL).unwrap();
            let junction = base.join(repo).join(".workflow");
            fs::create_dir_all(junction.parent().unwrap()).unwrap();
            let made = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(&junction)
                .arg(&target)
                .output()
                .unwrap();
            assert!(made.status.success(), "{made:?}");

            let through = junction.join("campanhas.json");
            assert!(write_registry(&through, ORIGINAL, SAMPLE, LOCK_TIMEOUT).is_err());
            assert_eq!(fs::read_to_string(&outside).unwrap(), ORIGINAL);
            assert!(!target.join("campanhas.json.lock").exists());
            fs::remove_dir(&junction).unwrap();
        }
        cleanup(&path);
    }

    const DIARY: &str = r#"{"data":"2026-10-03","entradas":[{"tarefa":"T-01","resultado":"parou","resumo":"tempo esgotado","evidencia":"","hora":"00:40"}]}"#;

    /// `json.dumps(json.loads(DIARY), ensure_ascii=False, indent=2) + "\n"`.
    const DIARY_PYTHON: &str = "{\n  \"data\": \"2026-10-03\",\n  \"entradas\": [\n    {\n      \"tarefa\": \"T-01\",\n      \"resultado\": \"parou\",\n      \"resumo\": \"tempo esgotado\",\n      \"evidencia\": \"\",\n      \"hora\": \"00:40\"\n    }\n  ]\n}\n";

    /// `<registry folder>/local/noites/2026-10-03.json`, not created.
    fn diary_of(registry: &Path) -> PathBuf {
        registry
            .parent()
            .unwrap()
            .join("local")
            .join("noites")
            .join("2026-10-03.json")
    }

    fn names_in(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn writes_a_new_night_diary_and_its_folders_as_campanhas_py_noite() {
        let registry = registry();
        let diary = diary_of(&registry);
        // No file yet: the panel read nothing, so it expects nothing.
        write_registry(&diary, "", DIARY, LOCK_TIMEOUT).unwrap();
        assert_eq!(fs::read_to_string(&diary).unwrap(), DIARY_PYTHON);
        assert_eq!(names_in(diary.parent().unwrap()), ["2026-10-03.json"]);
        cleanup(&registry);
    }

    #[test]
    fn appends_to_a_night_diary_only_while_it_is_the_text_read() {
        let registry = registry();
        let diary = diary_of(&registry);
        fs::create_dir_all(diary.parent().unwrap()).unwrap();
        let original = "{\"data\": \"2026-10-03\", \"entradas\": []}\n";
        fs::write(&diary, original).unwrap();
        assert_eq!(
            write_registry(&diary, "", DIARY, LOCK_TIMEOUT).unwrap_err(),
            CONFLICT
        );
        assert_eq!(fs::read_to_string(&diary).unwrap(), original);
        write_registry(&diary, original, DIARY, LOCK_TIMEOUT).unwrap();
        assert_eq!(fs::read_to_string(&diary).unwrap(), DIARY_PYTHON);
        cleanup(&registry);
    }

    #[test]
    fn a_night_diary_waits_for_its_own_lock() {
        let registry = registry();
        let diary = diary_of(&registry);
        fs::create_dir_all(diary.parent().unwrap()).unwrap();
        let lock = diary.with_file_name("2026-10-03.json.lock");
        fs::write(&lock, "").unwrap();
        let error = write_registry(&diary, "", DIARY, Duration::from_millis(200)).unwrap_err();
        assert!(error.contains("in use"), "{error}");
        assert!(!diary.exists());
        assert!(lock.exists());
        cleanup(&registry);
    }

    #[test]
    fn refuses_what_is_not_a_night_diary() {
        let registry = registry();
        let workflow = registry.parent().unwrap().to_path_buf();
        let base = workflow.parent().unwrap().to_path_buf();
        for target in [
            workflow.join("local").join("noites").join("notes.json"),
            workflow.join("local").join("noites").join("2026-1-03.json"),
            workflow.join("noites").join("2026-10-03.json"),
            workflow.join("local").join("other").join("2026-10-03.json"),
            // No `.workflow` here: never created.
            base.join("repo")
                .join(".workflow")
                .join("local")
                .join("noites")
                .join("2026-10-03.json"),
        ] {
            assert!(
                write_registry(&target, "", DIARY, LOCK_TIMEOUT).is_err(),
                "{target:?}"
            );
            assert!(!target.exists());
        }
        assert!(!base.join("repo").exists());
        let diary = diary_of(&registry);
        for content in [
            r#"{"data":"2026-10-04","entradas":[]}"#,
            r#"{"data":"2026-10-03"}"#,
            ORIGINAL,
            "{",
        ] {
            assert!(
                write_registry(&diary, "", content, LOCK_TIMEOUT).is_err(),
                "{content}"
            );
        }
        assert!(!diary.exists());
        assert!(!workflow.join("local").exists());
        cleanup(&registry);
    }

    /// A `local` junction would put the diary anywhere on disk.
    #[cfg(windows)]
    #[test]
    fn refuses_a_night_diary_reached_through_a_junction() {
        let registry = registry();
        let workflow = registry.parent().unwrap().to_path_buf();
        let elsewhere = workflow.parent().unwrap().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(workflow.join("local"))
            .arg(&elsewhere)
            .output()
            .unwrap();
        assert!(made.status.success(), "{made:?}");
        assert!(write_registry(&diary_of(&registry), "", DIARY, LOCK_TIMEOUT).is_err());
        assert!(names_in(&elsewhere).is_empty());
        fs::remove_dir(workflow.join("local")).unwrap();
        cleanup(&registry);
    }

    /// A stale lock that cannot be removed is a failed attempt: the write gives up at the deadline.
    #[cfg(windows)]
    #[test]
    fn gives_up_on_a_stale_lock_it_cannot_remove() {
        use std::os::windows::fs::OpenOptionsExt;

        let path = registry();
        let lock = fs::File::create(lock_of(&path)).unwrap();
        lock.set_modified(SystemTime::now() - Duration::from_secs(120))
            .unwrap();
        drop(lock);
        // Held without delete sharing, so removing it fails.
        let held = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(lock_of(&path))
            .unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let target = path.clone();
        std::thread::spawn(move || {
            let _ = sender.send(write_registry(
                &target,
                ORIGINAL,
                SAMPLE,
                Duration::from_millis(300),
            ));
        });
        let result = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("the write never gave up on the lock");
        assert!(result.unwrap_err().contains("in use"));
        assert_eq!(fs::read_to_string(&path).unwrap(), ORIGINAL);
        drop(held);
        cleanup(&path);
    }
}
