use serde::Serialize;

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Debug, Serialize, Clone)]
pub struct UsageWindow {
    pub utilization: f64,
    pub resets_at: String,
}

/// A weekly limit scoped to one model, such as Fable.
#[derive(Debug, Serialize, Clone)]
pub struct ModelLimit {
    pub model: String,
    pub utilization: f64,
    pub resets_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ClaudeUsage {
    pub five_hour: UsageWindow,
    pub seven_day: UsageWindow,
    pub seven_day_opus: UsageWindow,
    pub model_limits: Vec<ModelLimit>,
}

fn read_credentials_file_with_retry(path: &std::path::Path) -> Option<String> {
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
        let Ok(contents) = std::fs::read_to_string(path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) else {
            continue;
        };
        if let Some(tok) = json
            .get("claudeAiOauth")
            .and_then(|o| o.get("accessToken"))
            .and_then(|v| v.as_str())
        {
            if !tok.is_empty() {
                return Some(tok.to_string());
            }
        }
    }
    None
}

/// Try to find the Claude OAuth token.
fn discover_token() -> Option<String> {
    // 1. Env var
    if let Ok(tok) = std::env::var("CLAUDE_OAUTH_TOKEN") {
        if !tok.is_empty() {
            return Some(tok);
        }
    }

    // 2. ~/.claude/.credentials.json (where Claude Code actually stores it)
    if let Some(home) = dirs_next::home_dir() {
        let cred_path = home.join(".claude").join(".credentials.json");
        if let Some(tok) = read_credentials_file_with_retry(&cred_path) {
            return Some(tok);
        }
    }

    // 3. Keyring (Windows Credential Manager / macOS Keychain).
    //    On macOS, Claude Code stores the entry with account = the local username.

    let service = "Claude Code-credentials";
    let mut usernames: Vec<String> = Vec::new();
    if let Ok(user) = std::env::var("USER").or_else(|_| std::env::var("USERNAME")) {
        if !user.is_empty() {
            usernames.push(user);
        }
    }
    for u in ["default", "user", "claude", ""] {
        usernames.push(u.to_string());
    }
    for username in &usernames {
        if let Ok(entry) = keyring::Entry::new(service, username) {
            if let Ok(secret) = entry.get_password() {
                if secret.is_empty() {
                    continue;
                }
                return Some(extract_token_from_secret(&secret));
            }
        }
    }

    None
}

/// The keyring secret is either the bare token or the credentials JSON
/// ({"claudeAiOauth":{"accessToken":...}}), as in the macOS Keychain.
fn extract_token_from_secret(secret: &str) -> String {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(secret) {
        if let Some(tok) = json
            .get("claudeAiOauth")
            .and_then(|o| o.get("accessToken"))
            .and_then(|v| v.as_str())
        {
            if !tok.is_empty() {
                return tok.to_string();
            }
        }
    }
    secret.to_string()
}

const MAX_RETRY_AFTER_SECS: u64 = 3600;

/// Why a usage read failed: `no_token`, `rate_limited`, `unauthorized`, `offline` or `unavailable`,
/// with the HTTP status and Retry-After seconds when the API sent them. It holds nothing from the
/// token, the request or the response body, so it is safe to log.
struct UsageError {
    kind: &'static str,
    status: Option<u16>,
    retry_after_secs: Option<u64>,
}

impl UsageError {
    fn new(kind: &'static str) -> Self {
        Self {
            kind,
            status: None,
            retry_after_secs: None,
        }
    }

    fn from_response(status: u16, retry_after: Option<&str>) -> Self {
        let kind = match status {
            429 => "rate_limited",
            401 => "unauthorized",
            _ => "unavailable",
        };
        Self {
            kind,
            status: Some(status),
            // ponytail: delta-seconds only; an HTTP-date leaves the wait to the frontend default.
            // Held to an hour, so a bogus value cannot stop usage reads for the whole session.
            retry_after_secs: retry_after
                .and_then(|value| value.trim().parse::<u64>().ok())
                .map(|secs| secs.min(MAX_RETRY_AFTER_SECS)),
        }
    }

