//! Reads scrollback from and writes prompts into live PTY sessions on behalf
//! of the remote HTTP/WebSocket handlers.

use std::sync::Arc;

use crate::pty::{write_input, PtySessions, Writer};

pub(crate) fn read_scrollback(sessions: &PtySessions, id: &str, max_bytes: usize) -> String {
    if let Ok(sessions) = sessions.lock() {
        if let Some(session) = sessions.get(id) {
            if let Ok(mut buffer) = session.scrollback.lock() {
                let data = buffer.data.make_contiguous();
                let start =
                    crate::pty::align_to_char_boundary(data, data.len().saturating_sub(max_bytes));
                return String::from_utf8_lossy(&data[start..]).into_owned();
            }
        }
    }
    String::new()
}

pub(crate) fn read_pty_size(sessions: &PtySessions, id: &str) -> Option<(u16, u16)> {
    let master = {
        let sessions = sessions.lock().ok()?;
        Arc::clone(&sessions.get(id)?.master)
    };
    let master = master.lock().ok()?;
    let size = master.get_size().ok()?;
    Some((size.cols, size.rows))
}

/// Writes for the paired device `device`, counted as its input.
pub(crate) fn write_remote(
    sessions: &PtySessions,
    id: &str,
    device: usize,
    data: &str,
) -> Result<(), String> {
    write_input(sessions, id, Writer::Device(device), data)
}
