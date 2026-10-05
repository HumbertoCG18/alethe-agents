//! One incremental reader per agent session, shared by the Todo panel, tab titles and Remote
//! Control. Each session keeps where it stopped in its transcript and parses only what was appended
//! since, into the events `handoff` reads, keeping a bounded window of the latest ones, its title,
//! and a revision that grows with every change.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};

use crate::claude_sessions::{first_text, truncate_chars};
use crate::codex_sessions::codex_user_prompt;
use crate::handoff::{line_events, read_capped_line, resolve_source_file, HandoffEvent, Provider};
use crate::provider_common::normalize_cwd;

/// The latest events a session keeps.
const WINDOW: usize = 200;
/// What a read returns when it names no limit: the Todo panel's tail.
const DEFAULT_LIMIT: usize = 20;
/// How many bytes at each end of what was read identify it, so a replaced file is never read as
/// appended to, whatever its size.
const FINGERPRINT_BYTES: u64 = 1024;
/// Sessions kept while nothing subscribes to them; the least recently used go first.
const MAX_IDLE: usize = 32;
const TITLE_CHARS: usize = 240;
pub(crate) const CHANGED_EVENT: &str = "session://changed";

/// Seeded with the clock, so a revision a client kept from before a restart is not handed out again
/// for other content.
fn next_revision() -> u64 {
    static NEXT: OnceLock<AtomicU64> = OnceLock::new();
    let next = NEXT.get_or_init(|| {
        AtomicU64::new(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis() as u64)
                .unwrap_or(0),
        )
    });
    next.fetch_add(1, Ordering::Relaxed) + 1
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRead {
    /// The session read; null while its transcript is not found.
    pub session_id: Option<String>,
    pub revision: u64,
    /// `since` was current: no events are returned.
    pub unchanged: bool,
    pub events: Vec<HandoffEvent>,
    pub title: Option<String>,
}

struct Session {
    provider: Provider,
    cwd: String,
    /// Empty for the newest session of `cwd`, which Remote Control falls back on.
    session_id: String,
    /// The session found and its transcript.
    file: Option<(String, PathBuf)>,
    /// Where the last complete line read ends.
    offset: u64,
    /// The first and the last bytes before `offset`, as they were read.
    seen: [Vec<u8>; 2],
    events: VecDeque<HandoffEvent>,
    ai_title: Option<String>,
    prompt: Option<String>,
    revision: u64,
}

impl Session {
    fn new(provider: Provider, cwd: &str, session_id: &str) -> Self {
        Self {
            provider,
            cwd: cwd.to_string(),
            session_id: session_id.to_string(),
            file: None,
            offset: 0,
            seen: Default::default(),
            events: VecDeque::new(),
            ai_title: None,
            prompt: None,
            revision: 0,
        }
    }

    fn clear(&mut self) {
        self.offset = 0;
        self.seen = Default::default();
        self.events.clear();
        self.ai_title = None;
        self.prompt = None;
    }

    fn bump(&mut self, changed: bool) -> bool {
        if changed {
            self.revision = next_revision();
        }
        changed
    }

