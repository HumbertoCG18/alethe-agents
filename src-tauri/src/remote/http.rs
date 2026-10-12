//! The LAN HTTP listener: pairing, the `/api/*` surface, and the static
//! remote-client asset bundle.

use serde::Deserialize;
use serde_json::{json, Value};

use super::state::PinOutcome;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::pty::{pty_input, write_counted, InputLedger, PtySessions, RemoteSend, Writer};

use super::appearance::{projects_document, remote_appearance, selected_brand_icon};
use super::pty_bridge::{read_pty_size, read_scrollback, write_remote};
use super::takeback::{
    claude_queue, clear_box_keys, clear_verdict, takeback_verdict, ClaudeLog, BOX_CHANGED,
    BOX_PENDING, PULL_KEY, QUEUE_PHOTO_MISSING, QUEUE_SHARED, QUEUE_TOO_LONG, QUEUE_UNKNOWN,
};
use super::util::{query_value, sanitize_remote_message};
use super::workspace::{pty_agent, pty_is_shared, shared_tab, workspace_snapshot};
use super::{
    ConnectionGuard, RemoteHub, IDLE_DISABLE_SECS, MAX_ATTACHMENT, MAX_BODY, MAX_MESSAGE,
    MAX_REQUEST, MAX_SCROLLBACK, MAX_STATIC_ASSET, SOCKET_TIMEOUT,
};

const MAX_TRANSCRIPT_EVENTS: usize = 160;
const CACHE_NO_STORE: &str = "no-store";
const CACHE_IMMUTABLE: &str = "public, max-age=31536000, immutable";

pub(crate) fn run_http(
    listener: TcpListener,
    app: AppHandle,
    hub: Arc<RemoteHub>,
    sessions: PtySessions,
    generation: u64,
) {
    while hub.is_active(generation) {
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if hub.is_idle(IDLE_DISABLE_SECS) {
                    if super::stop_generation(&hub, generation) {
                        eprintln!(
                            "[remote] auto-disabled after {}s with no paired device",
                            IDLE_DISABLE_SECS
                        );
                        let _ = app.emit("remote://auto-disabled", ());
                    }
                    break;
                }
                thread::sleep(Duration::from_millis(50));
                continue;
            }
            Err(_) => break,
        };
        let Some(guard) = ConnectionGuard::acquire(&hub) else {
            continue;
        };
        let mut stream = stream;
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(SOCKET_TIMEOUT));
        let _ = stream.set_write_timeout(Some(SOCKET_TIMEOUT));
        let hub = Arc::clone(&hub);
        let sessions = Arc::clone(&sessions);
        let app = app.clone();
        thread::spawn(move || {
            let _guard = guard;
            if let Err(error) = handle_http(&mut stream, &app, &hub, &sessions, generation) {
                eprintln!("[remote] HTTP request failed: {error}");
                let _ = respond(
                    &mut stream,
                    400,
                    "application/json",
                    r#"{"error":"Bad request"}"#,
                );
            }
        });
    }
    // Reached with the generation still live only when the listener itself
    // died; never leave remote control half up with one listener gone.
    if super::stop_generation(&hub, generation) {
        eprintln!("[remote] LAN HTTP listener stopped unexpectedly");
        let _ = app.emit("remote://start-failed", ());
    }
}

