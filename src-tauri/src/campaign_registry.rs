//! Writes the campaign registry (`.workflow/campanhas.json`) with the protocol of
//! agent-workflow-lab/bin/campanhas.py, so the Todo panel and the script never lose each other's
//! updates: the `campanhas.json.lock` file next to the registry, a check that the file is still the
//! version the panel read, and a temporary file in the same folder renamed over the registry.

use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long to wait for another writer, and the age after which its lock is taken over.
const LOCK_TIMEOUT: Duration = Duration::from_secs(10);
const LOCK_STALE: Duration = Duration::from_secs(60);

/// The error returned when the registry changed since the panel read it.
pub const CONFLICT: &str = "conflict";

/// Replaces the registry at `path` with `content`, formatted like campanhas.py writes it, when the
/// file is still exactly `expected_content`, the text the panel read; otherwise returns [`CONFLICT`].
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

/// Only `.workflow/campanhas.json` is writable through this command, and only when neither is a
/// link: a `.workflow` junction would lead the write to a folder anywhere on disk.
fn is_registry(path: &Path) -> bool {
    let Some(folder) = path.parent() else {
        return false;
    };
    path.is_absolute()
        && path
            .file_name()
            .is_some_and(|name| name == "campanhas.json")
        && folder.file_name().is_some_and(|name| name == ".workflow")
        && [folder, path]
            .iter()
            .all(|entry| fs::symlink_metadata(entry).is_ok_and(|meta| !is_link(&meta)))
        && fs::canonicalize(folder)
            .is_ok_and(|real| real.file_name().is_some_and(|name| name == ".workflow"))
}

/// The lock file, removed when dropped so every exit path releases it.
struct RegistryLock(PathBuf);

impl Drop for RegistryLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// `registry_lock` of campanhas.py: create `campanhas.json.lock` exclusively, retrying until
/// `timeout`, and take over a lock older than `LOCK_STALE`.
fn lock(registry: &Path, timeout: Duration) -> Result<RegistryLock, String> {
    let path = registry.with_file_name("campanhas.json.lock");
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
    registry: &Path,
    expected_content: &str,
    content: &str,
    timeout: Duration,
) -> Result<(), String> {
    if !is_registry(registry) {
        return Err("not a campaign registry: .workflow/campanhas.json".to_string());
    }
    let data: serde_json::Value =
        serde_json::from_str(content).map_err(|error| format!("invalid registry: {error}"))?;
    if !data
        .get("campanhas")
        .is_some_and(serde_json::Value::is_array)
    {
        return Err("invalid registry: no campanhas list".to_string());
    }
    // `json.dumps(data, ensure_ascii=False, indent=2) + "\n"`; preserve_order keeps the key order.
    let text = serde_json::to_string_pretty(&data).map_err(|error| error.to_string())? + "\n";

    let _lock = lock(registry, timeout)?;
    // Read under the lock: a write from the script after the panel's read is a conflict.
    let current = fs::read(registry).map_err(|error| error.to_string())?;
    if current != expected_content.as_bytes() {
        return Err(CONFLICT.to_string());
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let temporary =
        registry.with_file_name(format!("campanhas.json.{}.{stamp}.tmp", std::process::id()));
    let written = fs::write(&temporary, text).and_then(|()| fs::rename(&temporary, registry));
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    const ORIGINAL: &str = "{\n  \"campanhas\": []\n}\n";

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
