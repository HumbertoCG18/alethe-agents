//! Taking a device's queued messages back out of Claude Code (#179), in two
//! steps the device asks for one at a time.
//!
//! 1. Pull: Claude Code's up arrow moves its whole queue into the input box,
//!    deleting nothing. Only sent when every queued message is this device's
//!    own and nobody else typed since. The queue comes from Claude Code's own
//!    transcript; who typed comes from the PTY's input ledger.
//! 2. Clear: the user saw the box on the terminal view and asked to erase it.
//!    Only sent when nobody wrote to the PTY since the pull.
//!
//! The transcript cannot prove what the up arrow pulled, so nothing ever
//! clears the box on its own. Anything uncertain refuses before a key is sent.

use serde_json::Value;

use crate::pty::InputLedger;

use super::util::sanitize_remote_message;

/// The queue holds something this device did not send, or someone else
/// typed since the send or the pull.
pub(crate) const QUEUE_SHARED: &str = "queue_shared";
/// Nothing queued as far as the transcript shows, or it lags behind the sends.
pub(crate) const QUEUE_UNKNOWN: &str = "queue_unknown";
/// Clearing the box would take more than `MAX_ROUNDS` key rounds.
pub(crate) const QUEUE_TOO_LONG: &str = "queue_too_long";
/// A queued photo is not in the asking tab, which could not restore it.
pub(crate) const QUEUE_PHOTO_MISSING: &str = "queue_photo_missing";
/// Nothing the clear names is known to be in the box: no pull by that id (a
/// stale or missing one), already cleared, or the device wrote again since.
pub(crate) const BOX_CHANGED: &str = "box_changed";

/// A send while this device's pulled text sits untouched in the input box:
/// the two would be submitted joined.
pub(crate) const BOX_PENDING: &str = "box_pending";

const MAX_ROUNDS: usize = 200;

/// One enqueue, or one prompt delivered straight, that the transcript logged.
#[derive(Debug)]
pub(crate) struct Logged {
    /// Line number in the transcript, to order enqueues against prompts.
    pub line: usize,
    pub at_ms: u64,
    pub content: String,
}

/// Claude Code's input queue as its transcript records it.
#[derive(Debug, Default)]
pub(crate) struct ClaudeLog {
    /// Every enqueue of this process, in log order.
    pub enqueued: Vec<Logged>,
    /// User prompts the agent received, in log order.
    pub prompts: Vec<Logged>,
    /// What is still queued, oldest first, as indices into `enqueued`.
    pub queue: Vec<usize>,
}

/// A transcript line that matters here.
enum Entry {
    /// A `queue-operation`: operation and content.
    Queue(String, String, Option<u64>),
    /// A user message's text.
    Prompt(String, Option<u64>),
}

fn entry(line: &str) -> Option<Entry> {
    let queue = line.contains("\"queue-operation\"");
    if !queue && !line.contains("\"user\"") {
        return None;
    }
    let value = serde_json::from_str::<Value>(line).ok()?;
    let at = value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .map(|at| at.timestamp_millis().max(0) as u64);
    match value.get("type").and_then(Value::as_str)? {
        "queue-operation" => {
            // A missing or non-text content stays as JSON, which matches no send.
            let content = match value.get("content") {
                Some(Value::String(text)) => text.clone(),
                other => other.cloned().unwrap_or_default().to_string(),
            };
            let operation = value.get("operation")?.as_str()?.to_string();
            Some(Entry::Queue(operation, content, at))
        }
        // A string, or the text parts; a tool result has none.
        "user" => match &value["message"]["content"] {
            Value::String(text) => Some(Entry::Prompt(text.clone(), at)),
            Value::Array(parts) => {
                let texts: Vec<&str> = parts
                    .iter()
                    .filter(|part| part["type"] == "text")
                    .filter_map(|part| part["text"].as_str())
                    .collect();
                (!texts.is_empty()).then(|| Entry::Prompt(texts.join(" "), at))
            }
            _ => None,
        },
        _ => None,
    }
}

impl ClaudeLog {
    pub(crate) fn items(&self) -> Vec<String> {
        self.queue
            .iter()
            .map(|index| self.enqueued[*index].content.clone())
            .collect()
    }