fn handle_http(
    stream: &mut TcpStream,
    app: &AppHandle,
    hub: &Arc<RemoteHub>,
    sessions: &PtySessions,
    generation: u64,
) -> Result<(), String> {
    let address = stream
        .peer_addr()
        .map(|address| address.to_string())
        .unwrap_or_else(|_| "Unknown device".into());
    if hub.auth_blocked(&address) {
        return respond(
            stream,
            429,
            "application/json",
            r#"{"error":"Too many failed attempts"}"#,
        );
    }
    if !hub.is_active(generation) {
        return respond(
            stream,
            403,
            "application/json",
            r#"{"error":"Remote control is disabled"}"#,
        );
    }
    let (head, body) = read_request(stream, |head| {
        hub.session_id_for(&bearer_token(head)).is_some()
    })?;
    let first = head.split("\r\n").next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    let path = target.split('?').next().unwrap_or("/");

    if path == "/api/pair" && method == "POST" {
        let payload: PairRequest = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
        let name: String = payload
            .device_name
            .unwrap_or_else(|| "Remote device".into())
            .chars()
            .take(48)
            .collect();
        return match hub.pair(&payload.token, name, address.clone()) {
            Ok((id, session_token)) => {
                hub.clear_auth_failures(&address);
                eprintln!("[remote] device {id} paired from {address}");
                let info = hub.info();
                respond(
                    stream,
                    200,
                    "application/json",
                    &json!({
                        "sessionToken": session_token,
                        "deviceId": id,
                        "wsUrl": info.ws_url,
                        "readOnly": info.read_only,
                        "allowShellInput": info.allow_shell_input,
                        "sessionExpirySecs": info.session_expiry_secs,
                    })
                    .to_string(),
                )
            }
            Err(message) => {
                hub.record_auth_failure(&address);
                respond(
                    stream,
                    401,
                    "application/json",
                    &json!({ "error": message }).to_string(),
                )
            }
        };
    }

    if path == "/appearance.json" && method == "GET" {
        return respond(
            stream,
            200,
            "application/json",
            &remote_appearance(app).to_string(),
        );
    }

    if path.starts_with("/api/") {
        let Some(session_id) = hub.session_id_for(&bearer_token(&head)) else {
            hub.record_auth_failure(&address);
            return respond(
                stream,
                401,
                "application/json",
                r#"{"error":"Remote session is not valid"}"#,
            );
        };
        hub.clear_auth_failures(&address);
        if path == "/api/unlock" && method == "POST" {
            let pin = serde_json::from_slice::<Value>(&body)
                .ok()
                .and_then(|value| value.get("pin").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or_default();
            return match hub.unlock(session_id, &pin) {
                PinOutcome::Unlocked => respond(stream, 204, "text/plain", ""),
                PinOutcome::Wrong { remaining } => respond(
                    stream,
                    403,
                    "application/json",
                    &json!({ "error": "pin_wrong", "remaining": remaining }).to_string(),
                ),
                PinOutcome::LockedOut => respond(
                    stream,
                    401,
                    "application/json",
                    r#"{"error":"Too many wrong PINs. Pair this device again."}"#,
                ),
            };
        }
        // A remembered device restored after a restart proves itself with the
        // PIN before it can read or send anything.
        if hub.session_locked(session_id) {
            return respond(
                stream,
                423,
                "application/json",
                r#"{"error":"pin_required"}"#,
            );
        }
        hub.refresh_trust(session_id);
        return handle_api(
            stream, app, hub, sessions, generation, session_id, method, target, &body,
        );
    }

    match path {
        "/" | "/index.html" => respond_large(
            stream,
            200,
            "text/html; charset=utf-8",
            include_str!("../../remote/index.html"),
        ),
        "/app.js" => respond_large(
            stream,
            200,
            "text/javascript; charset=utf-8",
            include_str!("../../remote/app.js"),
        ),
        "/locales.js" => respond_large(
            stream,
            200,
            "application/javascript; charset=utf-8",
            include_str!("../../remote/locales.js"),
        ),
        "/app.css" => respond_large(
            stream,
            200,
            "text/css; charset=utf-8",
            include_str!("../../remote/app.css"),
        ),
        "/theme.css" => respond(
            stream,
            200,
            "text/css; charset=utf-8",
            include_str!("../../../src/styles/theme.css"),
        ),
        "/vendor/xterm.js" => respond_immutable_asset(
            stream,
            200,
            "text/javascript; charset=utf-8",
            // Staged by build.rs from node_modules (a stub when npm packages are missing).
            include_str!(concat!(env!("OUT_DIR"), "/xterm.js")),
        ),
        "/vendor/xterm.css" => respond_immutable_asset(
            stream,
            200,
            "text/css; charset=utf-8",
            include_str!(concat!(env!("OUT_DIR"), "/xterm.css")),
        ),
        "/vendor/addon-unicode11.js" => respond_immutable_asset(
            stream,
            200,
            "text/javascript; charset=utf-8",
            include_str!(concat!(env!("OUT_DIR"), "/addon-unicode11.js")),
        ),
        "/brand-icon.png" => respond_asset_bytes(
            stream,
            200,
            "image/png",
            selected_brand_icon(&projects_document(app)),
        ),
        "/assets/fonts/CaskaydiaCoveNerdFontMono-Regular.ttf" => respond_immutable_asset_bytes(
            stream,
            200,
            "font/ttf",
            include_bytes!("../../../src/assets/fonts/CaskaydiaCoveNerdFontMono-Regular.ttf"),
        ),
        "/assets/fonts/CaskaydiaCoveNerdFontMono-Bold.ttf" => respond_immutable_asset_bytes(
            stream,
            200,
            "font/ttf",
            include_bytes!("../../../src/assets/fonts/CaskaydiaCoveNerdFontMono-Bold.ttf"),
        ),
        "/assets/fonts/CaskaydiaCoveNerdFontMono-Italic.ttf" => respond_immutable_asset_bytes(
            stream,
            200,
            "font/ttf",
            include_bytes!("../../../src/assets/fonts/CaskaydiaCoveNerdFontMono-Italic.ttf"),
        ),
        "/assets/fonts/CaskaydiaCoveNerdFontMono-BoldItalic.ttf" => respond_immutable_asset_bytes(
            stream,
            200,
            "font/ttf",
            include_bytes!("../../../src/assets/fonts/CaskaydiaCoveNerdFontMono-BoldItalic.ttf"),
        ),
        "/manifest.webmanifest" => respond(
            stream,
            200,
            "application/manifest+json",
            include_str!("../../remote/manifest.webmanifest"),
        ),
        "/assets/agents/claude.png" => respond_immutable_asset_bytes(
            stream,
            200,
            "image/png",
            include_bytes!("../../../src/assets/claude-code.png"),
        ),
        "/assets/agents/codex.png" => respond_immutable_asset_bytes(
            stream,
            200,
            "image/png",
            include_bytes!("../../../src/assets/codex.png"),
        ),
        "/assets/agents/opencode.png" => respond_immutable_asset_bytes(
            stream,
            200,
            "image/png",
            include_bytes!("../../../src/assets/open-white.png"),
        ),
        _ => respond(stream, 404, "text/plain", "Not found"),
    }
}

fn handle_api(
    stream: &mut TcpStream,
    app: &AppHandle,
    hub: &Arc<RemoteHub>,
    sessions: &PtySessions,
    generation: u64,
    session_id: usize,
    method: &str,
    target: &str,
    body: &[u8],
) -> Result<(), String> {
    let path = target.split('?').next().unwrap_or("/");
    if path == "/api/info" {
        let info = hub.info();
        return respond(
            stream,
            200,
            "application/json",
            &json!({
                "wsUrl": info.ws_url,
                "readOnly": info.read_only,
                "allowShellInput": info.allow_shell_input,
                "sessionExpirySecs": info.session_expiry_secs,
            })
            .to_string(),
        );
    }
    if path == "/api/state" {
        return respond(
            stream,
            200,
            "application/json",
            &workspace_snapshot(app)?.to_string(),
        );
    }
    if path == "/api/scrollback" {
        let id = query_value(target, "id").ok_or_else(|| "Missing PTY id".to_string())?;
        if !pty_is_shared(app, &id) {
            return respond(
                stream,
                403,
                "application/json",
                r#"{"error":"This terminal is not available remotely"}"#,
            );
        }
        hub.set_subscription(session_id, Some(id.clone()));
        let text = read_scrollback(sessions, &id, MAX_SCROLLBACK);
        let (cols, rows) = read_pty_size(sessions, &id).unwrap_or((80, 24));
        return respond_large(
            stream,
            200,
            "application/json",
            &json!({ "text": text, "cols": cols, "rows": rows }).to_string(),
        );
    }
    if path == "/api/transcript" {
        let id = query_value(target, "id").ok_or_else(|| "Missing PTY id".to_string())?;
        if !pty_is_shared(app, &id) {
            return respond(
                stream,
                403,
                "application/json",
                r#"{"error":"This terminal is not available remotely"}"#,
            );
        }
        let Some(tab) = shared_tab(app, &id) else {
            return respond(
                stream,
                404,
                "application/json",
                r#"{"error":"Terminal not found"}"#,
            );
        };
        if tab.agent != "claude" && tab.agent != "codex" {
            return respond(
                stream,
                200,
                "application/json",
                &json!({ "supported": false, "agent": tab.agent }).to_string(),
            );
        }
        let since = query_value(target, "since").and_then(|value| value.parse::<u64>().ok());
        return match app
            .state::<crate::session_reader::SessionReaders>()
            .read_or_newest(
                &tab.agent,
                &tab.cwd,
                tab.session_id.as_deref(),
                since,
                MAX_TRANSCRIPT_EVENTS,
            ) {
            Ok(read) => {
                let payload = json!({
                    "sessionId": read.session_id,
                    "revision": read.revision,
                    "unchanged": read.unchanged,
                    "messages": read.events,
                    "supported": true,
                    "agent": tab.agent,
                });
                respond_large(stream, 200, "application/json", &payload.to_string())
            }
            Err(error) => respond(
                stream,
                200,
                "application/json",
                &json!({ "supported": true, "agent": tab.agent, "error": error }).to_string(),
            ),
        };
    }
    if path == "/api/question-answer" && method == "POST" {
        if hub.is_read_only() {
            return respond(
                stream,
                403,
                "application/json",
                r#"{"error":"Remote control is in read-only mode"}"#,
            );
        }
        if !hub.allow_message(session_id) {
            return respond(
                stream,
                429,
                "application/json",
                r#"{"error":"Too many messages, slow down"}"#,
            );
        }
        let payload: RemoteQuestionAnswer =
            serde_json::from_slice(body).map_err(|error| error.to_string())?;
        let Some(tab) = shared_tab(app, &payload.pty_id) else {
            return respond(
                stream,
                403,
                "application/json",
                r#"{"error":"This terminal is not available remotely"}"#,
            );
        };
        if tab.agent != "claude" && tab.agent != "codex" {
            return respond(
                stream,
                409,
                "application/json",
                r#"{"error":"This agent does not expose interactive questions"}"#,
            );
        }
        // The question still waiting is the session's last event.
        let active = app
            .state::<crate::session_reader::SessionReaders>()
            .read_or_newest(&tab.agent, &tab.cwd, tab.session_id.as_deref(), None, 1)
            .ok()
            .and_then(|read| read.events.into_iter().last())
            .and_then(|event| Some((event.question_set_id.unwrap_or_default(), event.questions?)));
        let Some((_, questions)) = active.filter(|(id, _)| *id == payload.question_set_id) else {
            return respond(
                stream,
                409,
                "application/json",
                r#"{"error":"This question changed before the answer was sent"}"#,
            );
        };
        let input =
            match question_answer_input(&questions, &payload.selections, &payload.custom_answers) {
                Ok(input) => input,
                Err(error) => {
                    return respond(
                        stream,
                        409,
                        "application/json",
                        &json!({ "error": error }).to_string(),
                    )
                }
            };
        let input_lock = hub.pty_input_lock(&payload.pty_id);
        let turn = input_lock.lock().unwrap_or_else(PoisonError::into_inner);
        let written = hub.with_active_session(generation, session_id, || {
            write_remote(sessions, &payload.pty_id, session_id, &input)
        })?;
        drop(turn);
        if !written {
            return respond_session_inactive(stream);
        }
        let device_name = hub.device_name(session_id);
        eprintln!(
            "[remote] {device_name} (device {session_id}) answered an interactive question in {}",
            payload.pty_id
        );
        let _ = app.emit(
            "remote://message",
            json!({
                "ptyId": payload.pty_id,
                "deviceId": session_id,
                "deviceName": device_name,
                "preview": "Answered an interactive agent question",
            }),
        );
        return respond(stream, 204, "text/plain", "");
    }
    if path == "/api/agent-control" && method == "POST" {
        let (payload, agent) =
            match agent_control_gate(hub, session_id, body, |pty_id| pty_agent(app, pty_id))? {
                Gate::Pass(payload, agent) => (payload, agent),
                Gate::Refuse(status, error) => {
                    return respond(
                        stream,
                        status,
                        "application/json",
                        &json!({ "error": error }).to_string(),
                    )
                }
            };
        if matches!(payload.action.as_str(), "edit_queued" | "clear_box") {
            return queued_box(stream, app, hub, sessions, generation, session_id, &payload);
        }
        let Some((keys, preview, guarded)) = control_keys(&payload.action, &agent) else {
            return respond(
                stream,
                400,
                "application/json",
                r#"{"error":"Unknown agent control action"}"#,
            );
        };
        let input_lock = hub.pty_input_lock(&payload.pty_id);
        let turn = input_lock.lock().unwrap_or_else(PoisonError::into_inner);
        let (out, ledger) = pty_input(sessions, &payload.pty_id)?;
        // Each half of a chord must arrive as its own keypress.
        let sent = write_sequence(
            hub,
            generation,
            session_id,
            &out,
            &ledger,
            keys,
            Duration::from_millis(60),
            guarded,
        )?;
        drop(turn);
        match sent {
            Sent::Inactive => return respond_session_inactive(stream),
            Sent::BoxPending(pull_id) => return respond_box_pending(stream, &pull_id),
            Sent::Written { .. } => {}
        }
        let device_name = hub.device_name(session_id);
        eprintln!(
            "[remote] {device_name} (device {session_id}) {} {}",
            payload.action, payload.pty_id
        );
        let _ = app.emit(
            "remote://message",
            json!({
                "ptyId": payload.pty_id,
                "deviceId": session_id,
                "deviceName": device_name,
                "preview": preview,
            }),
        );
        return respond(stream, 204, "text/plain", "");
    }
    if path == "/api/attachment" && method == "POST" {
        if hub.is_read_only() {
            return respond(
                stream,
                403,
                "application/json",
                r#"{"error":"Remote control is in read-only mode"}"#,
            );
        }
        if !hub.allow_attachment(session_id) {
            return respond(
                stream,
                429,
                "application/json",
                r#"{"error":"Too many photos, slow down"}"#,
            );
        }
        let pty_id = query_value(target, "ptyId").unwrap_or_default();
        // Claude Code and Codex turn a pasted image path into an attachment;
        // a shell would just receive a path, so it is not offered there.
        if !matches!(pty_agent(app, &pty_id).as_deref(), Some("claude" | "codex")) {
            return respond(
                stream,
                409,
                "application/json",
                r#"{"error":"Photos can only be sent to Codex and Claude Code"}"#,
            );
        }
        let Some(extension) = attachment_extension(body) else {
            return respond(
                stream,
                415,
                "application/json",
                r#"{"error":"Only JPEG, PNG and WebP photos are supported"}"#,
            );
        };
        // Only stored here: the photo reaches the agent together with the
        // text, in one send, so the phone can show it in the box until then.
        let dir = attachment_dir().ok_or("No cache folder to keep photos in")?;
        let id = store_attachment(&dir, body, extension, MAX_ATTACHMENT_STORE)?;
        let device_name = hub.device_name(session_id);
        eprintln!("[remote] {device_name} (device {session_id}) uploaded a photo for {pty_id}");
        return respond(
            stream,
            200,
            "application/json",
            &json!({ "id": id }).to_string(),
        );
    }
    if path == "/api/message" && method == "POST" {
        if hub.is_read_only() {
            return respond(
                stream,
                403,
                "application/json",
                r#"{"error":"Remote control is in read-only mode"}"#,
            );
        }
        if !hub.allow_message(session_id) {
            return respond(
                stream,
                429,
                "application/json",
                r#"{"error":"Too many messages, slow down"}"#,
            );
        }
        let payload: RemoteMessage = serde_json::from_slice(body).map_err(|e| e.to_string())?;
        let text = sanitize_remote_message(&payload.text);
        let text = text.trim();
        let Some(photos) = resolve_attachments(&payload.attachments) else {
            return respond(
                stream,
                400,
                "application/json",
                r#"{"error":"Photo not found, attach it again"}"#,
            );
        };
        if (text.is_empty() && photos.is_empty()) || text.len() > MAX_MESSAGE {
            return respond(
                stream,
                400,
                "application/json",
                r#"{"error":"Message is empty or too large"}"#,
            );
        }
        let agent = pty_agent(app, &payload.pty_id);
        let Some(agent) = agent else {
            return respond(
                stream,
                403,
                "application/json",
                r#"{"error":"This terminal is not available remotely"}"#,
            );
        };
        if agent == "shell" && !hub.shell_input_allowed() {
            return respond(
                stream,
                403,
                "application/json",
                r#"{"error":"Sending commands to shell terminals is disabled"}"#,
            );
        }
        if !photos.is_empty() && !matches!(agent.as_str(), "claude" | "codex") {
            return respond(
                stream,
                409,
                "application/json",
                r#"{"error":"Photos can only be sent to Codex and Claude Code"}"#,
            );
        }
        // Photos, text and Enter go out as one sequence: no other remote
        // write to this terminal can land between a paste and its Enter.
        let input_lock = hub.pty_input_lock(&payload.pty_id);
        let turn = input_lock.lock().unwrap_or_else(PoisonError::into_inner);
        let (out, ledger) = pty_input(sessions, &payload.pty_id)?;
        let send = RemoteSend {
            device: session_id,
            start: 0,
            text: payload.text.trim().to_string(),
            photos: payload.attachments.clone(),
            sent_ms: 0,
        };
        let sent = send_message(
            hub,
            generation,
            &out,
            &ledger,
            &photos,
            text,
            send,
            ATTACHMENT_SETTLE,
        )?;
        drop(turn);
        match sent {
            Sent::Inactive => return respond_session_inactive(stream),
            Sent::BoxPending(pull_id) => return respond_box_pending(stream, &pull_id),
            Sent::Written { .. } => {}
        }
        let device_name = hub.device_name(session_id);
        eprintln!(
            "[remote] {device_name} (device {session_id}) sent {} chars and {} photo(s) to {}",
            text.len(),
            photos.len(),
            payload.pty_id
        );
        let _ = app.emit(
            "remote://message",
            json!({
                "ptyId": payload.pty_id,
                "deviceId": session_id,
                "deviceName": device_name,
                "preview": text.chars().take(120).collect::<String>(),
            }),
        );
        return respond(stream, 204, "text/plain", "");
    }
    respond(stream, 404, "application/json", r#"{"error":"Not found"}"#)
}

/// The session was revoked or remote control was turned off between
/// authentication and the PTY write, so the write was not attempted.
fn respond_session_inactive(stream: &mut TcpStream) -> Result<(), String> {
    respond(
        stream,
        401,
        "application/json",
        r#"{"error":"Remote session is no longer active"}"#,
    )
}

/// Text this device pulled back still sits untouched in the input box.
fn respond_box_pending(stream: &mut TcpStream, pull_id: &str) -> Result<(), String> {
    respond(stream, 409, "application/json", &box_pending_body(pull_id))
}

/// Names the device's own pending pull, so a tab that lost its id (a reload,
/// another tab) can still offer to clear the box.
fn box_pending_body(pull_id: &str) -> String {
    json!({
        "error": "Text taken back from the queue is still in the input box; clear it first",
        "code": BOX_PENDING,
        "pullId": pull_id,
    })
    .to_string()
}

/// What `/api/agent-control` decided before touching the terminal.
enum Gate {
    /// Go ahead: the request and the terminal's agent.
    Pass(RemoteAgentControl, String),
    Refuse(u16, &'static str),
}

/// `/api/agent-control`'s checks, in order: read-only, rate limit, the
/// request, a terminal not shared (`agent_of` names a shared terminal's
/// agent), an agent it cannot drive, a queue action for an agent without one.
fn agent_control_gate(
    hub: &RemoteHub,
    device: usize,
    body: &[u8],
    agent_of: impl FnOnce(&str) -> Option<String>,
) -> Result<Gate, String> {
    if hub.is_read_only() {
        return Ok(Gate::Refuse(403, "Remote control is in read-only mode"));
    }
    if !hub.allow_message(device) {
        return Ok(Gate::Refuse(429, "Too many messages, slow down"));
    }
    let payload: RemoteAgentControl =
        serde_json::from_slice(body).map_err(|error| error.to_string())?;
    let Some(agent) = agent_of(&payload.pty_id) else {
        return Ok(Gate::Refuse(403, "This terminal is not available remotely"));
    };
    if agent != "claude" && agent != "codex" {
        return Ok(Gate::Refuse(
            409,
            "Only Codex and Claude Code can be controlled remotely",
        ));
    }
    if matches!(payload.action.as_str(), "edit_queued" | "clear_box") && agent != "claude" {
        return Ok(Gate::Refuse(409, "Only Claude Code queues messages"));
    }
    Ok(Gate::Pass(payload, agent))
}

/// Keys and log preview for a key action of `/api/agent-control` on `agent`,
/// and whether text this device pulled back into the box blocks it.
fn control_keys(
    action: &str,
    agent: &str,
) -> Option<(&'static [&'static str], &'static str, bool)> {
    match action {
        // Stopping the agent stays possible whatever the box holds.
        "interrupt" => Some((&["\x03"], "Interrupted the active agent turn", false)),
        // Claude Code queues a message typed while a turn is running and only
        // offers `ctrl+x ctrl+s` to send it now, a chord a phone keyboard
        // cannot type. With pulled text in the box it would submit that.
        "send_now" if agent == "claude" => {
            Some((&["\x18", "\x13"], "Sent the queued message now", true))
        }
        _ => None,
    }
}

/// What became of a remote device's sequence of writes.
#[derive(Debug, PartialEq)]
enum Sent {
    /// `start` is the ledger sequence of the first write, `last_ms` the Unix
    /// ms just before the last one.
    Written {
        start: u64,
        last_ms: u64,
    },
    /// The device's pull with this id left text untouched in the input box:
    /// what it types now would join it, and Enter would submit both.
    BoxPending(String),
    Inactive,
}

/// Writes `chunks` for `device`, `gap` apart; when `guarded`, refuses first
/// while the device's pulled text sits untouched in the input box. The check
/// and the first write share one ledger hold. Lock order as in `pull_queued`.
#[allow(clippy::too_many_arguments)]
fn write_sequence<S: AsRef<str>>(
    hub: &RemoteHub,
    generation: u64,
    device: usize,
    out: &Mutex<Box<dyn Write + Send>>,
    ledger: &Mutex<InputLedger>,
    chunks: &[S],
    gap: Duration,
    guarded: bool,
) -> Result<Sent, String> {
    let (mut start, mut last_ms) = (0, 0);
    for (index, chunk) in chunks.iter().enumerate() {
        if index > 0 {
            thread::sleep(gap);
        }
        let mut ledger = ledger.lock().unwrap_or_else(PoisonError::into_inner);
        if index == 0 {
            if let Some(pull_id) = ledger.pending_pull(device).filter(|_| guarded) {
                return Ok(Sent::BoxPending(pull_id.to_string()));
            }
            start = ledger.next_seq();
        }
        last_ms = crate::provider_common::now_ms();
        let written = hub.with_active_session(generation, device, || {
            write_counted(&mut ledger, out, Writer::Device(device), chunk.as_ref())
        })?;
        if !written {
            return Ok(Sent::Inactive);
        }
    }
    Ok(Sent::Written { start, last_ms })
}

/// `/api/message`'s writes: each photo pasted, then `text` and Enter, as one
/// send, remembered from its first write on for a later pull.
#[allow(clippy::too_many_arguments)]
fn send_message(
    hub: &RemoteHub,
    generation: u64,
    out: &Mutex<Box<dyn Write + Send>>,
    ledger: &Mutex<InputLedger>,
    photos: &[String],
    text: &str,
    mut send: RemoteSend,
    settle: Duration,
) -> Result<Sent, String> {
    // Bracketed paste is what makes both agents attach the image (checked
    // live: `[Image #1]`); typed as plain text it stays a path.
    let mut chunks: Vec<String> = photos
        .iter()
        .map(|photo| format!("\x1b[200~{photo}\x1b[201~"))
        .collect();
    chunks.push(if photos.is_empty() {
        format!("{text}\r")
    } else {
        format!(" {text}\r")
    });
    // The agent reads a photo's file on paste; Enter before `settle` sends
    // the text without the image.
    let sent = write_sequence(
        hub,
        generation,
        send.device,
        out,
        ledger,
        &chunks,
        settle,
        true,
    )?;
    if let Sent::Written { start, last_ms } = sent {
        send.start = start;
        send.sent_ms = last_ms;
        ledger
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remember_send(send);
    }
    Ok(sent)
}

#[derive(Debug, PartialEq)]
enum Takeback {
    Pulled {
        pull_id: String,
        texts: Vec<String>,
        photos: Vec<String>,
    },
    Cleared,
    Refused(&'static str),
    Inactive,
}

/// `edit_queued` pulls this device's queued messages out of Claude Code's
/// queue into its input box; `clear_box` later erases that box, once the user
/// saw it. Either refuses with a `code` and writes nothing.
fn queued_box(
    stream: &mut TcpStream,
    app: &AppHandle,
    hub: &RemoteHub,
    sessions: &PtySessions,
    generation: u64,
    session_id: usize,
    payload: &RemoteAgentControl,
) -> Result<(), String> {
    let (out, ledger) = pty_input(sessions, &payload.pty_id)?;
    let cols = read_pty_size(sessions, &payload.pty_id).map_or(80, |(cols, _)| cols);
    let input_lock = hub.pty_input_lock(&payload.pty_id);
    let outcome = match payload.action.as_str() {
        "clear_box" => clear_box(
            hub,
            generation,
            session_id,
            &input_lock,
            &out,
            &ledger,
            &payload.pull_id,
            cols,
        )?,
        _ => {
            // The terminal's own session only: the newest transcript in its
            // folder may be another terminal's.
            let transcript = shared_tab(app, &payload.pty_id).and_then(|tab| {
                let id = tab.session_id.filter(|id| !id.trim().is_empty())?;
                crate::handoff::resolve_source_file(
                    crate::handoff::Provider::Claude,
                    &tab.cwd,
                    Some(&id),
                )
                .ok()
            });
            match transcript {
                None => Takeback::Refused(QUEUE_UNKNOWN),
                Some((_, path, _)) => {
                    let started_ms = ledger
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .started_ms;
                    // Read before any lock is taken: a transcript runs to megabytes.
                    let log = std::fs::read(&path)
                        .map(|bytes| claude_queue(&String::from_utf8_lossy(&bytes), started_ms))
                        .unwrap_or_default();
                    pull_queued(
                        hub,
                        generation,
                        session_id,
                        &input_lock,
                        &out,
                        &ledger,
                        &log,
                        &payload.photos,
                        cols,
                    )?
                }
            }
        }
    };
    let device_name = hub.device_name(session_id);
    let (preview, body) = match outcome {
        Takeback::Inactive => return respond_session_inactive(stream),
        Takeback::Refused(code) => {
            eprintln!(
                "[remote] {device_name} (device {session_id}) was refused {} in {}: {code}",
                payload.action, payload.pty_id
            );
            let error = match code {
                QUEUE_SHARED => "The terminal holds input from elsewhere",
                QUEUE_TOO_LONG => "The queued messages are too long to take back",
                QUEUE_PHOTO_MISSING => "A queued photo is no longer on this page",
                BOX_CHANGED => "The input box may have changed since the pull",
                _ => "Could not confirm what Claude Code has queued",
            };
            return respond(
                stream,
                409,
                "application/json",
                &json!({ "error": error, "code": code }).to_string(),
            );
        }
        Takeback::Pulled {
            pull_id,
            texts,
            photos,
        } => (
            "Pulled the queued message back to edit",
            json!({ "texts": texts, "photos": photos, "pulled": true, "pullId": pull_id }),
        ),
        Takeback::Cleared => ("Cleared the input box", json!({ "cleared": true })),
    };
    eprintln!(
        "[remote] {device_name} (device {session_id}) {} in {}",
        payload.action, payload.pty_id
    );
    let _ = app.emit(
        "remote://message",
        json!({
            "ptyId": payload.pty_id,
            "deviceId": session_id,
            "deviceName": device_name,
            "preview": preview,
        }),
    );
    respond_large(stream, 200, "application/json", &body.to_string())
}

/// Re-checks the verdict with the PTY's input held (remote writers wait on
/// `pty_input`, the desktop on the ledger), then sends only the up arrow: the
/// queue moves into the input box and nothing is deleted. Lock order is
/// `pty_input`, then the ledger: every other remote writer takes `pty_input`
/// first too, so holding the ledger into `with_active_session` cannot
/// deadlock against them.
#[allow(clippy::too_many_arguments)]
fn pull_queued(
    hub: &RemoteHub,
    generation: u64,
    device: usize,
    pty_input: &Mutex<()>,
    out: &Mutex<Box<dyn Write + Send>>,
    ledger: &Mutex<InputLedger>,
    log: &ClaudeLog,
    held: &[String],
    cols: u16,
) -> Result<Takeback, String> {
    let _turn = pty_input.lock().unwrap_or_else(PoisonError::into_inner);
    let mut ledger = ledger.lock().unwrap_or_else(PoisonError::into_inner);
    let picked = match takeback_verdict(&ledger, device, log, held, cols) {
        Ok(picked) => picked,
        Err(code) => return Ok(Takeback::Refused(code)),
    };
    let written = hub.with_active_session(generation, device, || {
        write_counted(&mut ledger, out, Writer::Device(device), PULL_KEY)
    })?;
    if !written {
        return Ok(Takeback::Inactive);
    }
    // No longer queued: a log that has not caught up cannot pull them twice.
    ledger.forget_sends(device, picked.since);
    // Random like a pairing token: only the asking tab can name this pull.
    let pull_id = nanoid::nanoid!(32);
    ledger.mark_pull(device, pull_id.clone(), log.items());
    Ok(Takeback::Pulled {
        pull_id,
        texts: picked.texts,
        photos: picked.photos,
    })
}

/// Erases what this device's pull `pull_id` put in the input box, unless
/// anyone wrote to the PTY since. Same locks, in the same order, as
/// `pull_queued`.
#[allow(clippy::too_many_arguments)]
fn clear_box(
    hub: &RemoteHub,
    generation: u64,
    device: usize,
    pty_input: &Mutex<()>,
    out: &Mutex<Box<dyn Write + Send>>,
    ledger: &Mutex<InputLedger>,
    pull_id: &str,
    cols: u16,
) -> Result<Takeback, String> {
    let _turn = pty_input.lock().unwrap_or_else(PoisonError::into_inner);
    let mut ledger = ledger.lock().unwrap_or_else(PoisonError::into_inner);
    let keys = match clear_verdict(&mut ledger, device, pull_id, cols) {
        Ok(rounds) => clear_box_keys(rounds),
        Err(code) => return Ok(Takeback::Refused(code)),
    };
    hub.hook("clear_checked");
    let written = hub.with_active_session(generation, device, || {
        write_counted(&mut ledger, out, Writer::Device(device), &keys)
    })?;
    Ok(if written {
        Takeback::Cleared
    } else {
        Takeback::Inactive
    })
}

#[derive(Deserialize)]
struct PairRequest {
    token: String,
    #[serde(rename = "deviceName")]
    device_name: Option<String>,
}

#[derive(Deserialize)]
struct RemoteMessage {
    #[serde(rename = "ptyId")]
    pty_id: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    attachments: Vec<String>,
}

const MAX_ATTACHMENTS_PER_MESSAGE: usize = 6;
const ATTACHMENT_SETTLE: Duration = Duration::from_millis(250);

const ATTACHMENT_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// Ceiling for the whole upload folder (16 photos at the per-upload cap, far
/// more at the few hundred KB the phone sends), so a paired device cannot
/// fill the disk within the one-day retention.
const MAX_ATTACHMENT_STORE: u64 = 16 * MAX_ATTACHMENT as u64;

/// The user's own cache folder, not the shared temp dir: on Linux `/tmp` is
/// open to every local user, who could read or swap a photo before it is
/// pasted into the agent. Without a cache folder, photos are refused.
fn attachment_dir() -> Option<std::path::PathBuf> {
    dirs_next::cache_dir().map(|dir| dir.join("com.kc1t.alethe").join("remote-uploads"))
}

/// Held from the size check to the write, so two uploads cannot both see room
/// under the cap and then overshoot it together.
static ATTACHMENT_STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Stores one photo under a fresh id once it fits under `cap`.
fn store_attachment(
    dir: &std::path::Path,
    body: &[u8],
    extension: &str,
    cap: u64,
) -> Result<String, String> {
    let _store = ATTACHMENT_STORE_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    prepare_attachment_dir(dir, body.len(), cap)?;
    let id = format!("{}.{extension}", nanoid::nanoid!(16));
    std::fs::write(dir.join(&id), body).map_err(|error| error.to_string())?;
    Ok(id)
}

/// Creates the folder owner-only, drops photos older than a day, which the
/// agent has long since read, and then the oldest ones until `incoming` bytes
/// fit under `cap`.
fn prepare_attachment_dir(dir: &std::path::Path, incoming: usize, cap: u64) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    let mut kept = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let modified = meta.modified().ok();
            let old = modified
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|age| age > ATTACHMENT_MAX_AGE);
            if old {
                let _ = std::fs::remove_file(entry.path());
            } else {
                kept.push((modified, meta.len(), entry.path()));
            }
        }
    }
    kept.sort_by_key(|(modified, ..)| *modified);
    let mut total = incoming as u64 + kept.iter().map(|(_, len, _)| len).sum::<u64>();
    for (_, len, path) in kept {
        if total <= cap {
            break;
        }
        if std::fs::remove_file(path).is_ok() {
            total -= len;
        }
    }
    if total > cap {
        return Err("Photo storage is full".into());
    }
    Ok(())
}