    /// `kind[:status[:retry_after_secs]]`, the `code:detail` string other commands return.
    fn code(&self) -> String {
        let mut code = self.kind.to_string();
        if let Some(status) = self.status {
            code.push_str(&format!(":{status}"));
        }
        if let Some(secs) = self.retry_after_secs {
            code.push_str(&format!(":{secs}"));
        }
        code
    }

    fn log_line(&self) -> String {
        let mut line = format!("kind={}", self.kind);
        if let Some(status) = self.status {
            line.push_str(&format!(" status={status}"));
        }
        if let Some(secs) = self.retry_after_secs {
            line.push_str(&format!(" retry_after={secs}"));
        }
        line
    }
}

#[tauri::command]
pub async fn get_claude_usage() -> Result<ClaudeUsage, String> {
    fetch_usage().await.map_err(|error| {
        let _ =
            crate::logging::record_app_event("claude.usage.failed".to_string(), error.log_line());
        error.code()
    })
}

async fn fetch_usage() -> Result<ClaudeUsage, UsageError> {
    let token = discover_token().ok_or_else(|| UsageError::new("no_token"))?;

    let resp = http_client()
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {}", token))
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| {
            UsageError::new(if e.is_connect() || e.is_timeout() {
                "offline"
            } else {
                "unavailable"
            })
        })?;

    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        let retry_after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok());
        return Err(UsageError::from_response(status, retry_after));
    }

    let body: serde_json::Value = resp.json().await.map_err(|_| UsageError {
        status: Some(status),
        ..UsageError::new("unavailable")
    })?;
    Ok(parse_usage(&body))
}

fn parse_usage(body: &serde_json::Value) -> ClaudeUsage {
    let parse_window = |key: &str| -> UsageWindow {
        let default = UsageWindow {
            utilization: 0.0,
            resets_at: String::new(),
        };
        let Some(obj) = body.get(key) else {
            return default;
        };
        if obj.is_null() {
            return default;
        }
        let utilization = obj
            .get("utilization")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let resets_at = obj
            .get("resets_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        UsageWindow {
            utilization,
            resets_at,
        }
    };

    // Opus has its own row; when the legacy `seven_day_opus` window is absent, fill that row from
    // the Opus entry in `limits[]` instead of listing it twice.
    let (opus, model_limits): (Vec<_>, Vec<_>) = parse_model_limits(body)
        .into_iter()
        .partition(|limit| limit.model.eq_ignore_ascii_case("opus"));
    let seven_day_opus = match opus.into_iter().next() {
        Some(limit) if body.get("seven_day_opus").is_none_or(|v| v.is_null()) => UsageWindow {
            utilization: limit.utilization,
            resets_at: limit.resets_at,
        },
        _ => parse_window("seven_day_opus"),
    };

    ClaudeUsage {
        five_hour: parse_window("five_hour"),
        seven_day: parse_window("seven_day"),
        seven_day_opus,
        model_limits,
    }
}

