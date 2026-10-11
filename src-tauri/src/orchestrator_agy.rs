//! The agy agent an Antigravity worker runs as, and the gate its `PreToolUse` hook calls.
//!
//! Plain `std` + `serde_json` + `sha2`, like `orchestrator_core`: the standalone
//! `alethe-orchestrator-mcp` binary (whose `agy-gate` subcommand is the hook) and
//! `tests/orchestrator.rs` compile this file too.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// The agy agent, and the agy project, Alethe's workers run under.
pub const AGY_AGENT: &str = "alethe-worker";

/// No `excludeDefaultComponents`: it drops the working folder from the agent's context (measured,
/// agy 1.3.3). With `inheritCustomizations` and `inheritMcp` off, the person's own agy hooks and
/// GEMINI.md stay out of the worker (measured), and so do their MCP servers (self-reported by the
/// model), while the agent's own `hooks:` still load (measured). `tools:` replaces agy's default
/// set: names measured to run in a custom agent, and the search tools agy's changelog keeps
/// "available to custom agents" that list them. A name agy does not know stops the worker at
/// start-up (`command_status`, measured). No command tool: an allowed `git status` still runs the
/// worktree's own git config, which the worker can write.
const AGENT_MD: &str = "---
name: alethe-worker
description: Alethe implementation worker. Reads and edits files in its working directory and runs no commands.
inheritCustomizations: false
inheritMcp: false
tools:
  - view_file
  - list_dir
  - find_by_name
  - grep_search
  - write_to_file
  - replace_file_content
hooks:
  - hooks.json
---

# Instructions

You are an Alethe implementation worker. Alethe sends you one task per turn: do it, then reply with what you did.

- Work only inside your working directory. Do not read or write anything outside it.
- You cannot run any command: no git, tests, builds or package scripts. The coordinator runs them after your turn.
- Say in your reply what should run and what to check.
";

/// Characters cmd.exe reads as more than part of a path.
const SHELL_CHARACTERS: [char; 16] = [
    ';', '&', '|', '`', '$', '(', ')', '<', '>', '#', '"', '\'', '\n', '\r', '%', '^',
];

/// Two workers starting together would write the same temporary files.
static INSTALLING: Mutex<()> = Mutex::new(());

/// Where Alethe keeps the agent agy loads with `--agent alethe-worker`.
#[derive(Clone, Debug)]
pub struct AgyAgent {
    /// agy's config folder, `~/.gemini/config`. The agent goes in `agents/alethe-worker` under it.
    pub config_dir: PathBuf,
    /// The `alethe-orchestrator-mcp` build copied into the agent folder as the gate.
    pub gate_source: PathBuf,
}

/// The SHA-256 of each managed file as Alethe installed it.
#[derive(Clone, Debug, PartialEq)]
pub struct AgyPin(Vec<(PathBuf, [u8; 32])>);

impl AgyAgent {
    /// Writes `agent.md`, `hooks.json` and the gate into the agent folder wherever they are missing
    /// or differ, and pins what they should hold. Nothing is written when the hook command could
    /// not name its paths unquoted.
    pub fn install(&self) -> Result<AgyPin, String> {
        let dir = self.config_dir.join("agents").join(AGY_AGENT);
        let name = self
            .gate_source
            .file_name()
            .ok_or_else(|| format!("{} names no file", self.gate_source.display()))?;
        let gate = dir.join(name);
        let hook = json!({
            "type": "command",
            "command": format!("{} agy-gate", unquoted(&gate)?),
            "timeout": 30
        });
        // The agent lists no command tool; the gate stays as a second line should agy ever offer
        // one. A matcher per tool rather than the documented alternation (`a\|b`), which is not
        // valid JSON as written and was never measured. Other tools never reach the gate, so agy's
        // own checks stay in charge of them.
        let hooks = json!({
            "alethe-worker-gate": {
                "PreToolUse": [
                    { "matcher": "run_command", "hooks": [hook] },
                    { "matcher": "send_command_input", "hooks": [hook] }
                ]
            }
        });
        let gate_bytes = fs::read(&self.gate_source).map_err(|error| {
            format!(
                "cannot read the gate build {}: {error}",
                self.gate_source.display()
            )
        })?;
        let files = [
            (dir.join("agent.md"), AGENT_MD.as_bytes().to_vec()),
            (
                dir.join("hooks.json"),
                serde_json::to_vec_pretty(&hooks).map_err(|error| error.to_string())?,
            ),
            (gate, gate_bytes),
        ];
        let _installing = INSTALLING
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        fs::create_dir_all(&dir)
            .map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
        let mut pinned = Vec::new();
        for (path, bytes) in files {
            if fs::read(&path).ok().as_deref() != Some(bytes.as_slice()) {
                write_atomic(&path, &bytes)?;
            }
            pinned.push((path, Sha256::digest(&bytes).into()));
        }
        Ok(AgyPin(pinned))
    }
}

