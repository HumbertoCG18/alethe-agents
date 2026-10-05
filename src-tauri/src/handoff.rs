use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use tauri::AppHandle;

use crate::provider_common::normalize_cwd;

const MAX_SOURCE_LINE_BYTES: usize = 2 * 1024 * 1024;
const DRAFT_CHAR_LIMIT: usize = 48_000;
const MATERIALIZED_BYTE_LIMIT: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Provider {
    Claude,
    Codex,
}

impl Provider {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            _ => Err("handoff supports only claude and codex".to_string()),
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct HandoffEvent {
    pub role: &'static str,
    pub text: String,
    #[serde(rename = "questionSetId", skip_serializing_if = "Option::is_none")]
    pub question_set_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub questions: Option<Vec<RemoteQuestion>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    pub multi_select: bool,
    pub options: Vec<RemoteQuestionOption>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct RemoteQuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffDraft {
    source_provider: String,
    target_provider: String,
    source_session_id: String,
    cwd: String,
    title: String,
    content: String,
    included_event_count: usize,
    omitted_event_count: usize,
    redaction_count: usize,
    used_fallback: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffArtifact {
    handoff_id: String,
    context_dir: String,
    context_path: String,
}

/// Reads one line into `buf`, keeping at most `MAX_SOURCE_LINE_BYTES` of it. Returns the bytes
/// consumed (0 at EOF) and whether a newline ended the line, so a line still being written can be
/// told apart from a complete one.
pub(crate) fn read_capped_line(
    reader: &mut impl BufRead,
    buf: &mut Vec<u8>,
) -> std::io::Result<(usize, bool)> {
    buf.clear();
    let mut consumed = 0;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok((consumed, false));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let chunk_len = newline.unwrap_or(available.len());
        if buf.len() < MAX_SOURCE_LINE_BYTES {
            let take = chunk_len.min(MAX_SOURCE_LINE_BYTES - buf.len());
            buf.extend_from_slice(&available[..take]);
        }
        match newline {
            Some(index) => {
                reader.consume(index + 1);
                return Ok((consumed + index + 1, true));
            }
            None => {
                let len = available.len();
                reader.consume(len);
                consumed += len;
            }
        }
    }
}

fn clipped(value: &str, max_chars: usize) -> String {
    let value = value.trim();
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut result: String = value.chars().take(max_chars.saturating_sub(1)).collect();
    result.push('…');
    result
}

fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| {
                let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
                match kind {
                    "text" | "input_text" | "output_text" => block
                        .get("text")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    _ => None,
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn remote_questions(name: &str, input: &Value) -> Option<Vec<RemoteQuestion>> {
    if !name.eq_ignore_ascii_case("AskUserQuestion")
        && !name.eq_ignore_ascii_case("request_user_input")
    {
        return None;
    }
    let parsed;
    let input = if let Value::String(value) = input {
        parsed = serde_json::from_str::<Value>(value).ok()?;
        &parsed
    } else {
        input
    };
    let questions = input.get("questions")?.as_array()?;
    let result = questions
        .iter()
        .take(3)
        .enumerate()
        .filter_map(|(index, value)| {
            let question = clipped(value.get("question")?.as_str()?, 1_000);
            let options = value
                .get("options")?
                .as_array()?
                .iter()
                .take(8)
                .filter_map(|option| {
                    let label = clipped(option.get("label")?.as_str()?, 160);
                    (!label.is_empty()).then(|| RemoteQuestionOption {
                        label,
                        description: clipped(
                            option
                                .get("description")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                            500,
                        ),
                    })
                })
                .collect::<Vec<_>>();
            (!question.is_empty() && !options.is_empty()).then(|| RemoteQuestion {
                id: value
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| clipped(id, 80))
                    .unwrap_or_else(|| format!("question-{}", index + 1)),
                header: clipped(
                    value
                        .get("header")
                        .and_then(Value::as_str)
                        .unwrap_or("Question"),
                    80,
                ),
                question,
                multi_select: value
                    .get("multiSelect")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                options,
            })
        })
        .collect::<Vec<_>>();
    (!result.is_empty()).then_some(result)
}

fn question_text(questions: &[RemoteQuestion]) -> String {
    questions
        .iter()
        .map(|question| {
            let options = question
                .options
                .iter()
                .map(|option| option.label.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            format!("{}: {} ({options})", question.header, question.question)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The events one transcript record holds, as the handoff capsule and the session reader read them.
pub(crate) fn line_events(provider: Provider, value: &Value, events: &mut Vec<HandoffEvent>) {
    match provider {
        Provider::Claude => claude_line_events(value, events),
        Provider::Codex => codex_line_events(value, events),
    }
}

/// Every event of a transcript, read whole: the capsule needs its first user request too.
fn transcript_events(provider: Provider, path: &Path) -> Result<Vec<HandoffEvent>, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut buf = Vec::with_capacity(8 * 1024);
    let mut events = Vec::new();
    while read_capped_line(&mut reader, &mut buf)
        .map_err(|error| error.to_string())?
        .0
        > 0
    {
        if let Ok(value) = serde_json::from_slice::<Value>(&buf) {
            line_events(provider, &value, &mut events);
        }
    }
    Ok(events)
}

fn claude_line_events(value: &Value, events: &mut Vec<HandoffEvent>) {
    if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return;
    }
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    if kind != "user" && kind != "assistant" {
        return;
    }
    let content = value
        .get("message")
        .and_then(|message| message.get("content"))
        .unwrap_or(&Value::Null);
    let text = content_text(content);
    if !text.trim().is_empty() {
        events.push(HandoffEvent {
            role: if kind == "user" { "user" } else { "assistant" },
            text: clipped(&text, if kind == "user" { 8_000 } else { 5_000 }),
            question_set_id: None,
            questions: None,
        });
    }
    let Value::Array(blocks) = content else {
        return;
    };
    for block in blocks {
        match block.get("type").and_then(Value::as_str).unwrap_or("") {
            "tool_use" => {
                let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                let input = block.get("input").cloned().unwrap_or(Value::Null);
                let questions = remote_questions(name, &input);
                let question_set_id = questions.as_ref().map(|_| {
                    clipped(
                        block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("claude-question"),
                        160,
                    )
                });
                events.push(HandoffEvent {
                    role: if questions.is_some() {
                        "question"
                    } else {
                        "tool"
                    },
                    text: questions
                        .as_deref()
                        .map(question_text)
                        .unwrap_or_else(|| clipped(&format!("{name}: {input}"), 1_200)),
                    question_set_id,
                    questions,
                });
            }
            "tool_result" => {
                let output = block.get("content").map(content_text).unwrap_or_default();
                if !output.trim().is_empty() {
                    events.push(HandoffEvent {
                        role: "tool-result",
                        text: clipped(&output, 800),
                        question_set_id: None,
                        questions: None,
                    });
                }
            }
            _ => {}
        }
    }
}

fn codex_line_events(value: &Value, events: &mut Vec<HandoffEvent>) {
    if value.get("type").and_then(Value::as_str) != Some("response_item") {
        return;
    }
    let Some(payload) = value.get("payload") else {
        return;
    };
    match payload.get("type").and_then(Value::as_str).unwrap_or("") {
        "message" => {
            let role = payload.get("role").and_then(Value::as_str).unwrap_or("");
            if role != "user" && role != "assistant" {
                return;
            }
            let text = payload.get("content").map(content_text).unwrap_or_default();
            if !text.trim().is_empty() {
                events.push(HandoffEvent {
                    role: if role == "user" { "user" } else { "assistant" },
                    text: clipped(&text, if role == "user" { 8_000 } else { 5_000 }),
                    question_set_id: None,
                    questions: None,
                });
            }
        }
        "custom_tool_call" | "function_call" => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let input = payload
                .get("input")
                .or_else(|| payload.get("arguments"))
                .cloned()
                .unwrap_or(Value::Null);
            let questions = remote_questions(name, &input);
            let question_set_id = questions.as_ref().map(|_| {
                clipped(
                    payload
                        .get("call_id")
                        .or_else(|| payload.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or("codex-question"),
                    160,
                )
            });
            events.push(HandoffEvent {
                role: if questions.is_some() {
                    "question"
                } else {
                    "tool"
                },
                text: questions
                    .as_deref()
                    .map(question_text)
                    .unwrap_or_else(|| clipped(&format!("{name}: {input}"), 1_200)),
                question_set_id,
                questions,
            });
        }
        "custom_tool_call_output" | "function_call_output" => {
            let output = payload.get("output").map(content_text).unwrap_or_default();
            if !output.trim().is_empty() {
                events.push(HandoffEvent {
                    role: "tool-result",
                    text: clipped(&output, 800),
                    question_set_id: None,
                    questions: None,
                });
            }
        }
        _ => {}
    }
}

fn codex_session_meta(path: &Path) -> Option<(String, String)> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut first = String::new();
    reader.read_line(&mut first).ok()?;
    let value = serde_json::from_str::<Value>(&first).ok()?;
    let payload = value.get("payload")?;
    Some((
        payload.get("id")?.as_str()?.to_string(),
        payload.get("cwd")?.as_str()?.to_string(),
    ))
}

pub(crate) fn resolve_source_file(
    provider: Provider,
    cwd: &str,
    requested_id: Option<&str>,
) -> Result<(String, PathBuf, bool), String> {
    let normalized = normalize_cwd(cwd);
    if normalized.is_empty() || !Path::new(cwd).is_dir() {
        return Err("handoff cwd does not exist".to_string());
    }
    let mut candidates: Vec<(String, PathBuf, std::time::SystemTime)> = Vec::new();
    match provider {
        Provider::Claude => {
            for dir in crate::claude_sessions::project_dirs_for_cwd(cwd)? {
                let Ok(entries) = fs::read_dir(dir) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                        continue;
                    }
                    let Some(id) = path
                        .file_stem()
                        .map(|value| value.to_string_lossy().to_string())
                    else {
                        continue;
                    };
                    let modified = entry
                        .metadata()
                        .and_then(|metadata| metadata.modified())
                        .unwrap_or(std::time::UNIX_EPOCH);
                    candidates.push((id, path, modified));
                }
            }
        }
        Provider::Codex => {
            let Some(root) = crate::codex_sessions::codex_sessions_dir() else {
                return Err("Codex sessions directory is unavailable".to_string());
            };
            let mut files = Vec::new();
            crate::codex_sessions::collect_jsonl_files(&root, &mut files);
            for path in files {
                let Some((id, session_cwd)) = codex_session_meta(&path) else {
                    continue;
                };
                if normalize_cwd(&session_cwd) != normalized {
                    continue;
                }
                let modified = fs::metadata(&path)
                    .and_then(|metadata| metadata.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                candidates.push((id, path, modified));
            }
        }
    }
    if let Some(requested) = requested_id.filter(|value| !value.trim().is_empty()) {
        return candidates
            .into_iter()
            .find(|(id, _, _)| id == requested)
            .map(|(id, path, _)| (id, path, false))
            .ok_or_else(|| {
                "session not found for this provider and working directory".to_string()
            });
    }
    candidates.sort_by(|left, right| right.2.cmp(&left.2));
    candidates
        .into_iter()
        .next()
        .map(|(id, path, _)| (id, path, true))
        .ok_or_else(|| "no session found for this provider and working directory".to_string())
}

fn run_git(cwd: &str, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn workspace_context(cwd: &str) -> String {
    let Some(root) = run_git(cwd, &["rev-parse", "--show-toplevel"]) else {
        return "- Git repository: not detected\n".to_string();
    };
    let branch = run_git(cwd, &["branch", "--show-current"]).unwrap_or_else(|| "detached".into());
    let head = run_git(cwd, &["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let status = run_git(cwd, &["status", "--short"]).unwrap_or_else(|| "clean".into());
    let stat = run_git(cwd, &["diff", "--stat", "HEAD"]).unwrap_or_else(|| "none".into());
    format!("- Repository root: {root}\n- Branch: {branch}\n- HEAD: {head}\n- Working tree:\n```text\n{}\n```\n- Diff stat:\n```text\n{}\n```\n", clipped(&status, 5_000), clipped(&stat, 5_000))
}

fn redaction_patterns() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| [
        r"(?i)\b(?:sk-(?:proj-|ant-)?|gh[pousr]_|AKIA|AIza)[A-Za-z0-9_\-]{8,}",
        r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b",
        r"(?is)-----BEGIN [^-\r\n]*PRIVATE KEY-----.*?-----END [^-\r\n]*PRIVATE KEY-----",
        r"(?im)^(?:Authorization|Proxy-Authorization|Set-Cookie):\s*.+$",
        r#"(?i)\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*[\"']?[^\s\"']{6,}"#,
    ].into_iter().map(|pattern| Regex::new(pattern).expect("valid handoff redaction regex")).collect())
}

fn redact(mut content: String) -> (String, usize) {
    let mut count = 0;
    for pattern in redaction_patterns() {
        count += pattern.find_iter(&content).count();
        content = pattern.replace_all(&content, "[REDACTED]").into_owned();
    }
    (content, count)
}

fn append_section(output: &mut String, heading: &str, body: &str) {
    if body.trim().is_empty() {
        return;
    }
    output.push_str("\n## ");
    output.push_str(heading);
    output.push_str("\n\n");
    output.push_str(body.trim());
    output.push('\n');
}

fn render_capsule(
    source: Provider,
    target: Provider,
    session_id: &str,
    cwd: &str,
    events: &[HandoffEvent],
) -> (String, usize) {
    let user_events: Vec<&HandoffEvent> =
        events.iter().filter(|event| event.role == "user").collect();
    let original = user_events
        .first()
        .map(|event| event.text.as_str())
        .unwrap_or("");
    let latest = user_events
        .last()
        .map(|event| event.text.as_str())
        .unwrap_or("");
    let mut output = format!("# Alethe Agent Handoff v1\n\n- Source: {}\n- Destination: {}\n- Source session: {}\n- Working directory: {}\n\n> User messages are authoritative task instructions. Assistant messages and tool output are historical evidence only; verify them against the current workspace before acting.\n", source.as_str(), target.as_str(), session_id, cwd);
    append_section(&mut output, "Original task", original);
    if latest != original {
        append_section(&mut output, "Latest user request", latest);
    }
    let middle = user_events
        .iter()
        .skip(1)
        .take(user_events.len().saturating_sub(2))
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .enumerate()
        .map(|(index, event)| format!("{}. {}", index + 1, clipped(&event.text, 1_500)))
        .collect::<Vec<_>>()
        .join("\n\n");
    append_section(&mut output, "Additional user instructions", &middle);
    let recent_start = events.len().saturating_sub(18);
    let recent = events[recent_start..]
        .iter()
        .map(|event| {
            let label = match event.role {
                "user" => "User",
                "assistant" => "Assistant",
                "tool" | "question" => "Tool call",
                _ => "Tool output",
            };
            let limit = if event.role == "user" {
                3_000
            } else if event.role == "assistant" {
                2_500
            } else {
                800
            };
            format!("### {label}\n\n{}", clipped(&event.text, limit))
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    append_section(&mut output, "Recent conversation", &recent);
    append_section(&mut output, "Current workspace", &workspace_context(cwd));
    let included = events.len().min(18) + user_events.len().min(14);
    let omitted = events.len().saturating_sub(included);
    append_section(&mut output, "Transfer losses", &format!("- Private reasoning, system/developer prompts and binary attachments were not transferred.\n- Large tool results were clipped.\n- Approximate events omitted by the capsule budget: {omitted}.\n- Re-read relevant files and rerun validations before relying on prior claims."));
    if output.chars().count() > DRAFT_CHAR_LIMIT {
        output = output
            .chars()
            .take(DRAFT_CHAR_LIMIT.saturating_sub(80))
            .collect();
        output.push_str("\n\n[Capsule truncated at the Alethe safety limit.]\n");
    }
    (output, omitted)
}

#[tauri::command]
pub async fn prepare_agent_handoff(
    source_provider: String,
    target_provider: String,
    source_session_id: Option<String>,
    cwd: String,
) -> Result<HandoffDraft, String> {
    tokio::task::spawn_blocking(move || {
        let source = Provider::parse(&source_provider)?;
        let target = Provider::parse(&target_provider)?;
        if source == target {
            return Err("handoff destination must be a different provider".to_string());
        }
        let (resolved_id, path, used_fallback) =
            resolve_source_file(source, &cwd, source_session_id.as_deref())?;
        let events = transcript_events(source, &path)?;
        if !events.iter().any(|event| event.role == "user") {
            return Err("the selected session has no transferable user messages".to_string());
        }
        let title = events
            .iter()
            .find(|event| event.role == "user")
            .map(|event| clipped(&event.text.replace(['\r', '\n'], " "), 80))
            .unwrap_or_else(|| format!("{} handoff", source.as_str()));
        let (rendered, omitted_event_count) =
            render_capsule(source, target, &resolved_id, &cwd, &events);
        let (content, redaction_count) = redact(rendered);
        Ok(HandoffDraft {
            source_provider: source.as_str().to_string(),
            target_provider: target.as_str().to_string(),
            source_session_id: resolved_id,
            cwd,
            title,
            content,
            included_event_count: events.len().saturating_sub(omitted_event_count),
            omitted_event_count,
            redaction_count,
            used_fallback,
        })
    })
    .await
    .map_err(|error| format!("prepare_agent_handoff task failed: {error}"))?
}

fn validate_handoff_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("invalid handoff id".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn materialize_agent_handoff(
    app: AppHandle,
    content: String,
) -> Result<HandoffArtifact, String> {
    if content.trim().is_empty() {
        return Err("handoff content is empty".to_string());
    }
    if content.len() > MATERIALIZED_BYTE_LIMIT {
        return Err(format!(
            "handoff content exceeds {MATERIALIZED_BYTE_LIMIT} bytes"
        ));
    }
    let root = crate::paths::profile_data_dir(&app)?.join("handoffs");
    tokio::task::spawn_blocking(move || {
        let handoff_id = nanoid::nanoid!(16);
        let context_dir = root.join(&handoff_id);
        fs::create_dir_all(&context_dir).map_err(|error| error.to_string())?;
        let context_path = context_dir.join("context.md");
        let temporary = context_dir.join("context.md.tmp");
        fs::write(&temporary, content).map_err(|error| error.to_string())?;
        fs::rename(&temporary, &context_path).map_err(|error| error.to_string())?;
        Ok(HandoffArtifact {
            handoff_id,
            context_dir: context_dir.to_string_lossy().to_string(),
            context_path: context_path.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(|error| format!("materialize_agent_handoff task failed: {error}"))?
}

#[tauri::command]
pub async fn complete_agent_handoff(app: AppHandle, handoff_id: String) -> Result<(), String> {
    validate_handoff_id(&handoff_id)?;
    let root = crate::paths::profile_data_dir(&app)?.join("handoffs");
    let target = root.join(&handoff_id);
    tokio::task::spawn_blocking(move || {
        if !target.exists() {
            return Ok(());
        }
        let canonical_root = fs::canonicalize(&root).map_err(|error| error.to_string())?;
        let canonical_target = fs::canonicalize(&target).map_err(|error| error.to_string())?;
        if canonical_target.parent() != Some(canonical_root.as_path()) || !canonical_target.is_dir()
        {
            return Err("handoff cleanup target is outside the handoff directory".to_string());
        }
        fs::remove_dir_all(canonical_target).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("complete_agent_handoff task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn redacts_common_secrets() {
        let input = "Authorization: Bearer abcdefgh\nOPENAI_API_KEY=sk-proj-abcdefghijklmnop\n";
        let (output, count) = redact(input.to_string());
        assert!(count >= 2);
        assert!(!output.contains("abcdefghijklmnop"));
        assert!(output.contains("[REDACTED]"));
    }

    #[test]
    fn capsule_prioritizes_user_requests() {
        let events = vec![
            HandoffEvent {
                role: "user",
                text: "Build the feature".into(),
                question_set_id: None,
                questions: None,
            },
            HandoffEvent {
                role: "assistant",
                text: "Implemented parser".into(),
                question_set_id: None,
                questions: None,
            },
            HandoffEvent {
                role: "tool",
                text: "cargo test".into(),
                question_set_id: None,
                questions: None,
            },
            HandoffEvent {
                role: "user",
                text: "Keep the old terminal open".into(),
                question_set_id: None,
                questions: None,
            },
        ];
        let (capsule, _) = render_capsule(
            Provider::Claude,
            Provider::Codex,
            "session-1",
            "C:\\repo",
            &events,
        );
        assert!(capsule.contains("Build the feature"));
        assert!(capsule.contains("Keep the old terminal open"));
        assert!(capsule.contains("Private reasoning"));
    }

    #[test]
    fn rejects_unsafe_cleanup_ids() {
        assert!(validate_handoff_id("safe_123-id").is_ok());
        assert!(validate_handoff_id("../outside").is_err());
        assert!(validate_handoff_id("").is_err());
    }

    #[test]
    fn parses_codex_and_claude_questions() {
        let codex = remote_questions(
            "request_user_input",
            &Value::String(
                r#"{"questions":[{"id":"scope","header":"Scope","question":"Which scope?","options":[{"label":"Focused","description":"Only Codex and Claude"}]}]}"#.into(),
            ),
        )
        .expect("Codex question");
        assert_eq!(codex[0].id, "scope");
        assert!(!codex[0].multi_select);

        let claude = remote_questions(
            "AskUserQuestion",
            &serde_json::json!({
                "questions": [{
                    "header": "Files",
                    "question": "Which files?",
                    "multiSelect": true,
                    "options": [
                        { "label": "Source", "description": "Application code" },
                        { "label": "Tests", "description": "Test code" }
                    ]
                }]
            }),
        )
        .expect("Claude question");
        assert!(claude[0].multi_select);
        assert_eq!(claude[0].options.len(), 2);
    }

    #[test]
    fn preserves_agent_call_ids_for_remote_questions() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let root = std::env::temp_dir();
        let codex_path = root.join(format!("alethe-codex-question-{suffix}.jsonl"));
        let claude_path = root.join(format!("alethe-claude-question-{suffix}.jsonl"));
        fs::write(
            &codex_path,
            r#"{"type":"response_item","payload":{"type":"function_call","name":"request_user_input","call_id":"call-codex-42","arguments":"{\"questions\":[{\"id\":\"scope\",\"header\":\"Scope\",\"question\":\"Which scope?\",\"options\":[{\"label\":\"Focused\",\"description\":\"Only this area\"}]}]}"}}"#,
        )
        .expect("write Codex fixture");
        fs::write(
            &claude_path,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu-claude-42","name":"AskUserQuestion","input":{"questions":[{"header":"Scope","question":"Which scope?","multiSelect":false,"options":[{"label":"Focused","description":"Only this area"}]}]}}]}}"#,
        )
        .expect("write Claude fixture");

        let codex = transcript_events(Provider::Codex, &codex_path).expect("parse Codex fixture");
        let claude =
            transcript_events(Provider::Claude, &claude_path).expect("parse Claude fixture");
        fs::remove_file(codex_path).expect("remove Codex fixture");
        fs::remove_file(claude_path).expect("remove Claude fixture");

        assert_eq!(codex[0].question_set_id.as_deref(), Some("call-codex-42"));
        assert_eq!(
            claude[0].question_set_id.as_deref(),
            Some("toolu-claude-42")
        );
    }
}
