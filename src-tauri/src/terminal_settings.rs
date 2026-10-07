use std::path::Path;

#[derive(serde::Serialize, Debug)]
pub struct ShellOption {
    pub id: String,
    pub label: String,
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
        let Ok(binary) = which::which_in(name, Some(&path), &cwd) else {
            continue;
        };
        let id = crate::cli_launch::strip_verbatim_prefix(binary)
            .to_string_lossy()
            .into_owned();
        if shells.iter().any(|item: &ShellOption| item.id == id) {
            continue;
        }
        shells.push(ShellOption {
            label: format!("{name} — {id}"),
            id,
        });
    }
    shells
}

/// Only a currently discovered executable is accepted; strings never become shell command lines.
pub(crate) fn resolve_shell(selected: Option<&str>) -> Option<String> {
    let selected = selected?.trim();
    if !Path::new(selected).is_absolute() || !Path::new(selected).is_file() {
        return None;
    }
    shells_on_path()
        .into_iter()
        .find(|item| {
            if cfg!(windows) {
                item.id.eq_ignore_ascii_case(selected)
            } else {
                item.id == selected
            }
        })
        .map(|item| item.id)
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
        let plain =
            crate::cli_resolver::command_builder_for_terminal(None, None, &[], Some(&shell.id));
        assert_eq!(plain.get_argv()[0].to_string_lossy(), shell.id);
        let agent = crate::cli_resolver::command_builder_for_terminal(
            Some("claude"),
            None,
            &[],
            Some(&shell.id),
        );
        assert_eq!(
            agent.get_argv()[0].to_string_lossy(),
            crate::cli_resolver::default_shell()
        );
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
