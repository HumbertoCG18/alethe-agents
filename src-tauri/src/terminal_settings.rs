use std::path::{Path, PathBuf};

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShellOption {
    pub id: String,
    /// Shell family the UI names: pwsh, pwshStore, powershell, cmd, wsl, gitBash, or the executable.
    pub kind: String,
    /// The shell used when no choice is saved.
    pub is_default: bool,
}

fn under(path: &str, dir: &str) -> bool {
    path.to_lowercase()
        .replace('/', "\\")
        .contains(&format!("\\{dir}\\"))
}

/// Git for Windows' bash, which needs a login shell to load its profile.
pub(crate) fn is_git_bash(path: &str) -> bool {
    cfg!(windows)
        && Path::new(path)
            .file_stem()
            .is_some_and(|stem| stem.eq_ignore_ascii_case("bash"))
        && under(path, "git")
}

fn shell_kind(name: &str, id: &str) -> String {
    if cfg!(windows) {
        if name == "pwsh" && under(id, "windowsapps") {
            return "pwshStore".into();
        }
        if name == "bash" && under(id, "system32") {
            return "wsl".into();
        }
        if is_git_bash(id) {
            return "gitBash".into();
        }
    }
    name.into()
}

fn push_shell(shells: &mut Vec<ShellOption>, binary: PathBuf, name: &str) {
    let id = crate::cli_launch::strip_verbatim_prefix(binary)
        .to_string_lossy()
        .into_owned();
    if shells.iter().any(|item| {
        if cfg!(windows) {
            item.id.eq_ignore_ascii_case(&id)
        } else {
            item.id == id
        }
    }) {
        return;
    }
    shells.push(ShellOption {
        kind: shell_kind(name, &id),
        id,
        is_default: false,
    });
}

/// Git Bash usually lives outside PATH: only `Git\cmd` is added by its installer.
#[cfg(windows)]
fn git_bash_candidates(path: &str, cwd: &Path) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|var| std::env::var(var).ok())
        .map(|root| PathBuf::from(root).join(r"Git\bin\bash.exe"))
        .collect();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join(r"Programs\Git\bin\bash.exe"));
    }
    // git.exe sits in <root>\cmd; the matching bash is <root>\bin\bash.exe.
    if let Some(root) = which::which_in("git", Some(path), cwd)
        .ok()
        .and_then(|git| git.parent()?.parent().map(Path::to_path_buf))
    {
        candidates.push(root.join(r"bin\bash.exe"));
    }
    candidates
}

fn shells_on_path() -> Vec<ShellOption> {
    let mut shells = Vec::new();
    let path = if cfg!(windows) {
        crate::cli_resolver::rebuilt_path()
    } else {
        std::env::var("PATH").unwrap_or_default()
    };
    let cwd = std::env::current_dir().unwrap_or_default();
    for name in [
        "pwsh",
        "powershell",
        "cmd",
        "bash",
        "zsh",
        "fish",
        "sh",
        "dash",
        "ksh",
        "nu",
        "elvish",
    ] {
        // Every install, e.g. PowerShell 7 from both the MSI and the Microsoft Store.
        let Ok(found) = which::which_in_all(name, Some(&path), &cwd) else {
            continue;
        };
        for binary in found {
            push_shell(&mut shells, binary, name);
        }
    }
    #[cfg(windows)]
    for candidate in git_bash_candidates(&path, &cwd) {
        if candidate.is_file() {
            push_shell(&mut shells, candidate, "bash");
        }
    }
    if let Ok(default) = which::which_in(crate::cli_resolver::default_shell(), Some(&path), &cwd) {
        let default = crate::cli_launch::strip_verbatim_prefix(default)
            .to_string_lossy()
            .into_owned();
        if let Some(item) = shells
            .iter_mut()
            .find(|item| item.id.eq_ignore_ascii_case(&default))
        {
            item.is_default = true;
        }
    }
    shells
}

pub(crate) fn resolve_shell(selected: Option<&str>) -> Option<String> {
    // The rule `pty.rs` applies to a plain tab's override: a real file, never a command line.
    let selected = selected?.trim();
    (Path::new(selected).is_absolute() && Path::new(selected).is_file()).then(|| selected.to_string())
}

#[tauri::command]
pub async fn discover_shells() -> Result<Vec<ShellOption>, String> {
    tokio::task::spawn_blocking(|| {
        crate::cli_resolver::invalidate_rebuilt_path();
        shells_on_path()
    })
    .await
    .map_err(|e| e.to_string())
}

fn normalize_families(mut families: Vec<String>) -> Vec<String> {
    families = families
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| {
            !name.is_empty() && !name.starts_with('@') && !name.chars().any(char::is_control)
        })
        .collect();
    families.sort_by_key(|name| name.to_lowercase());
    families.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    families
}

