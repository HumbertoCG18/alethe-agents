use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use tauri::{AppHandle, Emitter, State};

/// A short-lived metadata connection: initialize, list models, then reap the process tree.
/// No thread, turn, prompt or inference request is sent.
pub(crate) async fn discover_models() -> Result<Vec<crate::cli_resolver::ModelOption>, String> {
    let launcher = crate::cli_resolver::find_windows_cli_launcher("codex")
        .ok_or("Codex CLI is not installed")?;
    let mut command = tokio::process::Command::new(launcher);
    command
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
        command.env("Path", crate::cli_resolver::rebuilt_path());
    }
    #[cfg(unix)]
    command.process_group(0);
    collect_models(command, std::time::Duration::from_secs(10)).await
}

async fn collect_models(
    mut command: tokio::process::Command,
    timeout: std::time::Duration,
) -> Result<Vec<crate::cli_resolver::ModelOption>, String> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start Codex metadata probe: {e}"))?;
    let pid = child.id();
    let result = tokio::time::timeout(timeout, async {
        let mut input = child.stdin.take().ok_or("Codex stdin unavailable")?;
        let mut output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or("Codex stdout unavailable")?
                .take(2 * 1024 * 1024),
        );
        async fn send(input: &mut tokio::process::ChildStdin, value: Value) -> Result<(), String> {
            input
                .write_all(format!("{value}\n").as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            input.flush().await.map_err(|e| e.to_string())
        }
        async fn reply(
            output: &mut (impl AsyncBufReadExt + Unpin),
            id: u64,
        ) -> Result<Value, String> {
            loop {
                let mut line = String::new();
                if output
                    .read_line(&mut line)
                    .await
                    .map_err(|e| e.to_string())?
                    == 0
                {
                    return Err("Codex metadata connection closed".into());
                }
                let value: Value =
                    serde_json::from_str(&line).map_err(|_| "Invalid Codex metadata response")?;
                if value.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                if value.get("error").is_some() {
                    return Err("Codex model catalog is unavailable".into());
                }
                return value
                    .get("result")
                    .cloned()
                    .ok_or_else(|| "Missing Codex result".into());
            }
        }
        send(
            &mut input,
            json!({"id": 1, "method": "initialize", "params": {
                "clientInfo": {"name": "alethe-model-catalog", "version": env!("CARGO_PKG_VERSION")}
            }}),
        )
        .await?;
        reply(&mut output, 1).await?;
        send(&mut input, json!({"method": "initialized"})).await?;
        let mut cursor = Value::Null;
        let mut models = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for id in 2..=51 {
            send(
                &mut input,
                json!({"id": id, "method": "model/list", "params": {
                    "limit": 100, "includeHidden": false, "cursor": cursor
                }}),
            )
            .await?;
            let result = reply(&mut output, id).await?;
            let data = result
                .get("data")
                .and_then(Value::as_array)
                .ok_or("Missing Codex model list")?;
            for model in data {
                if model.get("hidden").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                let Some(name) = model
                    .get("model")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                else {
                    continue;
                };
                if models
                    .iter()
                    .any(|m: &crate::cli_resolver::ModelOption| m.id == name)
                {
                    continue;
                }
                models.push(crate::cli_resolver::ModelOption {
                    id: name.to_string(),
                    label: model
                        .get("displayName")
                        .and_then(Value::as_str)
                        .unwrap_or(name)
                        .to_string(),
                });
            }
            cursor = result.get("nextCursor").cloned().unwrap_or(Value::Null);
            if cursor.is_null() {
                return Ok(models);
            }
            if !seen.insert(cursor.to_string()) {
                return Err("Repeated Codex catalog cursor".into());
            }
        }
        Err("Codex model catalog exceeded page limit".into())
    })
    .await
    .unwrap_or_else(|_| Err("Codex model catalog timed out".into()));
    if child.try_wait().ok().flatten().is_none() {
        if let Some(pid) = pid {
            tokio::task::spawn_blocking(move || crate::pty::kill_process_tree(pid))
                .await
                .ok();
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result
}

#[cfg(test)]
mod catalog_tests {
    use super::*;

    fn fake_server(script: &str) -> tokio::process::Command {
        let binary = which::which("python3")
            .or_else(|_| which::which("python"))
            .expect("Python for metadata protocol fixture");
        let mut command = tokio::process::Command::new(binary);
        command
            .args(["-u", "-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        #[cfg(unix)]
        command.process_group(0);
        command
    }

    #[tokio::test]
    async fn catalog_paginates_without_starting_a_turn_and_uses_launchable_model_ids() {
        let script = r#"
import json, sys
for line in sys.stdin:
    r = json.loads(line)
    if r['method'] == 'initialized': continue
    if r['method'] == 'initialize': result = {}
    elif r['method'] == 'model/list':
        if r['params']['cursor'] is None:
            result = {'data': [{'id': 'opaque', 'model': 'current-model', 'displayName': 'Current model'}, {'model': 'hidden-model', 'hidden': True}], 'nextCursor': 'page2'}
        else:
            assert r['params']['cursor'] == 'page2'
            result = {'data': [{'model': 'second-model'}], 'nextCursor': None}
    else: raise AssertionError('Unexpected inference request')
    print(json.dumps({'id': r['id'], 'result': result}), flush=True)
"#;
        let models = collect_models(fake_server(script), std::time::Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["current-model", "second-model"]
        );
        assert_eq!(models[0].label, "Current model");
    }

    #[tokio::test]
    async fn catalog_reports_errors_and_bounds_a_silent_server() {
        let failure = "import sys,json; r=json.loads(sys.stdin.readline()); print(json.dumps({'id':r['id'],'error':{'code':-1}}),flush=True)";
        assert!(
            collect_models(fake_server(failure), std::time::Duration::from_secs(5))
                .await
                .unwrap_err()
                .contains("unavailable")
        );
        let started = std::time::Instant::now();
        assert!(collect_models(
            fake_server("import time; time.sleep(30)"),
            std::time::Duration::from_millis(100)
        )
        .await
        .unwrap_err()
        .contains("timed out"));
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[tokio::test]
    #[ignore = "Requires the locally installed Codex CLI; sends metadata requests only"]
    async fn installed_codex_returns_model_catalog() {
        let models = discover_models().await.unwrap();
        assert!(!models.is_empty());
        println!("Codex metadata catalog: {} models", models.len());
    }
}

use crate::cli_resolver;

pub struct CodexAppServerState {
    sessions: Mutex<HashMap<String, CodexAppServerProcess>>,
}

impl Default for CodexAppServerState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

struct CodexAppServerProcess {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
}

fn event_name(id: &str) -> String {
    format!("agent-sandbox-app-server://event/{id}")
}

fn send_value(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) -> Result<(), String> {
    let mut stdin = stdin.lock().map_err(|_| "app-server stdin lock poisoned")?;
    serde_json::to_writer(&mut *stdin, value).map_err(|error| error.to_string())?;
    stdin.write_all(b"\n").map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

fn stop_process(
    sessions: &Mutex<HashMap<String, CodexAppServerProcess>>,
    id: &str,
) -> Result<(), String> {
    let session = sessions
        .lock()
        .map_err(|_| "app-server state lock poisoned")?
        .remove(id);
    if let Some(session) = session {
        let mut child = session
            .child
            .lock()
            .map_err(|_| "app-server child lock poisoned")?;
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn codex_app_server_start(
    app: AppHandle,
    state: State<'_, CodexAppServerState>,
    id: String,
    cwd: String,
) -> Result<(), String> {
    stop_process(&state.sessions, &id)?;

    let launcher = cli_resolver::find_windows_cli_launcher("codex")
        .ok_or_else(|| "codex_not_found".to_string())?;
    let mut command = std::process::Command::new(&launcher);
    command
        .arg("app-server")
        .arg("--stdio")
        .current_dir(PathBuf::from(&cwd))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    command.env("Path", cli_resolver::rebuilt_path());

    crate::git_control::hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("codex app-server spawn failed: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "codex app-server stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "codex app-server stdout unavailable".to_string())?;
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    let stdin = Arc::new(Mutex::new(stdin));

    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "app-server state lock poisoned")?;
        sessions.insert(
            id.clone(),
            CodexAppServerProcess {
                child: Arc::clone(&child),
                stdin: Arc::clone(&stdin),
            },
        );
    }

    let event = event_name(&id);
    let reader_app = app.clone();
    let reader_event = event.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) if !line.trim().is_empty() => {
                    let payload = serde_json::from_str::<Value>(&line)
                        .unwrap_or_else(|_| json!({ "type": "raw", "data": line }));
                    let _ = reader_app.emit(&reader_event, payload);
                }
                Ok(_) => {}
                Err(error) => {
                    let _ = reader_app.emit(
                        &reader_event,
                        json!({ "type": "transport_error", "message": error.to_string() }),
                    );
                    break;
                }
            }
        }
        let _ = reader_app.emit(&reader_event, json!({ "type": "transport_closed" }));
    });

    if let Some(stderr) = stderr {
        let stderr_app = app.clone();
        let stderr_event = event.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    let _ = stderr_app
                        .emit(&stderr_event, json!({ "type": "stderr", "message": line }));
                }
            }
        });
    }

    send_value(
        &stdin,
        &json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "alethe-agent-sandbox",
                    "title": "Alethe Agent Sandbox",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
    )?;
    send_value(&stdin, &json!({ "method": "initialized" }))
}

#[tauri::command]
pub fn codex_app_server_send(
    state: State<'_, CodexAppServerState>,
    id: String,
    request: Value,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "app-server state lock poisoned")?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| "codex app-server session not found".to_string())?;
    send_value(&session.stdin, &request)
}

#[tauri::command]
pub fn codex_app_server_stop(
    state: State<'_, CodexAppServerState>,
    id: String,
) -> Result<(), String> {
    stop_process(&state.sessions, &id)
}