    /// Reads what was appended since the last call. True when what it shows changed.
    fn sync(&mut self) -> Result<bool, String> {
        let mut changed = false;
        // A named session keeps the file it found; the newest of a folder is looked up each time.
        if self.file.is_none() || self.session_id.is_empty() {
            let requested = (!self.session_id.is_empty()).then_some(self.session_id.as_str());
            let found = resolve_source_file(self.provider, &self.cwd, requested)
                .ok()
                .map(|(id, path, _)| (id, path));
            if found != self.file {
                self.clear();
                self.file = found;
                changed = true;
            }
        }
        let Some((_, path)) = &self.file else {
            return Ok(self.bump(changed));
        };
        let Ok(mut file) = File::open(path) else {
            // Gone: it is looked up again on the next read.
            self.clear();
            self.file = None;
            return Ok(self.bump(true));
        };
        let len = file.metadata().map_err(|error| error.to_string())?.len();
        // Shorter than what was read, or other bytes where it was read: another file, start over.
        if len < self.offset
            || fingerprint(&mut file, self.offset).map_err(|error| error.to_string())? != self.seen
        {
            self.clear();
            changed = true;
        }
        if len == self.offset {
            return Ok(self.bump(changed));
        }
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|error| error.to_string())?;
        let mut reader = BufReader::with_capacity(64 * 1024, file);
        let mut buf = Vec::with_capacity(8 * 1024);
        let mut fresh = Vec::new();
        loop {
            let (read, complete) =
                read_capped_line(&mut reader, &mut buf).map_err(|error| error.to_string())?;
            // A line still being written is read once it ends.
            if !complete {
                break;
            }
            self.offset += read as u64;
            if let Ok(value) = serde_json::from_slice::<Value>(&buf) {
                line_events(self.provider, &value, &mut fresh);
                changed |= self.observe_title(&value);
            }
            // Trimmed line by line, so a long transcript's first read holds no more than the window.
            changed |= !fresh.is_empty();
            self.events.extend(fresh.drain(..));
            let excess = self.events.len().saturating_sub(WINDOW);
            self.events.drain(..excess);
        }
        self.seen = fingerprint(&mut reader.into_inner(), self.offset)
            .map_err(|error| error.to_string())?;
        Ok(self.bump(changed))
    }

    /// Follows the title as the sidebar always derived it: Claude's first `ai-title`, otherwise the
    /// first user prompt. True when it changed.
    fn observe_title(&mut self, value: &Value) -> bool {
        let kind = value.get("type").and_then(Value::as_str);
        if self.provider == Provider::Claude && self.ai_title.is_none() && kind == Some("ai-title")
        {
            self.ai_title = value
                .get("aiTitle")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(str::to_string);
            return self.ai_title.is_some();
        }
        if self.prompt.is_some() {
            return false;
        }
        self.prompt = match self.provider {
            Provider::Claude if kind == Some("user") => first_text(value),
            Provider::Codex => codex_user_prompt(value),
            Provider::Claude => None,
        }
        .map(|text| truncate_chars(text.trim(), TITLE_CHARS));
        self.prompt.is_some()
    }

    fn read(&self, since: Option<u64>, limit: usize) -> SessionRead {
        let unchanged = self.revision != 0 && since == Some(self.revision);
        let skip = if unchanged {
            self.events.len()
        } else {
            self.events.len().saturating_sub(limit)
        };
        SessionRead {
            session_id: self.file.as_ref().map(|(id, _)| id.clone()),
            revision: self.revision,
            unchanged,
            events: self.events.iter().skip(skip).cloned().collect(),
            title: self.ai_title.clone().or_else(|| self.prompt.clone()),
        }
    }
}

/// The first and the last `FINGERPRINT_BYTES` before `offset`.
fn fingerprint(file: &mut File, offset: u64) -> std::io::Result<[Vec<u8>; 2]> {
    let size = offset.min(FINGERPRINT_BYTES);
    let mut read_at = |start: u64| -> std::io::Result<Vec<u8>> {
        let mut bytes = vec![0; size as usize];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    };
    Ok([read_at(0)?, read_at(offset - size)?])
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
    provider: Provider,
    cwd: String,
    session_id: String,
}

struct Slot {
    session: Arc<Mutex<Session>>,
    subscribers: usize,
    used: u64,
}

#[derive(Default)]
struct Slots {
    by_key: HashMap<Key, Slot>,
    tick: u64,
}

type Emit = Arc<dyn Fn(Value) + Send + Sync>;

/// The sessions read so far, as Tauri state. Change detection rides on the one recursive watcher
/// `session_watcher` already keeps on the Claude and Codex session folders, so subscribing a
/// session opens no watcher of its own; every read also checks the file's length.
#[derive(Clone, Default)]
pub struct SessionReaders {
    slots: Arc<Mutex<Slots>>,
    /// Sends a change to the app's windows. A closure, so that tests never link the window runtime.
    emit: Option<Emit>,
}

impl SessionReaders {
    pub fn for_app(app: AppHandle) -> Self {
        Self {
            slots: Arc::default(),
            emit: Some(Arc::new(move |change| {
                let _ = app.emit(CHANGED_EVENT, change);
            })),
        }
    }