#[cfg(windows)]
fn windows_fonts() -> Result<Vec<String>, String> {
    use windows_sys::Win32::Graphics::Gdi::*;
    unsafe extern "system" fn collect(
        font: *const LOGFONTW,
        _: *const TEXTMETRICW,
        _: u32,
        data: isize,
    ) -> i32 {
        let families = &mut *(data as *mut Vec<String>);
        let face = &(*font).lfFaceName;
        let length = face.iter().position(|&ch| ch == 0).unwrap_or(face.len());
        families.push(String::from_utf16_lossy(&face[..length]));
        1
    }
    unsafe {
        let dc = GetDC(std::ptr::null_mut());
        if dc.is_null() {
            return Err("Could not open font enumeration context".into());
        }
        let mut font: LOGFONTW = std::mem::zeroed();
        font.lfCharSet = DEFAULT_CHARSET;
        let mut families = Vec::<String>::new();
        EnumFontFamiliesExW(
            dc,
            &font,
            Some(collect),
            &mut families as *mut _ as isize,
            0,
        );
        ReleaseDC(std::ptr::null_mut(), dc);
        Ok(normalize_families(families))
    }
}

#[tauri::command]
pub async fn installed_font_families(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        let _ = app;
        tokio::task::spawn_blocking(windows_fonts)
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(target_os = "macos")]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let result = objc2::MainThreadMarker::new()
                .ok_or("Font enumeration needs the main thread".to_string())
                .map(|mtm| {
                    let manager = objc2_app_kit::NSFontManager::sharedFontManager(mtm);
                    normalize_families(
                        manager
                            .availableFontFamilies()
                            .iter()
                            .map(|family| family.to_string())
                            .collect(),
                    )
                });
            let _ = send.send(result);
        })
        .map_err(|e| e.to_string())?;
        receive.await.map_err(|e| e.to_string())?
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app;
        let binary = which::which("fc-list").map_err(|_| "Fontconfig is not installed")?;
        let output = crate::cli_resolver::background_output(
            &binary,
            &["--format", "%{family[0]}\n"],
            std::time::Duration::from_secs(5),
        )
        .await?;
        Ok(normalize_families(
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::to_string)
                .collect(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_command_lines_and_unknown_paths() {
        assert!(resolve_shell(Some("cmd /c whoami")).is_none());
        assert!(resolve_shell(Some("/missing/bash")).is_none());
        for shell in shells_on_path() {
            assert_eq!(resolve_shell(Some(&shell.id)), Some(shell.id));
        }
    }
    #[test]
    fn plain_terminals_use_the_selected_shell_but_agent_launchers_keep_their_shell() {
        let shell = shells_on_path()
            .into_iter()
            .next()
            .expect("An installed shell");
        // A plain tab's shell arrives as the launcher override `pty.rs` already checked.
        let plain =
            crate::cli_resolver::command_builder_for_terminal(None, Some(&shell.id), &[], None);
        assert_eq!(plain.get_argv()[0].to_string_lossy(), shell.id);
        let agent = crate::cli_resolver::command_builder_for_terminal(Some("claude"), None, &[], None);
        assert_eq!(
            agent.get_argv()[0].to_string_lossy(),
            crate::cli_resolver::default_shell()
        );
    }
    #[cfg(windows)]
    #[test]
    fn names_windows_shell_families_by_location() {
        let kind = |name, id| shell_kind(name, id);
        assert_eq!(kind("pwsh", r"C:\Program Files\PowerShell\7\pwsh.exe"), "pwsh");
        assert_eq!(
            kind("pwsh", r"C:\Users\me\AppData\Local\Microsoft\WindowsApps\pwsh.exe"),
            "pwshStore"
        );
        assert_eq!(
            kind("powershell", r"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe"),
            "powershell"
        );
        assert_eq!(kind("cmd", r"C:\WINDOWS\system32\cmd.exe"), "cmd");
        assert_eq!(kind("bash", r"C:\WINDOWS\system32\bash.exe"), "wsl");
        assert_eq!(kind("bash", r"C:\Program Files\Git\bin\bash.exe"), "gitBash");
        assert_eq!(kind("bash", r"C:\msys64\usr\bin\bash.exe"), "bash");
        let found = shells_on_path().into_iter().find(|s| s.kind == "gitBash");
        let git_bash = crate::cli_resolver::command_builder_for_terminal(
            None,
            found.as_ref().map(|s| s.id.as_str()),
            &[],
            None,
        );
        if git_bash.get_argv()[0].to_string_lossy().ends_with("bash.exe") {
            let args: Vec<_> = git_bash.get_argv()[1..]
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            assert_eq!(args, ["-i", "-l"]);
        }
    }
    #[test]
    fn families_are_trimmed_sorted_deduplicated_and_skip_vertical_faces() {
        assert_eq!(
            normalize_families(vec![
                " Zeta ".into(),
                "alpha".into(),
                "ALPHA".into(),
                "@Vertical".into(),
                "".into()
            ]),
            vec!["alpha", "Zeta"]
        );
    }
    #[cfg(windows)]
    #[test]
    fn enumerates_real_windows_font_families() {
        let fonts = windows_fonts().unwrap();
        assert!(!fonts.is_empty());
        assert!(fonts
            .iter()
            .any(|name| name.eq_ignore_ascii_case("Consolas")));
    }
}
