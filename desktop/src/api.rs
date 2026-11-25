//! A thin Spotify Web API client with a rate-limit guard.
//!
//! Spotify blocks an app that sends too many requests (HTTP 429 with a Retry-After wait). While an
//! endpoint is blocked, requests to it are answered here instead of being sent, because hitting Spotify
//! during a block can make it longer. Background traffic is smoothed to at most 40 requests per 30 s.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::auth::Auth;
use crate::files;

const BASE: &str = "https://api.spotify.com/v1";

#[derive(Default)]
struct Guard {
    recent: Vec<Instant>,
    blocks: HashMap<String, Instant>,
    blocked_until: Option<Instant>,
    last_retry_after: f64,
    log: Vec<String>,
    total: u64,
}

pub struct Api {
    pub auth: Arc<Auth>,
    http: reqwest::Client,
    guard: Mutex<Guard>,
    started: Instant,
}

impl Api {
    pub fn new(auth: Arc<Auth>, http: reqwest::Client) -> Self {
        Api { auth, http, guard: Mutex::new(Guard::default()), started: Instant::now() }
    }

    fn note(&self, g: &mut Guard, line: String) {
        let now = chrono_like_now();
        log::info!("spotify: {line}");
        g.log.push(format!("{now}  {line}"));
        if g.log.len() > 300 { let extra = g.log.len() - 300; g.log.drain(..extra); }
    }

    /// The latest requests and Spotify's answers, for diagnostics.
    pub fn recent_log(&self, n: usize) -> Vec<String> {
        let g = self.guard.lock().unwrap();
        g.log.iter().rev().take(n).rev().cloned().collect()
    }

    /// A new login or Client ID starts fresh: forget any wait Spotify gave the previous one.
    pub fn reset_block(&self) {
        let mut g = self.guard.lock().unwrap();
        g.blocks.clear();
        g.blocked_until = None;
        g.last_retry_after = 0.0;
        g.recent.clear();
    }

    /// For System → Spotify activity.
    pub fn activity(&self) -> Value {
        let g = self.guard.lock().unwrap();
        let now = Instant::now();
        let last_minute = g.recent.iter().filter(|t| now.duration_since(**t) < Duration::from_secs(60)).count();
        let blocked_for = g.blocked_until.map(|u| u.saturating_duration_since(now).as_secs_f64().ceil() as u64).unwrap_or(0);
        json!({
            "lastMinute": last_minute, "total": g.total, "uptime": self.started.elapsed().as_secs(),
            "blockedFor": blocked_for, "lastRetryAfter": g.last_retry_after as u64,
            "log": g.log.iter().rev().take(60).rev().cloned().collect::<Vec<_>>(),
            "logFile": files::tidy(&files::path("spotify-requests.log")),
        })
    }

