//! The LAN WebSocket listener: per-device streaming of terminal output.

use serde_json::{json, Value};
use std::net::{TcpListener, TcpStream};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{accept_hdr, Message};

use crate::pty::PtySessions;

use super::pty_bridge::{read_pty_size, read_scrollback};
use super::{
    ConnectionGuard, RemoteHub, MAX_MESSAGE, MAX_SCROLLBACK, SOCKET_TIMEOUT, WS_AUTH_TIMEOUT,
};

pub(crate) fn run_websocket(
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
                thread::sleep(Duration::from_millis(50));
                continue;
            }
            Err(_) => break,
        };
        let Some(guard) = ConnectionGuard::acquire(&hub) else {
            continue;
        };
        let hub = Arc::clone(&hub);
        let sessions = Arc::clone(&sessions);
        let address = stream
            .peer_addr()
            .map(|address| address.to_string())
            .unwrap_or_else(|_| "Unknown device".into());
        thread::spawn(move || {
            let _guard = guard;
            handle_websocket(stream, hub, sessions, generation, address);
        });
    }
    // Reached with the generation still live only when the listener itself
    // died; never leave remote control half up with one listener gone.
    if super::stop_generation(&hub, generation) {
        eprintln!("[remote] LAN WebSocket listener stopped unexpectedly");
        let _ = app.emit("remote://start-failed", ());
    }
}

/// Sends what was queued for device `id`, checking before every send that
/// the device may still receive. Once it may not, the queue is dropped unsent
/// and only the reason goes out; returns false, as the socket has to close.
fn flush_queue(
    hub: &RemoteHub,
    id: usize,
    rx: &mpsc::Receiver<String>,
    mut send: impl FnMut(String) -> bool,
) -> bool {
    loop {
        if let Some(reason) = refusal(hub, id) {
            while rx.try_recv().is_ok() {}
            send(reason);
            return false;
        }
        let Ok(payload) = rx.try_recv() else {
            return true;
        };
        if !send(payload) {
            return false;
        }
    }
}

/// Why device `id` may receive nothing right now: its session ended, or it
/// must enter the PIN, which includes a PIN-free week that ran out.
fn refusal(hub: &RemoteHub, id: usize) -> Option<String> {
    if !hub.session_alive(id) {
        return Some(
            json!({ "type": "error", "reason": "expired", "message": "Remote session expired" })
                .to_string(),
        );
    }
    hub.session_locked(id).then(|| {
        json!({ "type": "error", "reason": "pin_required", "message": "PIN required" }).to_string()
    })
}

fn allowed_origin(hub: &RemoteHub) -> String {
    format!("http://{}:{}", hub.host(), hub.http_port())
}

fn handle_websocket(
    stream: TcpStream,
    hub: Arc<RemoteHub>,
    sessions: PtySessions,
    generation: u64,
    address: String,
) {
    if hub.auth_blocked(&address) {
        return;
    }
    let _ = stream.set_read_timeout(Some(SOCKET_TIMEOUT));
    let _ = stream.set_write_timeout(Some(SOCKET_TIMEOUT));
    let expected_origin = allowed_origin(&hub);
    let handshake = accept_hdr(
        stream,
        |request: &Request, response: Response| match request
            .headers()
            .get("Origin")
            .and_then(|value| value.to_str().ok())
        {
            None => Ok(response),
            Some(origin) if origin == expected_origin => Ok(response),
            Some(_) => Err(ErrorResponse::new(Some("Origin not allowed".into()))),
        },
    );
    let mut socket = match handshake {
        Ok(socket) => socket,
        Err(_) => return,
    };
    let _ = socket.get_mut().set_nonblocking(true);
    let (tx, rx) = mpsc::channel::<String>();
    let opened_at = Instant::now();
    let mut session_id: Option<usize> = None;
    loop {
        if !hub.is_active(generation) {
            break;
        }
        if session_id.is_none() && opened_at.elapsed() > WS_AUTH_TIMEOUT {
            break;
        }
        if let Some(id) = session_id {
            let open = flush_queue(&hub, id, &rx, |payload| {
                socket.send(Message::Text(payload.into())).is_ok()
            });
            if !open {
                break;
            }
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                if text.len() > MAX_MESSAGE {
                    break;
                }
                let Ok(command) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                let provided = command
                    .get("sessionToken")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let Some(id) = hub.session_id_for(provided) else {
                    // A session that expires mid-connection is not a failed
                    // attempt: counting it would lock out the paired device.
                    if session_id.is_none() {
                        hub.record_auth_failure(&address);
                    }
                    let _ = socket.send(Message::Text(
                        json!({ "type": "error", "reason": "unauthorized", "message": "Remote session is not valid" })
                            .to_string()
                            .into(),
                    ));
                    break;
                };
                if hub.session_locked(id) {
                    let _ = socket.send(Message::Text(
                        json!({ "type": "error", "reason": "pin_required", "message": "PIN required" })
                            .to_string()
                            .into(),
                    ));
                    break;
                }
                hub.refresh_trust(id);
                if session_id.is_none() {
                    hub.clear_auth_failures(&address);
                    if let Some(name) = command.get("deviceName").and_then(Value::as_str) {
                        hub.rename_device(id, name.chars().take(48).collect());
                    }
                    hub.attach_sender(id, tx.clone());
                    session_id = Some(id);
                    let _ = socket.send(Message::Text(
                        json!({ "type": "authenticated" }).to_string().into(),
                    ));
                }
                if command.get("type").and_then(Value::as_str) == Some("subscribe") {
                    let pty_id = command.get("ptyId").and_then(Value::as_str);
                    hub.set_subscription(id, pty_id.map(str::to_string));
                    if let Some(pty_id) = pty_id {
                        let scrollback = read_scrollback(&sessions, pty_id, MAX_SCROLLBACK);
                        let (cols, rows) = read_pty_size(&sessions, pty_id).unwrap_or((80, 24));
                        let payload = json!({
                            "type": "scrollback",
                            "ptyId": pty_id,
                            "text": scrollback,
                            "cols": cols,
                            "rows": rows,
                        });
                        let _ = socket.send(Message::Text(payload.to_string().into()));
                    }
                }
            }
            Err(tungstenite::Error::Io(error))
                if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(tungstenite::Error::ConnectionClosed) => break,
            Err(_) => break,
            _ => {}
        }
        thread::sleep(Duration::from_millis(16));
    }
    if let Some(session_id) = session_id {
        hub.detach_sender(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::flush_queue;
    use crate::remote::RemoteHub;
    use std::sync::mpsc;

    #[test]
    fn a_locked_socket_gets_only_pin_required() {
        let (hub, id) = RemoteHub::paired_for_test();
        let (tx, rx) = mpsc::channel();
        tx.send("terminal output".to_string()).unwrap();
        tx.send("more output".to_string()).unwrap();
        hub.expire_trust_for_test(id);
        let mut sent = Vec::new();
        let open = flush_queue(&hub, id, &rx, |payload| {
            sent.push(payload);
            true
        });
        assert!(!open);
        assert_eq!(sent.len(), 1, "{sent:?}");
        assert!(sent[0].contains("pin_required"));
        assert!(rx.try_recv().is_err());
    }
}