/// Model-scoped weekly limits are reported only in `limits[]`, as `weekly_scoped` entries with a
/// model scope. Limits that also narrow to one surface are skipped: they would repeat the model
/// name without saying which surface they cover.
fn parse_model_limits(body: &serde_json::Value) -> Vec<ModelLimit> {
    body.get("limits")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter(|limit| limit.get("kind").and_then(|v| v.as_str()) == Some("weekly_scoped"))
        .filter(|limit| limit.pointer("/scope/surface").is_none_or(|v| v.is_null()))
        .filter_map(|limit| {
            let model = limit.pointer("/scope/model/display_name")?.as_str()?;
            Some(ModelLimit {
                model: model.to_string(),
                utilization: limit.get("percent").and_then(|v| v.as_f64()).unwrap_or(0.0),
                resets_at: limit
                    .get("resets_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn reads_model_scoped_weekly_limits() {
        let usage = super::parse_usage(&json!({
            "five_hour": { "utilization": 15.0, "resets_at": "2026-09-24T02:59:59Z" },
            "seven_day": { "utilization": 30.0, "resets_at": "2026-09-24T01:59:59Z" },
            "seven_day_opus": null,
            "limits": [
                { "kind": "session", "percent": 15, "resets_at": "2026-09-24T02:59:59Z", "scope": null },
                { "kind": "weekly_all", "percent": 30, "resets_at": "2026-09-24T01:59:59Z", "scope": null },
                {
                    "kind": "weekly_scoped", "percent": 25, "resets_at": "2026-09-24T01:59:59Z",
                    "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null }
                },
                {
                    "kind": "weekly_scoped", "percent": 40, "resets_at": "2026-09-24T01:59:59Z",
                    "scope": { "model": { "id": null, "display_name": "Opus" }, "surface": null }
                },
                {
                    "kind": "weekly_scoped", "percent": 70, "resets_at": "2026-09-24T01:59:59Z",
                    "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": { "id": "cli" } }
                }
            ]
        }));

        assert_eq!(usage.five_hour.utilization, 15.0);
        assert_eq!(
            usage.model_limits.len(),
            1,
            "Opus keeps its own row; surface limits are skipped"
        );
        assert_eq!(usage.model_limits[0].model, "Fable");
        assert_eq!(usage.model_limits[0].utilization, 25.0);
        assert_eq!(usage.model_limits[0].resets_at, "2026-09-24T01:59:59Z");
        assert_eq!(
            usage.seven_day_opus.utilization, 40.0,
            "Opus from limits[] fills its row"
        );
    }

    #[test]
    fn legacy_opus_window_wins_over_its_scoped_limit() {
        let usage = super::parse_usage(&json!({
            "seven_day_opus": { "utilization": 12.0, "resets_at": "2026-09-24T01:59:59Z" },
            "limits": [{
                "kind": "weekly_scoped", "percent": 40, "resets_at": "2026-09-24T01:59:59Z",
                "scope": { "model": { "id": null, "display_name": "Opus" }, "surface": null }
            }]
        }));

        assert_eq!(usage.seven_day_opus.utilization, 12.0);
        assert!(usage.model_limits.is_empty());
    }

    #[test]
    fn missing_limits_means_no_model_rows() {
        let usage = super::parse_usage(&json!({ "five_hour": null, "limits": null }));
        assert!(usage.model_limits.is_empty());
    }

    #[test]
    fn a_rate_limit_carries_its_status_and_retry_after() {
        let error = super::UsageError::from_response(429, Some("30"));
        assert_eq!(error.code(), "rate_limited:429:30");
        assert_eq!(
            error.log_line(),
            "kind=rate_limited status=429 retry_after=30"
        );
    }

    #[test]
    fn a_retry_after_longer_than_an_hour_is_held_to_an_hour() {
        let at_max = super::UsageError::from_response(429, Some("3600"));
        assert_eq!(at_max.code(), "rate_limited:429:3600");
        let huge = super::UsageError::from_response(429, Some("18446744073709551615"));
        assert_eq!(huge.code(), "rate_limited:429:3600");
        assert_eq!(
            huge.log_line(),
            "kind=rate_limited status=429 retry_after=3600"
        );
    }

    #[test]
    fn a_rate_limit_without_seconds_leaves_the_wait_to_the_frontend() {
        assert_eq!(
            super::UsageError::from_response(429, None).code(),
            "rate_limited:429"
        );
        // An HTTP-date Retry-After carries no seconds either.
        let dated = super::UsageError::from_response(429, Some("Wed, 21 Oct 2026 07:28:00 GMT"));
        assert_eq!(dated.code(), "rate_limited:429");
        assert_eq!(dated.log_line(), "kind=rate_limited status=429");
    }

    #[test]
    fn names_an_expired_sign_in_apart_from_other_refusals() {
        assert_eq!(
            super::UsageError::from_response(401, None).code(),
            "unauthorized:401"
        );
        let refused = super::UsageError::from_response(503, None);
        assert_eq!(refused.code(), "unavailable:503");
        assert_eq!(refused.log_line(), "kind=unavailable status=503");
        let offline = super::UsageError::new("offline");
        assert_eq!(offline.code(), "offline");
        assert_eq!(offline.log_line(), "kind=offline");
    }
}
