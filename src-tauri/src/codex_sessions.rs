use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use crate::provider_common::{file_modified_ms, normalize_cwd, provider_home_dir};

#[derive(Serialize)]
pub struct CodexSessionSnapshot {
    pub id: String,
    pub cwd: String,
    pub modified_at_ms: u128,
    pub size_bytes: u64,
}

pub(crate) fn codex_sessions_dir() -> Option<PathBuf> {
    provider_home_dir(&[".codex", "sessions"])
}

pub(crate) fn collect_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, out);
        } else if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn parse_codex_session(path: &Path, metadata: &fs::Metadata) -> Option<CodexSessionSnapshot> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut first_line = String::new();
    reader.read_line(&mut first_line).ok()?;
    if first_line.trim().is_empty() {
        return None;
    }

    let value = serde_json::from_str::<serde_json::Value>(&first_line).ok()?;
    if value.get("type").and_then(|v| v.as_str()) != Some("session_meta") {
        return None;
    }
    let payload = value.get("payload")?;
    let id = payload.get("id").and_then(|v| v.as_str())?.to_string();
    let cwd = payload.get("cwd").and_then(|v| v.as_str())?.to_string();

    Some(CodexSessionSnapshot {
        id,
        cwd,
        modified_at_ms: file_modified_ms(metadata),
        size_bytes: metadata.len(),
    })
}

pub(crate) fn session_meta_id(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut first_line = String::new();
    reader.read_line(&mut first_line).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&first_line).ok()?;
    if value.get("type").and_then(|v| v.as_str()) != Some("session_meta") {
        return None;
    }
    value
        .get("payload")?
        .get("id")?
        .as_str()
        .map(|s| s.to_string())
}

#[tauri::command]
pub async fn snapshot_codex_sessions(cwd: String) -> Result<Vec<CodexSessionSnapshot>, String> {
    tokio::task::spawn_blocking(move || snapshot_codex_sessions_inner(cwd))
        .await
        .map_err(|error| format!("snapshot_codex_sessions: falha na task bloqueante: {error}"))?
}

fn snapshot_codex_sessions_inner(cwd: String) -> Result<Vec<CodexSessionSnapshot>, String> {
    let target_cwd = normalize_cwd(&cwd);
    if target_cwd.is_empty() {
        return Ok(Vec::new());
    }

    let Some(root) = codex_sessions_dir() else {
        return Err("USERPROFILE/HOME nao definido".to_string());
    };
    if !root.is_dir() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    collect_jsonl_files(&root, &mut files);

    let mut sessions = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    for path in files {
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let Some(session) = parse_codex_session(&path, &metadata) else {
            continue;
        };
        if normalize_cwd(&session.cwd) != target_cwd || !seen_ids.insert(session.id.clone()) {
            continue;
        }
        sessions.push(session);
    }

    sessions.sort_by(|a, b| b.modified_at_ms.cmp(&a.modified_at_ms));
    Ok(sessions)
}

/// A Codex session's title: Codex has no equivalent of Claude's generated `ai-title`, so it is the
/// first genuine user turn. The file also carries the framework's own injected messages
/// (permissions/collaboration-mode/environment-context blocks), which are also `role: "user"` but
/// wrapped in `<tag>` prose, so those are skipped in favor of the first line that isn't.
pub(crate) fn codex_user_prompt(value: &serde_json::Value) -> Option<String> {
    if value.get("type").and_then(|v| v.as_str()) != Some("response_item") {
        return None;
    }
    let payload = value.get("payload")?;
    if payload.get("type").and_then(|v| v.as_str()) != Some("message")
        || payload.get("role").and_then(|v| v.as_str()) != Some("user")
    {
        return None;
    }
    payload.get("content")?.as_array()?.iter().find_map(|block| {
        let text = block.get("text").and_then(|v| v.as_str())?.trim();
        if text.is_empty() || text.starts_with('<') {
            None
        } else {
            Some(text.to_string())
        }
    })
}

#[cfg(test)]
mod title_tests {
    use super::codex_user_prompt;

    fn codex_first_user_text(line: &str) -> Option<String> {
        codex_user_prompt(&serde_json::from_str(line).ok()?)
    }

    #[test]
    fn skips_injected_environment_context_and_finds_the_real_prompt() {
        let env_context = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n  <cwd>C:\\Users\\kauam</cwd>\n</environment_context>"}]}}"#;
        let real_prompt = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"oi"}]}}"#;
        assert_eq!(codex_first_user_text(env_context), None);
        assert_eq!(codex_first_user_text(real_prompt).as_deref(), Some("oi"));
    }

    #[test]
    fn ignores_developer_and_assistant_records() {
        let developer = r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"some instructions"}]}}"#;
        let assistant = r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi there"}]}}"#;
        let other_record = r#"{"type":"event_msg","payload":{"type":"task_started"}}"#;
        assert_eq!(codex_first_user_text(developer), None);
        assert_eq!(codex_first_user_text(assistant), None);
        assert_eq!(codex_first_user_text(other_record), None);
    }
}