    /// Applies one entry. Anything logged before `started_ms` belongs to an
    /// earlier process.
    fn apply(&mut self, line: usize, entry: Entry, started_ms: u64) {
        match entry {
            Entry::Prompt(content, at) => {
                if let Some(at_ms) = at.filter(|at| *at >= started_ms) {
                    self.prompts.push(Logged {
                        line,
                        at_ms,
                        content,
                    });
                }
            }
            Entry::Queue(operation, content, at) => match operation.as_str() {
                "enqueue" => {
                    if let Some(at_ms) = at.filter(|at| *at >= started_ms) {
                        self.queue.push(self.enqueued.len());
                        self.enqueued.push(Logged {
                            line,
                            at_ms,
                            content,
                        });
                    }
                }
                "dequeue" if !self.queue.is_empty() => {
                    self.queue.remove(0);
                }
                // `popAll` is the up arrow moving the queue into the box, one
                // line per item (measured live on Claude Code 2.1.296).
                "remove" | "popAll" => {
                    let enqueued = &self.enqueued;
                    if let Some(at) = self
                        .queue
                        .iter()
                        .position(|index| enqueued[*index].content == content)
                    {
                        self.queue.remove(at);
                    }
                }
                _ => {}
            },
        }
    }
}

/// Claude Code's input queue as `jsonl` records it.
pub(crate) fn claude_queue(jsonl: &str, started_ms: u64) -> ClaudeLog {
    let mut log = ClaudeLog::default();
    for (line, text) in jsonl.lines().enumerate() {
        if let Some(entry) = entry(text) {
            log.apply(line, entry, started_ms);
        }
    }
    log
}

/// `text` without `[Image #N]` tags and with whitespace collapsed, and how
/// many tags it had.
fn normalized(text: &str) -> (String, usize) {
    const TAG: &str = "[Image #";
    let (mut kept, mut tags, mut rest) = (String::new(), 0, text);
    while let Some(at) = rest.find(TAG) {
        let after = &rest[at + TAG.len()..];
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && after[digits..].starts_with(']') {
            kept.push_str(&rest[..at]);
            kept.push(' ');
            tags += 1;
            rest = &after[digits + 1..];
        } else {
            kept.push_str(&rest[..at + TAG.len()]);
            rest = after;
        }
    }
    kept.push_str(rest);
    (kept.split_whitespace().collect::<Vec<_>>().join(" "), tags)
}

/// Rounds of the clearing burst for `queue` in the input box: one per row.
fn clear_rounds(queue: &[String], cols: u16) -> usize {
    // ponytail: the box is a few columns narrower than the terminal and a
    // non-ASCII char may take two; both err high, and a round on an empty box
    // does nothing. The live gate checks a long message.
    let width = usize::from(cols).saturating_sub(4).max(20);
    let rows = |item: &String| -> usize {
        item.split('\n')
            .map(|line| {
                let cells: usize = line.chars().map(|c| if c.is_ascii() { 1 } else { 2 }).sum();
                cells.div_ceil(width).max(1)
            })
            .sum()
    };
    queue.iter().map(|item| rows(item) + 1).sum::<usize>() + 2
}

/// What a pull may hand back.
#[derive(Debug, PartialEq)]
pub(crate) struct Picked {
    /// Ledger sequence of the first send taken back.
    pub since: u64,
    pub texts: Vec<String>,
    pub photos: Vec<String>,
}