    /// Runs `action` on a session's slot, made on first use.
    fn with_slot<T>(
        &self,
        provider: &str,
        cwd: &str,
        session_id: &str,
        action: impl FnOnce(&mut Slot) -> T,
    ) -> Result<T, String> {
        let provider = Provider::parse(provider)?;
        let key = Key {
            provider,
            cwd: normalize_cwd(cwd),
            session_id: session_id.trim().to_string(),
        };
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| "session readers are poisoned".to_string())?;
        slots.tick += 1;
        let tick = slots.tick;
        let slot = slots.by_key.entry(key).or_insert_with_key(|key| Slot {
            session: Arc::new(Mutex::new(Session::new(provider, cwd, &key.session_id))),
            subscribers: 0,
            used: tick,
        });
        slot.used = tick;
        let result = action(slot);
        // A new session or a released one can leave too many idle; this one, just used, stays.
        loop {
            let idle = slots
                .by_key
                .iter()
                .filter(|(_, slot)| slot.subscribers == 0);
            if idle.clone().count() <= MAX_IDLE {
                break;
            }
            let oldest = idle
                .min_by_key(|(_, slot)| slot.used)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                slots.by_key.remove(&oldest);
            }
        }
        Ok(result)
    }

    /// Counts a caller in (or out of) a session's changes, sent as `session://changed`.
    pub(crate) fn subscribe(
        &self,
        provider: &str,
        cwd: &str,
        session_id: &str,
        on: bool,
    ) -> Result<(), String> {
        named(session_id)?;
        self.with_slot(provider, cwd, session_id, |slot| {
            slot.subscribers = if on {
                slot.subscribers + 1
            } else {
                slot.subscribers.saturating_sub(1)
            };
        })
    }

    /// Reads a session (`None` for the newest of `cwd`) on from where it was read last, and returns
    /// its latest `limit` events.
    pub(crate) fn read(
        &self,
        provider: &str,
        cwd: &str,
        session_id: Option<&str>,
        since: Option<u64>,
        limit: usize,
    ) -> Result<SessionRead, String> {
        let (session, subscribed) =
            self.with_slot(provider, cwd, session_id.unwrap_or(""), |slot| {
                (slot.session.clone(), slot.subscribers > 0)
            })?;
        let mut session = session
            .lock()
            .map_err(|_| "session reader is poisoned".to_string())?;
        if session.sync()? && subscribed {
            self.emit(&session);
        }
        Ok(session.read(since, limit))
    }

    /// Remote Control's read: the tab's session, or the newest of its folder when it is not found.
    pub(crate) fn read_or_newest(
        &self,
        provider: &str,
        cwd: &str,
        session_id: Option<&str>,
        since: Option<u64>,
        limit: usize,
    ) -> Result<SessionRead, String> {
        let read = self.read(provider, cwd, session_id, since, limit)?;
        if read.session_id.is_some() || session_id.is_none_or(|id| id.trim().is_empty()) {
            return Ok(read);
        }
        self.read(provider, cwd, None, since, limit)
    }

    /// The session watcher saw `path` change: the subscribed sessions it belongs to read on.
    pub(crate) fn file_changed(&self, path: &Path) {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            return;
        };
        // Claude names a transcript `<id>.jsonl`, Codex `rollout-<time>-<id>.jsonl`.
        let watched: Vec<_> = match self.slots.lock() {
            Ok(slots) => slots
                .by_key
                .iter()
                .filter(|(key, slot)| {
                    slot.subscribers > 0
                        && !key.session_id.is_empty()
                        && name.ends_with(&format!("{}.jsonl", key.session_id))
                })
                .map(|(_, slot)| slot.session.clone())
                .collect(),
            Err(_) => return,
        };
        for session in watched {
            let Ok(mut session) = session.lock() else {
                continue;
            };
            if matches!(session.sync(), Ok(true)) {
                self.emit(&session);
            }
        }
    }

    fn emit(&self, session: &Session) {
        if let Some(emit) = &self.emit {
            emit(json!({
                "provider": session.provider.as_str(),
                "cwd": session.cwd,
                "sessionId": session.session_id,
                "revision": session.revision,
            }));
        }
    }
}

fn named(session_id: &str) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("a session id is required".to_string());
    }
    Ok(())
}

/// Counts the caller in for a session's changes, and makes sure its folder is watched: Claude's
/// first run creates it only once a tab already holds its session id.
#[tauri::command]
pub async fn session_subscribe(
    readers: State<'_, SessionReaders>,
    provider: String,
    cwd: String,
    session_id: String,
) -> Result<(), String> {
    readers.subscribe(&provider, &cwd, &session_id, true)?;
    crate::session_watcher::watch_session_folders();
    Ok(())
}

#[tauri::command]
pub fn session_unsubscribe(
    readers: State<'_, SessionReaders>,
    provider: String,
    cwd: String,
    session_id: String,
) -> Result<(), String> {
    readers.subscribe(&provider, &cwd, &session_id, false)
}