impl AgyPin {
    /// Whether every managed file still holds what was installed.
    pub fn verify(&self) -> Result<(), String> {
        for (path, expected) in &self.0 {
            let bytes = fs::read(path)
                .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
            if Sha256::digest(&bytes).as_slice() != expected.as_slice() {
                return Err(format!(
                    "{} changed after Alethe installed it",
                    path.display()
                ));
            }
        }
        Ok(())
    }
}

/// agy runs the hook command through `cmd /c` and mangles a quoted path (measured, agy 1.3.3), so
/// every path in it has to stand unquoted.
fn unquoted(path: &Path) -> Result<String, String> {
    let text = path.to_string_lossy().into_owned();
    if text
        .chars()
        .any(|c| c.is_whitespace() || SHELL_CHARACTERS.contains(&c))
    {
        return Err(format!(
            "{text} has a space or a shell character, and agy runs its hook command unquoted, so the Antigravity worker does not start without its gate"
        ));
    }
    Ok(text)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    fs::write(&temp, bytes)
        .and_then(|()| fs::rename(&temp, path))
        .map_err(|error| {
            let _ = fs::remove_file(&temp);
            format!("cannot write {}: {error}", path.display())
        })
}

/// The agy tools that run a command.
const COMMAND_TOOLS: [&str; 2] = ["run_command", "send_command_input"];

/// What the gate answers one `PreToolUse` call: `Ok` leaves the tool to agy's own checks, `Err`
/// denies it with the reason the worker reads. A hook deny fails only that step, so the turn goes
/// on (measured, agy 1.3.3). Every command is denied: agy runs an allowed line as it is, and even
/// `git status` runs what the worktree's git config names, which the worker can write.
pub fn agy_gate_decision(payload: &Value) -> Result<(), String> {
    let tool = payload
        .pointer("/toolCall/name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if tool.is_empty() {
        return Err("the hook call names no tool, so it cannot be checked".into());
    }
    if COMMAND_TOOLS.contains(&tool) {
        return Err(
            "Alethe workers run no commands. The coordinator runs git, tests and builds after your turn; say in your reply what should run"
                .into(),
        );
    }
    Ok(())
}