/// Turns the ids `/api/attachment` handed out back into file paths. Only ids
/// of that exact shape are accepted, so a phone cannot name any other file.
fn resolve_attachments(ids: &[String]) -> Option<Vec<String>> {
    if ids.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return None;
    }
    let dir = attachment_dir();
    ids.iter()
        .map(|id| {
            let (stem, extension) = id.split_once('.')?;
            let valid = stem.len() == 16
                && stem
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
                && matches!(extension, "jpg" | "png" | "webp");
            let file = dir.as_ref()?.join(id);
            (valid && file.is_file()).then(|| file.to_string_lossy().to_string())
        })
        .collect()
}

#[derive(Deserialize)]
struct RemoteQuestionAnswer {
    #[serde(rename = "ptyId")]
    pty_id: String,
    #[serde(rename = "questionSetId")]
    question_set_id: String,
    selections: Vec<Vec<usize>>,
    #[serde(default, rename = "customAnswers")]
    custom_answers: Vec<Option<String>>,
}

#[derive(Deserialize)]
struct RemoteAgentControl {
    #[serde(rename = "ptyId")]
    pty_id: String,
    action: String,
    /// For `edit_queued`: the photo ids the asking tab still holds.
    #[serde(default)]
    photos: Vec<String>,
    /// For `clear_box`: the pull the user confirmed, as `edit_queued` named it.
    #[serde(rename = "pullId", default)]
    pull_id: String,
}

