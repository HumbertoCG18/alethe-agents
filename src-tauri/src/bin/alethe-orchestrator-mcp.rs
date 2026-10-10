//! Standalone stdio build of Alethe's orchestrator MCP server.
//!
//! Runs the same core the desktop app hosts over HTTP, so any MCP client can delegate to Codex
//! workers without Alethe being open. The core is compiled in directly rather than linked from
//! `alethe_lib`, which keeps this binary free of the GUI stack.
//!
//! Environment:
//!   ALETHE_CODEX   path to the codex launcher, otherwise resolved from PATH
//!   ALETHE_MAX_WORKERS  how many workers may run at once, default 4

#[path = "../orchestrator_core.rs"]
#[allow(dead_code)]
mod orchestrator_core;

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::Command;

use orchestrator_core::{handle_mcp_body, Core, Launcher};

fn resolve_codex() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("ALETHE_CODEX") {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return Some(path);
        }
    }
    let finder = if cfg!(windows) { "where" } else { "which" };
    let output = Command::new(finder).arg("codex").output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let candidates: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if cfg!(windows) {
        windows_launcher(&candidates).map(PathBuf::from)
    } else {
        candidates.first().map(PathBuf::from)
    }
}

/// The launcher to run out of `where codex`'s matches, which come in PATH order. As in the app's
/// resolver, the first directory holding a launcher wins and, within it, an `.exe` beats the
/// `.cmd` npm drops next to it, which runs under cmd.exe and rewrites `%VAR%` and quotes in the
/// arguments. Split on both separators so the test reads the same on every platform.
fn windows_launcher<'a>(matches: &[&'a str]) -> Option<&'a str> {
    let rank = |line: &str| {
        let extension = line.rsplit_once('.')?.1;
        ["exe", "cmd", "bat"]
            .iter()
            .position(|known| extension.eq_ignore_ascii_case(known))
    };
    let dir = |line: &'a str| line.rsplit_once(['\\', '/']).map_or("", |(dir, _)| dir);
    let Some(first) = matches.iter().find(|line| rank(line).is_some()) else {
        return matches.first().copied();
    };
    matches
        .iter()
        .filter(|line| dir(line) == dir(first))
        .filter_map(|line| Some((rank(line)?, *line)))
        .min_by_key(|(rank, _)| *rank)
        .map(|(_, line)| line)
}

fn main() {
    let core = Core::default();

    match resolve_codex() {
        Some(program) => {
            let mut launcher = Launcher::codex_app_server(program);
            if cfg!(windows) {
                if let Ok(path) = std::env::var("PATH") {
                    launcher.env.push((
                        "Path".to_string(),
                        orchestrator_core::path_without_store_aliases(&path),
                    ));
                }
            }
            core.set_launcher(launcher);
        }
        None => eprintln!("[alethe-orchestrator] codex not found on PATH; delegation will fail"),
    }

    if let Some(limit) = std::env::var("ALETHE_MAX_WORKERS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
    {
        core.set_concurrency_limit(limit);
    }

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_mcp_body(&core, &line, None) {
            if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::windows_launcher;

    #[test]
    fn where_matches_resolve_like_the_app_launcher() {
        // npm writes an extensionless shell script, which Windows cannot start, beside its `.cmd`.
        let npm = [r"C:\npm\codex", r"C:\npm\codex.cmd"];
        let both = [r"C:\npm\codex", r"C:\npm\codex.cmd", r"C:\npm\codex.EXE"];
        let earlier_cmd = [r"C:\npm\codex", r"C:\npm\codex.cmd", r"D:\native\codex.exe"];

        assert_eq!(windows_launcher(&both), Some(r"C:\npm\codex.EXE"));
        assert_eq!(windows_launcher(&npm), Some(r"C:\npm\codex.cmd"));
        // PATH order still wins over the extension.
        assert_eq!(windows_launcher(&earlier_cmd), Some(r"C:\npm\codex.cmd"));
        assert_eq!(
            windows_launcher(&[r"C:\tools\codex"]),
            Some(r"C:\tools\codex")
        );
        assert_eq!(windows_launcher(&[]), None);
    }
}