/// A session's latest events (`limit`, 20 by default, at most the window kept), title and
/// revision, off the main thread: a session's first read parses its whole transcript.
#[tauri::command]
pub async fn session_read(
    readers: State<'_, SessionReaders>,
    provider: String,
    cwd: String,
    session_id: String,
    since: Option<u64>,
    limit: Option<usize>,
) -> Result<SessionRead, String> {
    named(&session_id)?;
    let readers = readers.inner().clone();
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, WINDOW);
    tokio::task::spawn_blocking(move || {
        readers.read(&provider, &cwd, Some(&session_id), since, limit)
    })
    .await
    .map_err(|error| format!("session_read task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_file(name: &str) -> PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!("alethe-session-{name}-{suffix}.jsonl"))
    }

    fn append(path: &Path, text: &str) {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .expect("open fixture");
        file.write_all(text.as_bytes()).expect("append fixture");
    }

    fn claude(kind: &str, text: &str) -> String {
        format!(
            "{}\n",
            json!({ "type": kind, "message": { "content": [{ "type": "text", "text": text }] } })
        )
    }

    fn session_on(provider: Provider, path: &Path) -> Session {
        let mut session = Session::new(provider, "C:\\repo", "s-1");
        session.file = Some(("s-1".to_string(), path.to_path_buf()));
        session
    }

    fn texts(session: &Session) -> Vec<String> {
        session
            .read(None, WINDOW)
            .events
            .into_iter()
            .map(|event| event.text)
            .collect()
    }

    #[test]
    fn an_append_yields_only_the_new_events() {
        let path = temp_file("append");
        append(&path, &claude("user", "one"));
        let mut session = session_on(Provider::Claude, &path);
        assert!(session.sync().expect("first read"));
        let first = session.revision;
        assert_eq!(texts(&session), ["one"]);

        append(&path, &claude("assistant", "two"));
        assert!(session.sync().expect("second read"));
        assert!(session.revision > first);
        assert_eq!(texts(&session), ["one", "two"]);

        // Nothing appended: same revision, and a read from it is unchanged.
        assert!(!session.sync().expect("idle read"));
        let read = session.read(Some(session.revision), WINDOW);
        assert!(read.unchanged);
        assert!(read.events.is_empty());
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn a_partial_line_waits_until_it_ends() {
        let path = temp_file("partial");
        append(&path, &claude("user", "one"));
        let mut session = session_on(Provider::Claude, &path);
        session.sync().expect("first read");
        let line = claude("assistant", "two");
        let (start, end) = line.split_at(line.len() / 2);
        append(&path, start);
        assert!(!session.sync().expect("half a line"));
        assert_eq!(texts(&session), ["one"]);
        append(&path, end);
        assert!(session.sync().expect("the rest"));
        assert_eq!(texts(&session), ["one", "two"]);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn a_truncated_or_replaced_file_starts_over() {
        let path = temp_file("rotate");
        append(&path, &claude("user", "first prompt"));
        append(
            &path,
            &claude("assistant", "a long answer that makes the file longer"),
        );
        let mut session = session_on(Provider::Claude, &path);
        session.sync().expect("first read");

        std::fs::write(&path, claude("user", "short")).expect("truncate");
        assert!(session.sync().expect("after truncation"));
        assert_eq!(texts(&session), ["short"]);
        assert_eq!(session.read(None, 1).title.as_deref(), Some("short"));

        // Another file under the same name, longer than what was read.
        let replaced = claude("user", "replaced prompt") + &claude("assistant", "new answer");
        std::fs::write(&path, replaced).expect("replace");
        assert!(session.sync().expect("after replacement"));
        assert_eq!(texts(&session), ["replaced prompt", "new answer"]);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn a_replacement_of_the_same_size_starts_over() {
        let path = temp_file("same-size");
        append(&path, &claude("user", "one"));
        let mut session = session_on(Provider::Claude, &path);
        session.sync().expect("first read");
        let first = session.revision;

        std::fs::write(&path, claude("user", "two")).expect("replace");
        assert!(session.sync().expect("after replacement"));
        assert!(session.revision > first);
        assert_eq!(texts(&session), ["two"]);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn a_larger_replacement_with_the_same_head_starts_over() {
        let path = temp_file("same-head");
        let prompt = claude("user", &"a long prompt ".repeat(120));
        assert!(prompt.len() as u64 > FINGERPRINT_BYTES);
        append(
            &path,
            &(prompt.clone() + &claude("assistant", "old answer")),
        );
        let mut session = session_on(Provider::Claude, &path);
        session.sync().expect("first read");

        let replaced = prompt + &claude("assistant", "new answer") + &claude("assistant", "more");
        std::fs::write(&path, replaced).expect("replace");
        assert!(session.sync().expect("after replacement"));
        assert_eq!(&texts(&session)[1..], ["new answer", "more"]);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn keeps_a_bounded_window_of_the_latest_events() {
        let path = temp_file("window");
        let lines: String = (0..WINDOW + 50)
            .map(|index| claude("assistant", &format!("message {index}")))
            .collect();
        append(&path, &lines);
        let mut session = session_on(Provider::Claude, &path);
        session.sync().expect("read");
        assert_eq!(session.events.len(), WINDOW);
        let tail = session.read(None, DEFAULT_LIMIT).events;
        assert_eq!(tail.len(), DEFAULT_LIMIT);
        assert_eq!(
            tail.last().map(|event| event.text.as_str()),
            Some("message 249")
        );
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn tracks_the_title_as_the_sidebar_derived_it() {
        let path = temp_file("claude-title");
        append(&path, &claude("user", "  Fix the parser  "));
        let mut session = session_on(Provider::Claude, &path);
        session.sync().expect("read");
        assert_eq!(
            session.read(None, 1).title.as_deref(),
            Some("Fix the parser")
        );
        append(
            &path,
            "{\"type\":\"ai-title\",\"aiTitle\":\"Parser fix\"}\n",
        );
        append(
            &path,
            "{\"type\":\"ai-title\",\"aiTitle\":\"Later title\"}\n",
        );
        assert!(session.sync().expect("titled"));
        assert_eq!(session.read(None, 1).title.as_deref(), Some("Parser fix"));
        std::fs::remove_file(path).ok();

        let path = temp_file("codex-title");
        append(&path, "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<environment_context>x</environment_context>\"}]}}\n");
        append(&path, "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"oi\"}]}}\n");
        let mut session = session_on(Provider::Codex, &path);
        session.sync().expect("read");
        assert_eq!(session.read(None, 1).title.as_deref(), Some("oi"));
        std::fs::remove_file(path).ok();
    }

    /// A slot of `readers` on `path`, as a session whose transcript was already found.
    fn slot_on(readers: &SessionReaders, path: &Path, session_id: &str) -> Arc<Mutex<Session>> {
        let session = readers
            .with_slot("claude", "C:\\repo", session_id, |slot| {
                slot.session.clone()
            })
            .expect("slot");
        session.lock().expect("session").file = Some((session_id.to_string(), path.into()));
        session
    }

    #[test]
    fn only_subscribed_sessions_follow_their_file() {
        let readers = SessionReaders::default();
        let path = temp_file("watched");
        append(&path, &claude("user", "one"));
        // A Claude transcript is named `<id>.jsonl`.
        let id = path.file_stem().and_then(|stem| stem.to_str()).expect("id");
        let session = slot_on(&readers, &path, id);

        readers.file_changed(&path);
        assert_eq!(session.lock().expect("session").revision, 0);

        readers
            .subscribe("claude", "C:\\repo", id, true)
            .expect("subscribe");
        readers.file_changed(&path);
        let seen = session.lock().expect("session").revision;
        assert!(seen > 0);

        readers
            .subscribe("claude", "C:\\repo", id, false)
            .expect("unsubscribe");
        append(&path, &claude("assistant", "two"));
        readers.file_changed(&path);
        assert_eq!(session.lock().expect("session").revision, seen);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn keeps_a_bounded_number_of_idle_sessions() {
        let readers = SessionReaders::default();
        readers
            .subscribe("claude", "C:\\repo", "kept", true)
            .expect("subscribe");
        for index in 0..MAX_IDLE + 10 {
            readers
                .with_slot("claude", "C:\\repo", &format!("idle-{index}"), |_| ())
                .expect("slot");
        }
        let slots = readers.slots.lock().expect("slots");
        assert_eq!(slots.by_key.len(), MAX_IDLE + 1);
        assert!(slots.by_key.keys().any(|key| key.session_id == "kept"));
    }

    #[test]
    fn released_sessions_keep_the_idle_limit() {
        let readers = SessionReaders::default();
        // All in use at once, then let go of one after the other.
        for on in [true, false] {
            for index in 0..MAX_IDLE + 8 {
                readers
                    .subscribe("claude", "C:\\repo", &format!("used-{index}"), on)
                    .expect("subscribe");
            }
        }
        let slots = readers.slots.lock().expect("slots");
        assert_eq!(slots.by_key.len(), MAX_IDLE);
        // The least recently released go first.
        let last = format!("used-{}", MAX_IDLE + 7);
        assert!(slots.by_key.keys().any(|key| key.session_id == last));
        assert!(!slots.by_key.keys().any(|key| key.session_id == "used-0"));
    }
}