fn question_answer_input(
    questions: &[crate::handoff::RemoteQuestion],
    selections: &[Vec<usize>],
    custom_answers: &[Option<String>],
) -> Result<String, String> {
    if questions.is_empty()
        || questions.len() != selections.len()
        || (!custom_answers.is_empty() && questions.len() != custom_answers.len())
    {
        return Err("The interactive question is no longer active".into());
    }
    let mut input = String::new();
    for (question_index, (question, selected)) in questions.iter().zip(selections).enumerate() {
        let custom = custom_answers
            .get(question_index)
            .and_then(|value| value.as_deref())
            .map(sanitize_remote_message)
            .map(|value| value.trim().chars().take(1_000).collect::<String>())
            .filter(|value| !value.is_empty());
        if (selected.is_empty() && custom.is_none())
            || (!question.multi_select && selected.len() != 1 && custom.is_none())
            || (!selected.is_empty() && custom.is_some())
        {
            return Err("Select an answer for every question".into());
        }
        let mut unique = selected.clone();
        unique.sort_unstable();
        unique.dedup();
        if unique.len() != selected.len()
            || unique.iter().any(|index| *index >= question.options.len())
        {
            return Err("An answer option is invalid".into());
        }
        if let Some(custom) = custom {
            input.push_str(&"\x1b[A".repeat(question.options.len() + 2));
            input.push_str(&"\x1b[B".repeat(question.options.len()));
            input.push('\r');
            input.push_str(&custom);
        } else if question.multi_select {
            for index in unique {
                input.push_str(&"\x1b[A".repeat(question.options.len() + 2));
                input.push_str(&"\x1b[B".repeat(index));
                input.push(' ');
            }
        } else {
            input.push_str(&"\x1b[A".repeat(question.options.len() + 2));
            input.push_str(&"\x1b[B".repeat(unique[0]));
        }
        input.push('\r');
    }
    Ok(input)
}