/// The `agy-gate` subcommand: one hook payload on `input`, one decision for agy's stdout. Anything
/// it cannot read is a deny, never a pass.
pub fn agy_gate_reply(mut input: impl Read) -> Value {
    let mut text = String::new();
    let decision = input
        .read_to_string(&mut text)
        .map_err(|error| error.to_string())
        .and_then(|_| serde_json::from_str::<Value>(&text).map_err(|error| error.to_string()))
        .map_err(|error| format!("the hook call could not be read: {error}"))
        .and_then(|payload| agy_gate_decision(&payload));
    match decision {
        Ok(()) => json!({ "decision": "allow", "reason": "Alethe gate: allowed" }),
        Err(reason) => json!({ "decision": "deny", "reason": format!("Alethe gate: {reason}") }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-agy-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed");
    }

    /// A repository with `package.json`, `Cargo.toml` and a source file committed.
    fn repo(tag: &str) -> PathBuf {
        let dir = temp(tag);
        git(&dir, &["init", "-q"]);
        git(&dir, &["config", "user.email", "lab@example.com"]);
        git(&dir, &["config", "user.name", "lab"]);
        fs::write(dir.join("package.json"), "{}\n").expect("package.json");
        fs::write(dir.join("Cargo.toml"), "[package]\n").expect("Cargo.toml");
        fs::create_dir_all(dir.join("src")).expect("src");
        fs::write(dir.join("src").join("main.ts"), "export {}\n").expect("main.ts");
        fs::write(dir.join(".gitignore"), "ignored/\n").expect(".gitignore");
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "seed"]);
        dir
    }

    fn run(line: &str, cwd: &Path) -> Value {
        json!({
            "toolCall": { "name": "run_command", "args": { "CommandLine": line, "Cwd": cwd } },
            "workspacePaths": [cwd]
        })
    }

    // ------------------------------------------------------------------ the gate

    #[test]
    fn the_gate_leaves_tools_that_run_no_command_to_agy() {
        let payload = json!({
            "toolCall": { "name": "write_to_file", "args": { "TargetFile": "x.txt" } }
        });
        assert_eq!(agy_gate_decision(&payload), Ok(()));
    }

    /// An index older than its files makes git compare their content, through any clean filter.
    fn age_index(dir: &Path) {
        let index = fs::File::options()
            .write(true)
            .open(dir.join(".git").join("index"))
            .expect("index");
        index
            .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600))
            .expect("age the index");
    }

    #[test]
    fn the_gate_denies_every_command_even_an_allowed_git_line() {
        // agy runs an allowed line as it is, and git runs the worktree's own config and hooks.
        let dir = repo("no-commands");
        let lines = [
            "git status",
            r".\tools\git.cmd status",
            "npm test",
            "cargo test --manifest-path src-tauri/Cargo.toml",
        ];
        for line in lines {
            let denied = agy_gate_decision(&run(line, &dir)).expect_err(&format!("`{line}` ran"));
            assert!(denied.contains("run no commands"), "{line}: {denied}");
            assert!(denied.contains("coordinator"), "{line}: {denied}");
        }
        let input =
            json!({ "toolCall": { "name": "send_command_input", "args": { "Input": "y" } } });
        let denied = agy_gate_decision(&input).unwrap_err();
        assert!(denied.contains("run no commands"), "{denied}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_gate_runs_nothing_in_a_hostile_repository() {
        // The gate sits outside agy's sandbox, and the worker can write `.git/config`.
        let dir = repo("hostile-project-code");
        git(
            &dir,
            &["config", "core.fsmonitor", "touch .git/fsmonitor-ran"],
        );
        git(
            &dir,
            &["config", "filter.evil.clean", "touch .git/filter-ran; cat"],
        );
        fs::write(dir.join(".gitattributes"), "* filter=evil\n").expect("attributes");
        age_index(&dir);
        let ran = |name: &str| dir.join(".git").join(name).exists();
        let denied = agy_gate_decision(&run("git status", &dir));
        assert!(denied.is_err(), "git status ran");
        assert!(
            !ran("fsmonitor-ran") && !ran("filter-ran"),
            "the gate ran git"
        );
        // Plain git does run that config, so the markers above mean something.
        let _ = Command::new("git")
            .args(["diff-index", "--name-only", "HEAD", "--"])
            .current_dir(&dir)
            .output();
        assert!(
            ran("fsmonitor-ran") || ran("filter-ran"),
            "the setup runs nothing"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_hook_call_that_names_no_tool_is_denied() {
        for payload in [
            json!(null),
            json!({}),
            json!({ "toolCall": {} }),
            json!({ "toolCall": { "name": "" } }),
            json!({ "toolCall": { "name": 5 } }),
        ] {
            let denied = agy_gate_decision(&payload).expect_err(&format!("{payload} passed"));
            assert!(denied.contains("tool"), "{denied}");
        }
    }

    #[test]
    fn the_hook_reply_carries_a_decision_and_a_reason() {
        let payload = run("git status", &std::env::temp_dir()).to_string();
        let denied = agy_gate_reply(payload.as_bytes());
        assert_eq!(denied["decision"], "deny", "{denied}");
        assert!(denied["reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("run no commands")));
        let read = json!({ "toolCall": { "name": "view_file", "args": {} } }).to_string();
        assert_eq!(agy_gate_reply(read.as_bytes())["decision"], "allow");
        // Anything it cannot read is a refusal, never a pass.
        assert_eq!(agy_gate_reply("not json".as_bytes())["decision"], "deny");
    }

    // ------------------------------------------------------------------ the managed agent

    fn agent(tag: &str) -> (PathBuf, AgyAgent) {
        let root = temp(tag);
        let gate_source = root.join("build").join("alethe-orchestrator-mcp.exe");
        fs::create_dir_all(gate_source.parent().expect("parent")).expect("build dir");
        fs::write(&gate_source, b"gate build 1").expect("gate");
        let agent = AgyAgent {
            config_dir: root.join("config"),
            gate_source,
        };
        (root, agent)
    }

    #[test]
    fn installing_writes_the_agent_its_hooks_and_the_gate() {
        let (root, agent) = agent("install");
        agent.install().expect("install");
        let dir = root.join("config").join("agents").join(AGY_AGENT);

        let manifest = fs::read_to_string(dir.join("agent.md")).expect("agent.md");
        assert!(
            manifest.starts_with("---\nname: alethe-worker\n"),
            "{manifest}"
        );
        for line in [
            "inheritCustomizations: false",
            "inheritMcp: false",
            "hooks:\n  - hooks.json",
            "  - view_file",
            "  - list_dir",
            "  - find_by_name",
            "  - write_to_file",
            "  - replace_file_content",
            "  - grep_search",
        ] {
            assert!(manifest.contains(line), "{line:?} missing from\n{manifest}");
        }
        // It drops cwd context (measured), and the worker needs to know where it works.
        assert!(!manifest.contains("excludeDefaultComponents"), "{manifest}");
        // agy 1.3.3 refuses to start a custom agent that lists `command_status`: "tool not found
        // in registry" (measured). Background commands go through `manage_task`, a default.
        // No command tool at all: the coordinator runs git, tests and builds.
        for tool in ["run_command", "send_command_input", "command_status"] {
            assert!(!manifest.contains(tool), "{tool} in\n{manifest}");
        }
        assert!(manifest.contains("cannot run any command"), "{manifest}");

        let gate = dir.join("alethe-orchestrator-mcp.exe");
        assert_eq!(fs::read(&gate).expect("gate"), b"gate build 1");
        let hooks: Value =
            serde_json::from_slice(&fs::read(dir.join("hooks.json")).expect("hooks.json"))
                .expect("json");
        let groups = hooks["alethe-worker-gate"]["PreToolUse"]
            .as_array()
            .expect("PreToolUse groups");
        let matchers: Vec<&str> = groups
            .iter()
            .filter_map(|group| group["matcher"].as_str())
            .collect();
        assert_eq!(matchers, ["run_command", "send_command_input"]);
        for group in groups {
            // Unquoted: agy mangles a quoted path (measured).
            assert_eq!(
                group["hooks"][0]["command"],
                format!("{} agy-gate", gate.display()),
                "{hooks}"
            );
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn installing_again_rewrites_only_what_changed() {
        let (root, agent) = agent("reinstall");
        let first = agent.install().expect("install");
        let dir = root.join("config").join("agents").join(AGY_AGENT);
        let modified = |name: &str| {
            fs::metadata(dir.join(name))
                .and_then(|meta| meta.modified())
                .ok()
        };
        let before: Vec<_> = ["agent.md", "hooks.json", "alethe-orchestrator-mcp.exe"]
            .iter()
            .map(|name| modified(name))
            .collect();
        assert_eq!(agent.install().expect("again"), first);
        let after: Vec<_> = ["agent.md", "hooks.json", "alethe-orchestrator-mcp.exe"]
            .iter()
            .map(|name| modified(name))
            .collect();
        assert_eq!(before, after, "an unchanged file was written again");

        fs::write(dir.join("hooks.json"), "{}").expect("tamper");
        assert_eq!(agent.install().expect("repair"), first);
        assert!(fs::read_to_string(dir.join("hooks.json"))
            .expect("hooks")
            .contains("agy-gate"));

        // A new build of the gate is copied over and pinned instead of the old one.
        fs::write(&agent.gate_source, b"gate build 2").expect("rebuild");
        let rebuilt = agent.install().expect("rebuilt");
        assert_ne!(rebuilt, first);
        assert_eq!(
            fs::read(dir.join("alethe-orchestrator-mcp.exe")).expect("gate"),
            b"gate build 2"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_pin_catches_any_managed_file_that_changed() {
        let (root, agent) = agent("verify");
        let pin = agent.install().expect("install");
        assert_eq!(pin.verify(), Ok(()));
        let dir = root.join("config").join("agents").join(AGY_AGENT);
        for name in ["agent.md", "hooks.json", "alethe-orchestrator-mcp.exe"] {
            let path = dir.join(name);
            let original = fs::read(&path).expect("read");
            fs::write(&path, b"changed").expect("tamper");
            let error = pin.verify().unwrap_err();
            assert!(error.contains(name), "{error}");
            fs::remove_file(&path).expect("remove");
            assert!(pin.verify().unwrap_err().contains(name));
            fs::write(&path, original).expect("restore");
            assert_eq!(pin.verify(), Ok(()));
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_agent_folder_the_hook_cannot_name_unquoted_is_refused() {
        let root = temp("spaced");
        let gate_source = root.join("alethe-orchestrator-mcp.exe");
        fs::write(&gate_source, b"gate").expect("gate");
        let agent = AgyAgent {
            config_dir: root.join("John Smith").join("config"),
            gate_source,
        };
        let error = agent.install().unwrap_err();
        assert!(error.contains("space"), "{error}");
        assert!(
            !root.join("John Smith").exists(),
            "it wrote before refusing"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_gate_build_is_an_error() {
        let root = temp("no-gate");
        let agent = AgyAgent {
            config_dir: root.join("config"),
            gate_source: root.join("alethe-orchestrator-mcp.exe"),
        };
        let error = agent.install().unwrap_err();
        assert!(error.contains("alethe-orchestrator-mcp"), "{error}");
        let _ = fs::remove_dir_all(&root);
    }
}
