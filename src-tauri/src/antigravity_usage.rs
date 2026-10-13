use serde::Serialize;
use std::time::Duration;

use crate::cli_resolver;

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct AntigravityQuotaBucket {
    /// Quota group as `agy /usage` names it, without the trailing "Models".
    pub label: String,
    pub models: Vec<String>,
    /// Window as the CLI reports it: `5h` or `weekly`.
    pub window: String,
    pub used_percent: f64,
    pub remaining_percent: f64,
    pub resets_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct AntigravityUsage {
    /// ready | no_cli | unavailable
    pub status: String,
    pub cli_path: String,
    pub used_percent: f64,
    pub rate_limited: bool,
    pub buckets: Vec<AntigravityQuotaBucket>,
}

fn empty_usage(status: &str, cli_path: String) -> AntigravityUsage {
    AntigravityUsage {
        status: status.to_string(),
        cli_path,
        used_percent: 0.0,
        rate_limited: false,
        buckets: Vec::new(),
    }
}

fn group_label(name: &str) -> String {
    let name = name.trim();
    if name.to_ascii_lowercase().ends_with(" models") {
        name[..name.len() - " models".len()].trim_end().to_string()
    } else {
        name.to_string()
    }
}

/// The CLI lists a group's model families only in prose: "Models within this group: A, B".
fn models_from_description(description: &str) -> Vec<String> {
    description
        .split_once(':')
        .map(|(_, list)| {
            list.split(',')
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_usage(stdout: &str, cli_path: String) -> Result<AntigravityUsage, String> {
    let body: serde_json::Value =
        serde_json::from_str(stdout.trim()).map_err(|_| "invalid_json".to_string())?;
    let groups = body
        .pointer("/command/data/groups")
        .and_then(|groups| groups.as_array())
        .ok_or_else(|| "groups_missing".to_string())?;

    let mut buckets = Vec::new();
    for group in groups {
        let label = group_label(group.get("name").and_then(|v| v.as_str()).unwrap_or(""));
        let models = group
            .get("description")
            .and_then(|v| v.as_str())
            .map(models_from_description)
            .unwrap_or_default();
        for bucket in group
            .get("buckets")
            .and_then(|buckets| buckets.as_array())
            .into_iter()
            .flatten()
        {
            let Some(remaining) = bucket.get("remaining_fraction").and_then(|v| v.as_f64()) else {
                continue;
            };
            let remaining_percent = remaining.clamp(0.0, 1.0) * 100.0;
            buckets.push(AntigravityQuotaBucket {
                label: label.clone(),
                models: models.clone(),
                window: bucket
                    .get("window")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                used_percent: 100.0 - remaining_percent,
                remaining_percent,
                resets_at: bucket
                    .get("reset_time")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            });
        }
    }

    if buckets.is_empty() {
        return Err("quota_missing".to_string());
    }

    let used_percent = buckets
        .iter()
        .map(|bucket| bucket.used_percent)
        .fold(0.0, f64::max);

    Ok(AntigravityUsage {
        status: "ready".to_string(),
        cli_path,
        used_percent,
        rate_limited: used_percent >= 99.9,
        buckets,
    })
}

#[tauri::command]
pub async fn get_antigravity_usage() -> Result<AntigravityUsage, String> {
    let Some(launcher) = cli_resolver::find_windows_cli_launcher("agy") else {
        return Ok(empty_usage("no_cli", String::new()));
    };
    let cli_path = launcher.to_string_lossy().to_string();
    // `/usage` in print mode answers without an agent turn or quota spend. A signed-out CLI fails
    // here too, and reads as unavailable.
    // ponytail: each read spawns agy for ~5.5 s; the frontend cache keeps it to one per 5 min.
    // Call the quota endpoint directly if the CLI ever documents it.
    let output = cli_resolver::background_output(
        &launcher,
        &["-p", "/usage", "--output-format", "json"],
        Duration::from_secs(30),
    )
    .await;
    Ok(output
        .ok()
        .and_then(|output| {
            parse_usage(&String::from_utf8_lossy(&output.stdout), cli_path.clone()).ok()
        })
        .unwrap_or_else(|| empty_usage("unavailable", cli_path)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from `agy -p "/usage" --output-format json` (agy 1.3.x, 2026-10-12).
    const USAGE: &str = r#"{"conversation_id":"","status":"SUCCESS","response":"","duration_seconds":0,"num_turns":0,"command":{"name":"usage","data":{"description":"Within each group, models share a weekly limit and a 5-hour limit.","groups":[{"name":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.9935969710350037,"reset_time":"2026-10-13T22:54:28Z"},{"id":"gemini-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":1,"reset_time":"2026-10-12T23:26:59Z"}]},{"name":"Claude and GPT models","description":"Models within this group: Claude Opus, Claude Sonnet, GPT-OSS","buckets":[{"id":"3p-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.4,"reset_time":"2026-10-19T16:49:35Z"},{"id":"3p-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":1,"reset_time":"2026-10-12T23:26:59Z"}]}]}}}"#;

    #[test]
    fn reads_one_bucket_per_group_and_window() {
        let usage = parse_usage(USAGE, "agy.exe".to_string()).unwrap();

        assert_eq!(usage.status, "ready");
        let summary: Vec<(&str, &str)> = usage
            .buckets
            .iter()
            .map(|bucket| (bucket.label.as_str(), bucket.window.as_str()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("Gemini", "weekly"),
                ("Gemini", "5h"),
                ("Claude and GPT", "weekly"),
                ("Claude and GPT", "5h"),
            ]
        );
        assert_eq!(usage.buckets[0].models, vec!["Gemini Flash", "Gemini Pro"]);
        assert_eq!(
            usage.buckets[2].models,
            vec!["Claude Opus", "Claude Sonnet", "GPT-OSS"]
        );
        assert_eq!(usage.buckets[2].resets_at, "2026-10-19T16:49:35Z");
        assert!((usage.buckets[0].used_percent - 0.6403).abs() < 0.001);
        assert!((usage.used_percent - 60.0).abs() < 1e-9);
        assert!(!usage.rate_limited);
    }

    #[test]
    fn treats_nearly_empty_bucket_as_rate_limited() {
        let body = r#"{"command":{"data":{"groups":[{"name":"Gemini Models","buckets":[{"window":"5h","remaining_fraction":0.0005,"reset_time":"soon"}]}]}}}"#;
        let usage = parse_usage(body, "agy.exe".to_string()).unwrap();
        assert!((usage.used_percent - 99.95).abs() < 1e-9);
        assert!(usage.rate_limited);
        assert!(usage.buckets[0].models.is_empty());
    }

    #[test]
    fn rejects_output_without_quota() {
        assert!(parse_usage("not-json", String::new()).is_err());
        assert!(parse_usage(r#"{"status":"ERROR"}"#, String::new()).is_err());
        assert!(parse_usage(r#"{"command":{"data":{"groups":[]}}}"#, String::new()).is_err());
    }

    #[test]
    fn keeps_group_names_that_do_not_end_in_models() {
        assert_eq!(group_label(" Gemini Models "), "Gemini");
        assert_eq!(group_label("Claude and GPT models"), "Claude and GPT");
        assert_eq!(group_label("Experimental"), "Experimental");
    }
}