/// Only the photo upload route may carry a body past the usual JSON cap.
/// Only a photo upload from a paired device may send the larger body; the
/// token is checked before reading it, so an unpaired client cannot make the
/// server buffer megabytes.
fn body_limit(head: &str, paired: impl FnOnce() -> bool) -> usize {
    let first = head.split("\r\n").next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let is_attachment = parts.next() == Some("POST")
        && parts
            .next()
            .is_some_and(|target| target.split('?').next() == Some("/api/attachment"));
    if is_attachment && paired() {
        MAX_ATTACHMENT
    } else {
        MAX_BODY
    }
}

/// Image formats the phone may upload, recognised by their leading bytes rather
/// than by anything the client claims.
fn attachment_extension(body: &[u8]) -> Option<&'static str> {
    if body.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if body.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if body.len() > 12 && &body[..4] == b"RIFF" && &body[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

fn read_request(
    stream: &mut TcpStream,
    paired: impl Fn(&str) -> bool,
) -> Result<(String, Vec<u8>), String> {
    let mut raw: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut chunk = [0_u8; 8 * 1024];
    let headers_end = loop {
        if let Some(index) = find_headers_end(&raw) {
            break index;
        }
        if raw.len() > MAX_REQUEST {
            return Err("Request headers too large".into());
        }
        let count = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if count == 0 {
            return Err("Connection closed before the request completed".into());
        }
        raw.extend_from_slice(&chunk[..count]);
    };
    let head = String::from_utf8_lossy(&raw[..headers_end]).into_owned();
    let content_length = header_value(&head, "content-length")
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let max_body = body_limit(&head, || paired(&head));
    if content_length > max_body {
        return Err("Request body too large".into());
    }
    let mut body = raw[headers_end + 4..].to_vec();
    while body.len() < content_length {
        let count = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if count == 0 {
            return Err("Connection closed before the body completed".into());
        }
        body.extend_from_slice(&chunk[..count]);
        if body.len() > max_body {
            return Err("Request body too large".into());
        }
    }
    body.truncate(content_length);
    Ok((head, body))
}

fn find_headers_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|window| window == b"\r\n\r\n")
}

fn header_value(head: &str, name: &str) -> Option<String> {
    head.split("\r\n").skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim()
            .eq_ignore_ascii_case(name)
            .then(|| value.trim().to_string())
    })
}

fn bearer_token(head: &str) -> String {
    header_value(head, "authorization")
        .and_then(|value| {
            value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
                .map(str::to_string)
        })
        .unwrap_or_default()
}