/// Whether `device` may pull the queue in `log` back. `held` lists the photo
/// ids the asking tab still has; `cols` is the terminal width, for a box the
/// clear can still empty.
pub(crate) fn takeback_verdict(
    ledger: &InputLedger,
    device: usize,
    log: &ClaudeLog,
    held: &[String],
    cols: u16,
) -> Result<Picked, &'static str> {
    const SYSTEM_ITEMS: [&str; 3] = ["<task-notification>", "<agent-message", "<pasted_content"];
    let queue = log.items();
    if queue.is_empty() {
        return Err(QUEUE_UNKNOWN);
    }
    if queue
        .iter()
        .any(|item| SYSTEM_ITEMS.iter().any(|tag| item.contains(tag)))
    {
        return Err(QUEUE_SHARED);
    }
    // Each send claims, in order, the first entry of its text logged after it
    // was sent, one to one: a repeated text cannot stand in for a newer send
    // whose own enqueue the log has not shown yet. A send the agent received
    // straight as a prompt, before any enqueue of it, is not queued and drops
    // out; one with neither logged yet claims nothing.
    let mut mine = Vec::new();
    let mut claimed = Vec::new();
    let (mut next, mut next_prompt) = (0, 0);
    for send in ledger.sends().filter(|send| send.device == device) {
        let (text, tags) = normalized(&sanitize_remote_message(&send.text));
        let key = (text, tags + send.photos.len());
        let matches =
            |logged: &Logged| logged.at_ms >= send.sent_ms && normalized(&logged.content) == key;
        let enqueue = (next..log.enqueued.len()).find(|index| matches(&log.enqueued[*index]));
        let prompt = (next_prompt..log.prompts.len()).find(|index| matches(&log.prompts[*index]));
        match (enqueue, prompt) {
            (enqueue, Some(prompt))
                if enqueue.map_or(true, |enqueue| {
                    log.prompts[prompt].line < log.enqueued[enqueue].line
                }) =>
            {
                next_prompt = prompt + 1;
            }
            (enqueue, _) => {
                if let Some(index) = enqueue {
                    next = index + 1;
                }
                mine.push(send);
                claimed.push(enqueue);
            }
        }
    }
    if log
        .queue
        .iter()
        .any(|index| !claimed.contains(&Some(*index)))
    {
        return Err(QUEUE_SHARED);
    }
    // The queue must be exactly this device's latest sends, each one seen in
    // the log; a newer send still unconfirmed may be queued behind them.
    let expected: Vec<_> = log.queue.iter().map(|index| Some(*index)).collect();
    let tail = mine.len().checked_sub(log.queue.len());
    if !tail.is_some_and(|tail| claimed[tail..] == expected[..]) {
        return Err(QUEUE_UNKNOWN);
    }
    let taken = &mine[mine.len() - log.queue.len()..];
    let since = taken[0].start;
    if ledger.foreign_since(device, since) {
        return Err(QUEUE_SHARED);
    }
    let photos: Vec<String> = taken.iter().flat_map(|send| send.photos.clone()).collect();
    if photos.iter().any(|photo| !held.contains(photo)) {
        return Err(QUEUE_PHOTO_MISSING);
    }
    if clear_rounds(&queue, cols) > MAX_ROUNDS {
        return Err(QUEUE_TOO_LONG);
    }
    Ok(Picked {
        since,
        texts: taken.iter().map(|send| send.text.clone()).collect(),
        photos,
    })
}

/// Whether `device` may clear what its pull `pull_id` put in the input box,
/// and in how many rounds. That pull is used up either way; a clear naming an
/// older pull never touches a newer one.
pub(crate) fn clear_verdict(
    ledger: &mut InputLedger,
    device: usize,
    pull_id: &str,
    cols: u16,
) -> Result<usize, &'static str> {
    let pull = ledger.take_pull(device, pull_id).ok_or(BOX_CHANGED)?;
    if ledger.foreign_since(device, pull.next) {
        return Err(QUEUE_SHARED);
    }
    if ledger.next_seq() != pull.next {
        return Err(BOX_CHANGED);
    }
    Ok(clear_rounds(&pull.texts, cols).min(MAX_ROUNDS))
}

/// Claude Code's up arrow: moves the queued messages into its input box,
/// where they no longer send by themselves.
pub(crate) const PULL_KEY: &str = "\x1b[A";