    /// Uploads a raw body (a playlist cover: base64 JPEG sent as image/jpeg). Returns the status.
    pub async fn upload(&self, method: &str, path: &str, body: Vec<u8>, content_type: &str) -> u16 {
        let Some(token) = self.auth.token().await else { return 401 };
        let Ok(url) = url::Url::parse(&format!("{BASE}{path}")) else { return 400 };
        if url.host_str() != Some("api.spotify.com") { return 400; }
        let m = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::PUT);
        let res = self.http.request(m, url).timeout(Duration::from_secs(30)).bearer_auth(token)
            .header("Content-Type", content_type).body(body).send().await;
        let status = res.map(|r| r.status().as_u16()).unwrap_or(0);
        let mut g = self.guard.lock().unwrap();
        self.note(&mut g, format!("{method} {path} (upload) → {status}"));
        status
    }

    /// `path` is relative to https://api.spotify.com/v1 ("/me/player") or a full api.spotify.com URL.
    /// Returns (status, body). Status 0 means Spotify couldn't be reached.
    pub async fn request(&self, method: &str, path: &str, body: Option<&Value>) -> (u16, Value) {
        let mut retries = 1;
        loop {
            let (status, json, retry_after) = self.once(method, path, body).await;
            if status == 401 && retries > 0 {
                self.auth.invalidate().await;
                retries -= 1;
                continue;
            }
            // Short waits are retried here; longer ones go back to the page, which pauses its background
            // checks until Spotify's cool-down is over.
            if status == 429 && retries > 0 && retry_after <= 5.0 {
                tokio::time::sleep(Duration::from_secs_f64(retry_after.max(0.5))).await;
                retries -= 1;
                continue;
            }
            return (status, json);
        }
    }

    async fn once(&self, method: &str, path: &str, body: Option<&Value>) -> (u16, Value, f64) {
        let Some(token) = self.auth.token().await else {
            // Still signed in but couldn't refresh (no network yet): a network error, not "logged out",
            // so the page doesn't ask you to sign in again.
            if self.auth.is_logged_in() {
                return (0, json!({"error": {"status": 0, "message": "Couldn't reach Spotify"}}), 0.0);
            }
            return (401, json!({"error": {"status": 401, "message": "Not logged in"}}), 0.0);
        };
        let full = if path.starts_with("http") { path.to_string() } else { format!("{BASE}{path}") };
        // Full URLs (Spotify's "next page" links) must point at Spotify's API: the login token is attached
        // to every request, so it must never be sent anywhere else.
        let Ok(url) = url::Url::parse(&full) else { return (400, json!({"error": {"status": 400, "message": "Bad URL"}}), 0.0) };
        if url.scheme() != "https" || url.host_str().map(|h| h.to_ascii_lowercase()) != Some("api.spotify.com".into()) {
            return (400, json!({"error": {"status": 400, "message": "Bad URL"}}), 0.0);
        }
        let short = full.replacen(BASE, "", 1);
        let endpoint = format!("{method} {}", short.split('?').next().unwrap_or(&short));

        // Waits are per endpoint; controls you press go straight out; background traffic is smoothed.
        enum Next { Go, Wait, Blocked(f64) }
        loop {
            let next = {
                let mut g = self.guard.lock().unwrap();
                let now = Instant::now();
                let pressed = method != "GET" && endpoint.starts_with(&format!("{method} /me/player")) && !endpoint.ends_with("/queue");
                g.recent.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
                let last30 = g.recent.iter().filter(|t| now.duration_since(**t) < Duration::from_secs(30)).count();
                match g.blocks.get(&endpoint).copied() {
                    Some(until) if now < until => Next::Blocked(until.duration_since(now).as_secs_f64()),
                    _ if !pressed && last30 >= 40 => { self.note(&mut g, format!("(held back a moment: {method} {short})")); Next::Wait }
                    _ => { g.recent.push(now); g.total += 1; Next::Go }
                }
            };
            match next {
                Next::Go => break,
                Next::Wait => tokio::time::sleep(Duration::from_millis(1500)).await,
                Next::Blocked(left) => return (429, json!({"error": {"status": 429, "message": "Too many requests"}, "retryAfter": left}), left),
            }
        }

        let m = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);
        let mut req = self.http.request(m, url).timeout(Duration::from_secs(15)).bearer_auth(token);
        if method != "GET" {
            req = req.header("Content-Type", "application/json");
            // Spotify refuses a PUT or POST that doesn't say how long it is (411 Length Required), and an
            // empty body goes out without saying so unless it's set here. (macOS adds it by itself.)
            req = match body {
                Some(b) if !b.is_null() => req.body(b.to_string()),
                _ => req.header("Content-Length", "0").body(""),
            };
        }
        let (status, json, retry_after) = match req.send().await {
            Ok(r) => {
                let status = r.status().as_u16();
                let ra = r.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(1.0);
                let bytes = r.bytes().await.unwrap_or_default();
                let json = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
                (status, json, ra)
            }
            Err(_) => (0, Value::Null, 0.0),
        };

        let mut g = self.guard.lock().unwrap();
        // For a refusal, add Spotify's own reason ("Restriction violated", "PREMIUM_REQUIRED"…).
        let mut why = String::new();
        if status >= 400 && status != 429 {
            if let Some(err) = json.get("error") {
                let parts: Vec<&str> = ["message", "reason"].iter().filter_map(|k| err.get(*k).and_then(|v| v.as_str())).filter(|s| !s.is_empty()).collect();
                if !parts.is_empty() { why = format!("  ({})", parts.join(" · ").chars().take(120).collect::<String>()); }
            }
        }
        let shown: String = short.chars().take(90).collect();
        let extra = if status == 429 { format!("  (Spotify says wait {} s)", retry_after as u64) } else { why };
        self.note(&mut g, format!("{method} {shown} → {status}{extra}"));
        if status == 429 {
            g.last_retry_after = retry_after;
            if retry_after > 5.0 {
                let until = Instant::now() + Duration::from_secs_f64(retry_after);
                g.blocks.insert(endpoint, until);
                g.blocked_until = Some(g.blocked_until.map_or(until, |b| b.max(until)));
            }
            // Saved for "Spotify activity" after a block, without what you searched for.
            let hide = regex::Regex::new(r"([?&]q=)[^&\s]*").unwrap();
            let text = hide.replace_all(&g.log.join("\n"), "${1}(hidden)").into_owned();
            files::write_privately(text.as_bytes(), &files::path("spotify-requests.log"));
        }
        (status, json, retry_after)
    }
}

/// The local time as HH:MM:SS, for the activity log.
fn chrono_like_now() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}