fn respond(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) -> Result<(), String> {
    respond_bytes(stream, status, content_type, body.as_bytes())
}

fn respond_bytes(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<(), String> {
    respond_bytes_with_limit(stream, status, content_type, body, MAX_BODY, CACHE_NO_STORE)
}

fn respond_large(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) -> Result<(), String> {
    respond_bytes_with_limit(
        stream,
        status,
        content_type,
        body.as_bytes(),
        MAX_STATIC_ASSET,
        CACHE_NO_STORE,
    )
}

fn respond_asset_bytes(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<(), String> {
    respond_bytes_with_limit(
        stream,
        status,
        content_type,
        body,
        MAX_STATIC_ASSET,
        CACHE_NO_STORE,
    )
}

fn respond_immutable_asset(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) -> Result<(), String> {
    respond_immutable_asset_bytes(stream, status, content_type, body.as_bytes())
}

fn respond_immutable_asset_bytes(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<(), String> {
    respond_bytes_with_limit(
        stream,
        status,
        content_type,
        body,
        MAX_STATIC_ASSET,
        CACHE_IMMUTABLE,
    )
}

fn respond_bytes_with_limit(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    max_size: usize,
    cache_control: &str,
) -> Result<(), String> {
    if body.len() > max_size {
        return Err("Response too large".into());
    }
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        429 => "Too Many Requests",
        _ => "Error",
    };
    let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: {cache_control}\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'self'; connect-src 'self' ws:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'\r\n\r\n", body.len());
    stream
        .write_all(response.as_bytes())
        .and_then(|_| stream.write_all(body))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        attachment_dir, attachment_extension, bearer_token, body_limit, find_headers_end,
        header_value, prepare_attachment_dir, question_answer_input, resolve_attachments,
        store_attachment,
    };
    use crate::remote::{MAX_ATTACHMENT, MAX_BODY};

    mod takeback {
        use super::super::{
            agent_control_gate, box_pending_body, clear_box, control_keys, pull_queued,
            send_message, write_sequence, Gate, Sent, Takeback,
        };
        use crate::pty::{write_counted, InputLedger, RemoteSend, Writer};
        use crate::remote::takeback::{
            claude_queue, clear_box_keys, BOX_CHANGED, QUEUE_SHARED, QUEUE_UNKNOWN,
        };
        use crate::remote::RemoteHub;
        use std::io::Write;
        use std::sync::{mpsc, Arc, Mutex};
        use std::time::Duration;

        /// `paired_for_test` activates a fresh hub once.
        const GENERATION: u64 = 1;

        /// A PTY end that keeps what it was sent.
        #[derive(Clone, Default)]
        struct Typed(Arc<Mutex<Vec<u8>>>);

        impl Write for Typed {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        impl Typed {
            fn text(&self) -> String {
                String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
            }
        }

        /// A PTY where a device sent a text.
        struct Pty {
            typed: Typed,
            out: Arc<Mutex<Box<dyn Write + Send>>>,
            ledger: Arc<Mutex<InputLedger>>,
        }

        impl Pty {
            fn write(&self, writer: Writer, data: &str) {
                let mut ledger = self.ledger.lock().unwrap();
                write_counted(&mut ledger, &self.out, writer, data).unwrap();
            }

            /// What `/api/message` leaves in the ledger.
            fn send(&self, device: usize, text: &str) {
                let mut ledger = self.ledger.lock().unwrap();
                let start = ledger.next_seq();
                ledger.record(Writer::Device(device), &format!("{text}\r"));
                ledger.remember_send(RemoteSend {
                    device,
                    start,
                    text: text.into(),
                    photos: vec![],
                    sent_ms: 0,
                });
            }
        }

        fn after_send(device: usize, text: &str) -> Pty {
            let typed = Typed::default();
            let out: Arc<Mutex<Box<dyn Write + Send>>> =
                Arc::new(Mutex::new(Box::new(typed.clone())));
            let pty = Pty {
                typed,
                out,
                ledger: Arc::new(Mutex::new(InputLedger::new(0))),
            };
            pty.send(device, text);
            pty
        }

        /// A pull while Claude Code's log shows `queued` still queued.
        fn pull(hub: &RemoteHub, device: usize, pty: &Pty, queued: &[&str]) -> Takeback {
            let log: String = queued
                .iter()
                .map(|content| {
                    let line = serde_json::json!({
                        "type": "queue-operation",
                        "operation": "enqueue",
                        "timestamp": "2026-10-11T12:00:01.000Z",
                        "content": content,
                    });
                    format!("{line}\n")
                })
                .collect();
            pull_queued(
                hub,
                GENERATION,
                device,
                &Mutex::new(()),
                &pty.out,
                &pty.ledger,
                &claude_queue(&log, 0),
                &[],
                80,
            )
            .unwrap()
        }

        /// The id a successful pull hands the tab.
        fn pulled(outcome: Takeback) -> String {
            match outcome {
                Takeback::Pulled { pull_id, .. } => pull_id,
                other => panic!("not pulled: {other:?}"),
            }
        }

        fn clear(hub: &RemoteHub, device: usize, pty: &Pty, pull_id: &str) -> Takeback {
            clear_box(
                hub,
                GENERATION,
                device,
                &Mutex::new(()),
                &pty.out,
                &pty.ledger,
                pull_id,
                80,
            )
            .unwrap()
        }

        /// "hello" is one row: 1 + 1 per message + 2.
        fn burst() -> String {
            clear_box_keys(4)
        }

        #[test]
        fn a_pull_sends_only_the_up_arrow() {
            let (hub, device) = RemoteHub::paired_for_test();
            let pty = after_send(device, "hello");
            let Takeback::Pulled {
                pull_id,
                texts,
                photos,
            } = pull(&hub, device, &pty, &["hello"])
            else {
                panic!("not pulled");
            };
            assert_eq!(texts, ["hello"]);
            assert!(photos.is_empty());
            // Random, like a pairing token: a tab cannot guess another pull's.
            assert!(pull_id.len() >= 32, "{pull_id}");
            assert_eq!(pty.typed.text(), "\x1b[A");
            let mut ledger = pty.ledger.lock().unwrap();
            // Pulled sends are no longer queued: a log that has not caught
            // up yet cannot make them pullable twice.
            assert_eq!(ledger.sends().count(), 0);
            assert_eq!(ledger.take_pull(device, &pull_id).unwrap().texts, ["hello"]);
        }

        #[test]
        fn a_refused_or_inactive_pull_writes_nothing() {
            let (hub, device) = RemoteHub::paired_for_test();
            let desktop = after_send(device, "hello");
            desktop.write(Writer::Desktop, "x");
            let system = after_send(device, "hello");
            for (pty, queued, refusal) in [
                (&desktop, &["hello"][..], QUEUE_SHARED),
                (
                    &system,
                    &["<task-notification>done</task-notification>", "hello"][..],
                    QUEUE_SHARED,
                ),
                (&system, &[][..], QUEUE_UNKNOWN),
            ] {
                let typed = pty.typed.text();
                assert_eq!(pull(&hub, device, pty, queued), Takeback::Refused(refusal));
                assert_eq!(pty.typed.text(), typed);
                assert_eq!(pty.ledger.lock().unwrap().sends().count(), 1);
            }

            let after_stop = after_send(device, "hello");
            hub.shutdown();
            assert_eq!(
                pull(&hub, device, &after_stop, &["hello"]),
                Takeback::Inactive
            );
            assert_eq!(after_stop.typed.text(), "");
        }

        #[test]
        fn a_second_pull_before_the_log_catches_up_is_refused() {
            let (hub, device) = RemoteHub::paired_for_test();
            let pty = after_send(device, "hello");
            pulled(pull(&hub, device, &pty, &["hello"]));
            // The log still shows "hello" queued: a second up arrow could
            // pull history into the box instead.
            assert_eq!(
                pull(&hub, device, &pty, &["hello"]),
                Takeback::Refused(QUEUE_SHARED)
            );
            assert_eq!(pty.typed.text(), "\x1b[A");
        }

        #[test]
        fn a_clear_needs_the_id_of_the_pull_it_confirms() {
            let (hub, device) = RemoteHub::paired_for_test();
            let pty = after_send(device, "hello");
            assert_eq!(
                clear(&hub, device, &pty, "unknown"),
                Takeback::Refused(BOX_CHANGED)
            );
            let pull_id = pulled(pull(&hub, device, &pty, &["hello"]));
            // No id, or one of no pull here.
            for stale in ["", "unknown"] {
                assert_eq!(
                    clear(&hub, device, &pty, stale),
                    Takeback::Refused(BOX_CHANGED)
                );
            }
            assert_eq!(pty.typed.text(), "\x1b[A");
            // Neither used the pull up.
            assert_eq!(clear(&hub, device, &pty, &pull_id), Takeback::Cleared);
        }

        #[test]
        fn a_late_clear_of_an_earlier_pull_never_clears_a_later_one() {
            let (hub, device) = RemoteHub::paired_for_test();
            let pty = after_send(device, "X");
            let first = pulled(pull(&hub, device, &pty, &["X"]));
            // Tab A's clear of "X" is still on its way. The desktop clears
            // "X" by hand, then tab B sends "Y" and pulls it.
            pty.write(Writer::Desktop, "\x15");
            pty.send(device, "Y");
            let second = pulled(pull(&hub, device, &pty, &["Y"]));
            assert_eq!(
                clear(&hub, device, &pty, &first),
                Takeback::Refused(BOX_CHANGED)
            );
            assert_eq!(pty.typed.text(), "\x1b[A\x15\x1b[A");
            // "Y" goes only with its own pull's clear.
            assert_eq!(clear(&hub, device, &pty, &second), Takeback::Cleared);
        }

        #[test]
        fn a_pull_id_from_before_the_pty_restarted_is_refused() {
            let (hub, device) = RemoteHub::paired_for_test();
            let old = after_send(device, "hello");
            let old_id = pulled(pull(&hub, device, &old, &["hello"]));
            // The PTY restarts under the same id: a new process, a new ledger.
            let new = after_send(device, "hello");
            assert_eq!(
                clear(&hub, device, &new, &old_id),
                Takeback::Refused(BOX_CHANGED)
            );
            let new_id = pulled(pull(&hub, device, &new, &["hello"]));
            assert_ne!(new_id, old_id);
            assert_eq!(
                clear(&hub, device, &new, &old_id),
                Takeback::Refused(BOX_CHANGED)
            );
            assert_eq!(new.typed.text(), "\x1b[A");
        }

        #[test]
        fn a_clear_after_anyone_wrote_since_the_pull_is_refused() {
            let (hub, device) = RemoteHub::paired_for_test();
            for (writer, refusal) in [
                (Writer::Desktop, QUEUE_SHARED),
                (Writer::Device(device + 1), QUEUE_SHARED),
                (Writer::Device(device), BOX_CHANGED),
            ] {
                let pty = after_send(device, "hello");
                let pull_id = pulled(pull(&hub, device, &pty, &["hello"]));
                pty.write(writer, "x\r");
                assert_eq!(
                    clear(&hub, device, &pty, &pull_id),
                    Takeback::Refused(refusal),
                    "{writer:?}"
                );
                assert_eq!(pty.typed.text(), "\x1b[Ax\r");
            }
        }

        #[test]
        fn a_clear_after_the_pull_sends_the_burst_once() {
            let (hub, device) = RemoteHub::paired_for_test();
            let pty = after_send(device, "hello");
            let pull_id = pulled(pull(&hub, device, &pty, &["hello"]));
            // An xterm focus reply is nobody's input.
            pty.write(Writer::Desktop, "\x1b[I");
            assert_eq!(clear(&hub, device, &pty, &pull_id), Takeback::Cleared);
            let cleared = format!("\x1b[A\x1b[I{}", burst());
            assert_eq!(pty.typed.text(), cleared);
            assert_eq!(
                clear(&hub, device, &pty, &pull_id),
                Takeback::Refused(BOX_CHANGED)
            );
            assert_eq!(pty.typed.text(), cleared);
        }

        #[test]
        fn desktop_typing_waits_for_the_clear_burst() {
            let (hub, device) = RemoteHub::paired_for_test();
            let pty = after_send(device, "hello");
            let pull_id = pulled(pull(&hub, device, &pty, &["hello"]));
            let (out, ledger) = (Arc::clone(&pty.out), Arc::clone(&pty.ledger));
            let (done_tx, done_rx) = mpsc::channel();
            hub.on_hook("clear_checked", move || {
                let (started_tx, started_rx) = mpsc::channel();
                std::thread::spawn(move || {
                    started_tx.send(()).unwrap();
                    // What `write_input` does for `write_pty` once it found the PTY.
                    let mut ledger = ledger.lock().unwrap();
                    write_counted(&mut ledger, &out, Writer::Desktop, "typed").unwrap();
                    done_tx.send(()).unwrap();
                });
                started_rx.recv().unwrap();
                std::thread::sleep(Duration::from_millis(50));
            });
            assert_eq!(clear(&hub, device, &pty, &pull_id), Takeback::Cleared);
            done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            assert_eq!(pty.typed.text(), format!("\x1b[A{}typed", burst()));
        }

        /// A phone message whose photos' paths double as their upload ids.
        fn message(hub: &RemoteHub, device: usize, pty: &Pty, photos: &[&str], text: &str) -> Sent {
            let photos: Vec<String> = photos.iter().map(|photo| photo.to_string()).collect();
            let send = RemoteSend {
                device,
                start: 0,
                text: text.into(),
                photos: photos.clone(),
                sent_ms: 0,
            };
            send_message(
                hub,
                GENERATION,
                &pty.out,
                &pty.ledger,
                &photos,
                text,
                send,
                Duration::ZERO,
            )
            .unwrap()
        }

        #[test]
        fn a_message_is_remembered_from_its_first_photo_on() {
            let (hub, device) = RemoteHub::paired_for_test();
            let pty = after_send(device, "earlier");
            pty.write(Writer::Desktop, "d");
            assert!(matches!(
                message(&hub, device, &pty, &["p1.jpg"], "look"),
                Sent::Written { .. }
            ));
            assert_eq!(pty.typed.text(), "d\x1b[200~p1.jpg\x1b[201~ look\r");
            let ledger = pty.ledger.lock().unwrap();
            let send = ledger.sends().last().unwrap();
            // The send, the desktop's "d", then the photo (3) and the text (4).
            assert_eq!(send.start, 3);
            assert_eq!(
                (send.text.as_str(), &send.photos[..]),
                ("look", &["p1.jpg".to_string()][..])
            );
        }

        #[test]
        fn an_unwritten_message_is_not_remembered() {
            let (hub, device) = RemoteHub::paired_for_test();
            let pty = after_send(device, "earlier");
            hub.shutdown();
            assert_eq!(
                message(&hub, device, &pty, &["p1.jpg"], "late"),
                Sent::Inactive
            );
            assert_eq!(pty.typed.text(), "");
            assert_eq!(pty.ledger.lock().unwrap().sends().count(), 1);
        }

        #[test]
        fn a_message_onto_pulled_text_waits_for_the_box_to_be_cleared() {
            let (hub, device) = RemoteHub::paired_for_test();
            let pty = after_send(device, "hello");
            let pull_id = pulled(pull(&hub, device, &pty, &["hello"]));
            // Claude Code would get "hello" and "hello world" joined. The
            // refusal names the pull, so a tab that lost it can clear it.
            assert_eq!(
                message(&hub, device, &pty, &["p1.jpg"], "hello world"),
                Sent::BoxPending(pull_id.clone())
            );
            let body: serde_json::Value =
                serde_json::from_str(&box_pending_body(&pull_id)).unwrap();
            assert_eq!(body["code"], "box_pending");
            assert_eq!(body["pullId"], pull_id.as_str());
            assert_eq!(pty.typed.text(), "\x1b[A");
            assert_eq!(pty.ledger.lock().unwrap().sends().count(), 0);
            assert_eq!(clear(&hub, device, &pty, &pull_id), Takeback::Cleared);
            assert!(matches!(
                message(&hub, device, &pty, &[], "hello world"),
                Sent::Written { .. }
            ));
            assert!(pty.typed.text().ends_with("hello world\r"));
        }

        #[test]
        fn another_devices_message_is_not_held_and_learns_no_pull_id() {
            let (hub, device) = RemoteHub::paired_for_test();
            let pty = after_send(device, "hello");
            let pull_id = pulled(pull(&hub, device, &pty, &["hello"]));
            // Past the box check, only the session check stops it: the test
            // hub pairs one device.
            assert_eq!(
                message(&hub, device + 1, &pty, &[], "theirs"),
                Sent::Inactive
            );
            assert_eq!(pty.ledger.lock().unwrap().pending_pull(device + 1), None);
            assert_eq!(
                pty.ledger.lock().unwrap().pending_pull(device),
                Some(pull_id.as_str())
            );
        }

        #[test]
        fn once_anyone_else_wrote_since_the_pull_a_message_goes() {
            // The pull no longer proves what the box holds.
            let (hub, device) = RemoteHub::paired_for_test();
            for writer in [Writer::Desktop, Writer::Device(device + 1)] {
                let pty = after_send(device, "hello");
                pulled(pull(&hub, device, &pty, &["hello"]));
                pty.write(writer, "x");
                assert!(matches!(
                    message(&hub, device, &pty, &[], "next"),
                    Sent::Written { .. }
                ));
                assert_eq!(pty.typed.text(), "\x1b[Axnext\r");
            }
        }

        #[test]
        fn send_now_onto_pulled_text_is_refused() {
            let (hub, device) = RemoteHub::paired_for_test();
            let pty = after_send(device, "hello");
            pulled(pull(&hub, device, &pty, &["hello"]));
            // ctrl+x ctrl+s would submit the pulled text at once.
            let (keys, _, guarded) = control_keys("send_now", "claude").unwrap();
            assert!(guarded);
            let sent = write_sequence(
                &hub,
                GENERATION,
                device,
                &pty.out,
                &pty.ledger,
                keys,
                Duration::ZERO,
                guarded,
            )
            .unwrap();
            assert!(matches!(sent, Sent::BoxPending(_)));
            assert_eq!(pty.typed.text(), "\x1b[A");
            // Stopping the agent stays possible.
            assert!(!control_keys("interrupt", "claude").unwrap().2);
        }

        #[test]
        fn the_queue_actions_pass_every_agent_control_gate() {
            for action in ["edit_queued", "clear_box"] {
                let (hub, device) = RemoteHub::paired_for_test();
                // A new hub starts read-only.
                hub.set_read_only(false);
                let body = serde_json::json!({ "ptyId": "t", "action": action }).to_string();
                let gate = |agent: Option<&str>| match agent_control_gate(
                    &hub,
                    device,
                    body.as_bytes(),
                    |pty_id| {
                        assert_eq!(pty_id, "t");
                        agent.map(str::to_string)
                    },
                )
                .unwrap()
                {
                    Gate::Pass(payload, agent) => {
                        assert_eq!(payload.action, action);
                        (200, agent)
                    }
                    Gate::Refuse(status, error) => (status, error.to_string()),
                };
                assert_eq!(gate(Some("claude")), (200, "claude".into()), "{action}");
                for (agent, status, error) in [
                    (None, 403, "This terminal is not available remotely"),
                    (Some("codex"), 409, "Only Claude Code queues messages"),
                    (
                        Some("shell"),
                        409,
                        "Only Codex and Claude Code can be controlled remotely",
                    ),
                ] {
                    assert_eq!(gate(agent), (status, error.into()), "{action} {agent:?}");
                }
                hub.set_read_only(true);
                assert_eq!(
                    gate(Some("claude")),
                    (403, "Remote control is in read-only mode".into())
                );
                hub.set_read_only(false);
                let limited = (0..=crate::remote::MESSAGE_RATE_LIMIT)
                    .map(|_| gate(Some("claude")))
                    .any(|outcome| outcome == (429, "Too many messages, slow down".into()));
                assert!(limited, "{action}");
            }
        }

        #[test]
        fn only_an_explicit_clear_request_sends_the_clear_burst() {
            let source = include_str!("http.rs");
            let production = &source[..source.find("#[cfg(test)]").unwrap()];
            // One call site, inside `clear_box`...
            assert_eq!(production.matches("clear_box_keys(").count(), 1);
            let body = &production[production.find("fn clear_box(").unwrap()..];
            let body = &body[..body.find("\n}").unwrap()];
            assert!(body.contains("clear_box_keys("));
            // ...which only the `clear_box` action reaches.
            assert_eq!(production.matches("clear_box(").count(), 2);
            assert!(production.contains("\"clear_box\" => clear_box("));
        }
    }

    #[test]
    fn attachments_resolve_only_uploaded_ids() {
        let dir = attachment_dir().unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let id = "testAttachment01.jpg";
        std::fs::write(dir.join(id), b"\xFF\xD8\xFF").unwrap();
        let resolved = resolve_attachments(&[id.to_string()]).unwrap();
        assert_eq!(resolved, vec![dir.join(id).to_string_lossy().to_string()]);
        for bad in [
            "../../etc/passwd",
            "testAttachment01.sh",
            "short.jpg",
            "missingAttach001.jpg",
            "/tmp/x/../aaaaaaaaaaaaaaaa.jpg",
        ] {
            assert!(resolve_attachments(&[bad.to_string()]).is_none(), "{bad}");
        }
        assert!(resolve_attachments(&vec![id.to_string(); 7]).is_none());
        assert_eq!(resolve_attachments(&[]), Some(vec![]));
        std::fs::remove_file(dir.join(id)).unwrap();
    }

    #[test]
    fn the_upload_folder_evicts_the_oldest_photos_past_its_cap() {
        let dir = std::env::temp_dir().join(format!("alethe-uploads-{}", nanoid::nanoid!(8)));
        std::fs::create_dir_all(&dir).unwrap();
        let now = std::time::SystemTime::now();
        for (name, age) in [("old.jpg", 120), ("new.jpg", 60), ("stale.jpg", 2 * 86_400)] {
            let path = dir.join(name);
            std::fs::write(&path, [0_u8; 10]).unwrap();
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(now - std::time::Duration::from_secs(age))
                .unwrap();
        }
        // 20 bytes kept + 10 incoming is 5 over the cap: only the oldest goes.
        prepare_attachment_dir(&dir, 10, 25).unwrap();
        assert!(!dir.join("stale.jpg").exists());
        assert!(!dir.join("old.jpg").exists());
        assert!(dir.join("new.jpg").exists());
        assert!(prepare_attachment_dir(&dir, 26, 25).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn concurrent_uploads_stay_under_the_folder_cap() {
        let dir = std::env::temp_dir().join(format!("alethe-uploads-{}", nanoid::nanoid!(8)));
        for _ in 0..200 {
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            // 30 + 40 fits for each upload alone; 30 + 40 + 40 does not.
            std::fs::write(dir.join("seed.jpg"), [0_u8; 30]).unwrap();
            let start = std::sync::Arc::new(std::sync::Barrier::new(2));
            let uploads: Vec<_> = (0..2)
                .map(|_| {
                    let (dir, start) = (dir.clone(), start.clone());
                    std::thread::spawn(move || {
                        start.wait();
                        store_attachment(&dir, &[0_u8; 40], "jpg", 100).unwrap();
                    })
                })
                .collect();
            for upload in uploads {
                upload.join().unwrap();
            }
            let total: u64 = std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .map(|entry| entry.metadata().unwrap().len())
                .sum();
            assert!(total <= 100, "folder grew to {total} bytes");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_the_photo_route_gets_the_larger_body_cap() {
        let photo = "POST /api/attachment?ptyId=a HTTP/1.1\r\nContent-Length: 9";
        assert_eq!(body_limit(photo, || true), MAX_ATTACHMENT);
        assert_eq!(body_limit(photo, || false), MAX_BODY);
        assert_eq!(body_limit("POST /api/message HTTP/1.1", || true), MAX_BODY);
        assert_eq!(
            body_limit("GET /api/attachment HTTP/1.1", || true),
            MAX_BODY
        );
        assert_eq!(
            body_limit("POST /api/attachmentx HTTP/1.1", || true),
            MAX_BODY
        );
    }

    #[test]
    fn photos_are_recognised_by_their_bytes() {
        assert_eq!(attachment_extension(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(attachment_extension(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
        assert_eq!(attachment_extension(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(attachment_extension(b"<svg onload=alert(1)>"), None);
        assert_eq!(attachment_extension(b""), None);
    }
    use crate::handoff::{RemoteQuestion, RemoteQuestionOption};

    #[test]
    fn request_headers_end_is_detected_across_chunks() {
        assert_eq!(find_headers_end(b"GET / HTTP/1.1\r\n\r\nbody"), Some(14));
        assert_eq!(find_headers_end(b"GET / HTTP/1.1\r\n"), None);
    }

    #[test]
    fn header_lookup_is_case_insensitive() {
        let head = "POST /api/pair HTTP/1.1\r\nContent-Length: 42\r\nAuthorization: Bearer abc";

        assert_eq!(header_value(head, "content-length"), Some("42".into()));
        assert_eq!(bearer_token(head), "abc");
    }

    #[test]
    fn interactive_answers_become_terminal_navigation() {
        let questions = vec![RemoteQuestion {
            id: "scope".into(),
            header: "Scope".into(),
            question: "Which scope?".into(),
            multi_select: false,
            options: vec![
                RemoteQuestionOption {
                    label: "Focused".into(),
                    description: String::new(),
                },
                RemoteQuestionOption {
                    label: "Broad".into(),
                    description: String::new(),
                },
            ],
        }];
        let input = question_answer_input(&questions, &[vec![1]], &[]).expect("valid answer");
        assert!(input.ends_with("\x1b[B\r"));
        assert!(question_answer_input(&questions, &[vec![2]], &[]).is_err());
        assert!(question_answer_input(&questions, &[], &[]).is_err());
        let custom = question_answer_input(&questions, &[vec![]], &[Some("A custom scope".into())])
            .expect("custom answer");
        assert!(custom.ends_with("\x1b[B\x1b[B\rA custom scope\r"));
    }
}