/// Empties the input box: ctrl+u clears a wrapped row and backspace joins it
/// to the one above (checked live upstream: 689 chars cleared, not sent
/// later). On an empty box both should do nothing (the live gate checks), so
/// a spare round is harmless.
pub(crate) fn clear_box_keys(rounds: usize) -> String {
    format!("{}\x15", "\x15\x7f".repeat(rounds.clamp(1, MAX_ROUNDS) - 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::{RemoteSend, Writer};
    use serde_json::json;

    fn op(operation: &str, at: &str, content: Option<&str>) -> String {
        let mut value = json!({
            "type": "queue-operation",
            "operation": operation,
            "timestamp": at,
            "sessionId": "s",
        });
        if let Some(content) = content {
            value["content"] = json!(content);
        }
        value.to_string()
    }

    fn ms(at: &str) -> u64 {
        chrono::DateTime::parse_from_rfc3339(at)
            .unwrap()
            .timestamp_millis() as u64
    }

    const T1: &str = "2026-10-11T12:00:01.000Z";
    const T2: &str = "2026-10-11T12:00:02.000Z";
    const T3: &str = "2026-10-11T12:00:03.000Z";

    #[test]
    fn the_queue_follows_enqueue_dequeue_and_remove() {
        let log = [
            op("enqueue", T1, Some("a")),
            op("enqueue", T1, Some("b")),
            op("enqueue", T2, Some("c")),
            op("dequeue", T2, None),
            op("remove", T3, Some("c")),
            op("enqueue", T3, Some("d")),
        ]
        .join("\n");
        assert_eq!(claude_queue(&log, ms(T1)).items(), ["b", "d"]);
        // Dequeue on an empty queue and a remove of nothing change nothing.
        let log = [op("dequeue", T1, None), op("remove", T1, Some("x"))].join("\n");
        assert!(claude_queue(&log, 0).items().is_empty());
        // The up arrow pops the queue into the box, one line per item
        // (Claude Code 2.1.296, measured live).
        let log = [
            op("enqueue", T1, Some("a")),
            op("enqueue", T1, Some("b")),
            op("popAll", T2, Some("a")),
            op("popAll", T2, Some("b")),
            op("enqueue", T3, Some("c")),
        ]
        .join("\n");
        assert_eq!(claude_queue(&log, ms(T1)).items(), ["c"]);
    }

    #[test]
    fn the_queue_skips_an_earlier_process_and_broken_lines() {
        let user = json!({"type": "user", "message": {"content": "queue-operation enqueue"}});
        let log = [
            op("enqueue", T1, Some("orphan")),
            "{broken".to_string(),
            user.to_string(),
            op("enqueue", T3, Some("live")),
            op("enqueue", "not a time", Some("undated")),
            op("enqueue", T3, Some("cut")),
        ]
        .join("\n");
        // The last line is still being written: no newline, cut mid-object.
        let log = format!("{}\n{}", log, &op("enqueue", T3, Some("partial"))[..20]);
        assert_eq!(claude_queue(&log, ms(T2)).items(), ["live", "cut"]);
        assert!(claude_queue("", 0).items().is_empty());
    }

    fn sent(ledger: &mut InputLedger, device: usize, text: &str, photos: &[&str]) -> u64 {
        let start = ledger.next_seq();
        for _ in photos {
            ledger.record(Writer::Device(device), "\x1b[200~C:\\photo.jpg\x1b[201~");
        }
        ledger.record(Writer::Device(device), &format!("{text}\r"));
        ledger.remember_send(RemoteSend {
            device,
            start,
            text: text.into(),
            photos: photos.iter().map(|id| id.to_string()).collect(),
            sent_ms: start * 10,
        });
        start
    }

    fn logged(line: usize, at_ms: u64, content: &str) -> Logged {
        Logged {
            line,
            at_ms,
            content: content.into(),
        }
    }

    /// A log where `items` were enqueued, after every send, and still are.
    fn queue(items: &[&str]) -> ClaudeLog {
        ClaudeLog {
            enqueued: items
                .iter()
                .enumerate()
                .map(|(line, item)| logged(line, u64::MAX, item))
                .collect(),
            prompts: vec![],
            queue: (0..items.len()).collect(),
        }
    }

    #[test]
    fn a_repeated_text_never_stands_in_for_a_send_the_log_has_not_shown() {
        // The device sends "ok", the desktop types a draft, the device sends
        // "ok" again; the log has only shown the first enqueue so far. Up
        // would pull both, the draft included.
        let mut ledger = InputLedger::new(0);
        sent(&mut ledger, 1, "ok", &[]);
        ledger.record(Writer::Desktop, "secret ");
        sent(&mut ledger, 1, "ok", &[]);
        // Whether the enqueue came before the second send or after it.
        for at_ms in [15, 35] {
            let log = ClaudeLog {
                enqueued: vec![logged(0, at_ms, "ok")],
                prompts: vec![],
                queue: vec![0],
            };
            assert_eq!(
                takeback_verdict(&ledger, 1, &log, &[], 80).map(|_| ()),
                Err(QUEUE_UNKNOWN)
            );
        }
        // An enqueue logged before a send was sent is never that send's.
        let mut early = InputLedger::new(0);
        sent(&mut early, 1, "ok", &[]);
        let log = ClaudeLog {
            enqueued: vec![logged(0, 5, "ok")],
            prompts: vec![],
            queue: vec![0],
        };
        assert_eq!(
            takeback_verdict(&early, 1, &log, &[], 80).map(|_| ()),
            Err(QUEUE_SHARED)
        );
    }

    #[test]
    fn a_send_delivered_straight_leaves_the_enqueue_to_its_repeat() {
        // "continue" while idle reached the agent as a prompt; "continue"
        // again while busy is the one queued.
        let mut ledger = InputLedger::new(0);
        sent(&mut ledger, 1, "continue", &[]);
        let since = sent(&mut ledger, 1, "continue", &[]);
        let log = ClaudeLog {
            enqueued: vec![logged(1, 35, "continue")],
            prompts: vec![logged(0, 15, "continue")],
            queue: vec![0],
        };
        let picked = takeback_verdict(&ledger, 1, &log, &[], 80).unwrap();
        assert_eq!(
            (picked.since, picked.texts),
            (since, vec!["continue".to_string()])
        );
        // Without the prompt in the log, which send was queued stays unknown.
        let unseen = ClaudeLog {
            prompts: vec![],
            ..log
        };
        assert_eq!(
            takeback_verdict(&ledger, 1, &unseen, &[], 80).map(|_| ()),
            Err(QUEUE_UNKNOWN)
        );
    }

    #[test]
    fn a_device_takes_back_only_its_own_untouched_queue() {
        let mut ledger = InputLedger::new(0);
        sent(&mut ledger, 1, "delivered earlier", &[]);
        let since = sent(&mut ledger, 1, "first line\nsecond line", &["p1.jpg"]);
        let picked = takeback_verdict(
            &ledger,
            1,
            &queue(&["[Image #2] first line second line"]),
            &["p1.jpg".to_string()],
            80,
        )
        .unwrap();
        // The text comes back as the device wrote it, line break included.
        assert_eq!(
            picked,
            Picked {
                since,
                texts: vec!["first line\nsecond line".into()],
                photos: vec!["p1.jpg".into()],
            }
        );
    }

    #[test]
    fn a_takeback_refuses_anything_it_cannot_prove() {
        let verdict = |ledger: &InputLedger, items: &[&str]| {
            takeback_verdict(ledger, 1, &queue(items), &[], 80).map(|picked| picked.texts)
        };

        let mut absorbed = InputLedger::new(0);
        absorbed.record(Writer::Desktop, "wip ");
        sent(&mut absorbed, 1, "hello", &[]);
        assert_eq!(verdict(&absorbed, &["wip hello"]), Err(QUEUE_SHARED));

        let mut typed_after = InputLedger::new(0);
        sent(&mut typed_after, 1, "hello", &[]);
        typed_after.record(Writer::Desktop, "x");
        assert_eq!(verdict(&typed_after, &["hello"]), Err(QUEUE_SHARED));

        let mut other_device = InputLedger::new(0);
        sent(&mut other_device, 2, "theirs", &[]);
        sent(&mut other_device, 1, "mine", &[]);
        assert_eq!(
            verdict(&other_device, &["theirs", "mine"]),
            Err(QUEUE_SHARED)
        );

        let mut lagging = InputLedger::new(0);
        sent(&mut lagging, 1, "a", &[]);
        sent(&mut lagging, 1, "b", &[]);
        assert_eq!(verdict(&lagging, &["a"]), Err(QUEUE_UNKNOWN));
        assert_eq!(verdict(&lagging, &[]), Err(QUEUE_UNKNOWN));

        let mut photo = InputLedger::new(0);
        sent(&mut photo, 1, "look", &["p1.jpg"]);
        assert!(verdict(&photo, &["look"]).is_err());
        assert_eq!(
            takeback_verdict(&photo, 1, &queue(&["[Image #1] look"]), &[], 80).map(|_| ()),
            Err(QUEUE_PHOTO_MISSING)
        );

        let mut system = InputLedger::new(0);
        sent(&mut system, 1, "mine", &[]);
        for item in [
            "<task-notification>done</task-notification>",
            "<agent-message from=\"w\">hi</agent-message>",
            "<pasted_content id=\"1\">",
        ] {
            assert_eq!(verdict(&system, &[item, "mine"]), Err(QUEUE_SHARED));
        }

        let mut same_text = InputLedger::new(0);
        sent(&mut same_text, 1, "ok", &[]);
        sent(&mut same_text, 2, "ok", &[]);
        assert_eq!(verdict(&same_text, &["ok"]), Err(QUEUE_SHARED));

        let long = "x".repeat(4_000);
        let mut too_long = InputLedger::new(0);
        sent(&mut too_long, 1, &long, &[]);
        assert_eq!(
            takeback_verdict(&too_long, 1, &queue(&[&long]), &[], 20).map(|_| ()),
            Err(QUEUE_TOO_LONG)
        );
        assert!(takeback_verdict(&too_long, 1, &queue(&[&long]), &[], 200).is_ok());
    }

    #[test]
    fn a_clear_needs_this_devices_pull_by_its_id_and_nobody_writing_since() {
        let pulled = |device: usize, text: &str| {
            let mut ledger = InputLedger::new(0);
            ledger.record(Writer::Device(device), PULL_KEY);
            ledger.mark_pull(device, "p1".into(), vec![text.into()]);
            ledger
        };
        // "hello" is one row: 1 + 1 per message + 2.
        let mut untouched = pulled(1, "hello");
        // An xterm reply is nobody's input.
        untouched.record(Writer::Desktop, "[I");
        // A stale or missing id confirmed another pull, or none.
        assert_eq!(clear_verdict(&mut untouched, 1, "p0", 80), Err(BOX_CHANGED));
        assert_eq!(clear_verdict(&mut untouched, 1, "", 80), Err(BOX_CHANGED));
        assert_eq!(clear_verdict(&mut untouched, 1, "p1", 80), Ok(4));
        // The pull is used up: a second clear has nothing to clear.
        assert_eq!(clear_verdict(&mut untouched, 1, "p1", 80), Err(BOX_CHANGED));

        assert_eq!(
            clear_verdict(&mut InputLedger::new(0), 1, "p1", 80),
            Err(BOX_CHANGED)
        );
        assert_eq!(
            clear_verdict(&mut pulled(2, "hello"), 1, "p1", 80),
            Err(BOX_CHANGED)
        );

        for (writer, refusal) in [
            (Writer::Desktop, QUEUE_SHARED),
            (Writer::Device(2), QUEUE_SHARED),
            // This device sent again: the box is no longer what was pulled.
            (Writer::Device(1), BOX_CHANGED),
        ] {
            let mut ledger = pulled(1, "hello");
            ledger.record(writer, "x");
            assert_eq!(
                clear_verdict(&mut ledger, 1, "p1", 80),
                Err(refusal),
                "{writer:?}"
            );
            assert_eq!(clear_verdict(&mut ledger, 1, "p1", 80), Err(BOX_CHANGED));
        }

        // Rounds stay within the cap, whatever the width now.
        let long = "x".repeat(4_000);
        assert_eq!(
            clear_verdict(&mut pulled(1, &long), 1, "p1", 20),
            Ok(MAX_ROUNDS)
        );
    }

    #[test]
    fn the_pull_is_the_up_arrow_and_the_clear_empties_every_row() {
        assert_eq!(PULL_KEY, "\x1b[A");
        assert_eq!(clear_box_keys(1), "\x15");
        assert_eq!(clear_box_keys(3), "\x15\x7f\x15\x7f\x15");
        assert_eq!(clear_box_keys(0), clear_box_keys(1));
        assert_eq!(clear_box_keys(1_000).len(), 199 * 2 + 1);
    }
}
