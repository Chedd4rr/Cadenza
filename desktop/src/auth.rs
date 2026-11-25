
use base64::Engine;
use rand::Rng;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::files;
use crate::settings::Settings;

pub const REDIRECT_URI: &str = "http://127.0.0.1:8888";
pub const SCOPES: &str = "user-read-playback-state user-modify-playback-state user-read-currently-playing \
playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public \
user-library-read user-library-modify user-follow-modify user-top-read user-read-recently-played \
user-read-private ugc-image-upload";

pub struct Auth {
    settings: Arc<Settings>,
    http: reqwest::Client,
    access: tokio::sync::Mutex<Option<(String, Instant)>>,
    waiting: Mutex<Option<Arc<AtomicBool>>>,
}

impl Auth {
    pub fn new(settings: Arc<Settings>, http: reqwest::Client) -> Self {
        Auth { settings, http, access: tokio::sync::Mutex::new(None), waiting: Mutex::new(None) }
    }

    fn refresh_token(&self) -> Option<String> {
        let s = std::fs::read_to_string(files::path("spotify-token")).ok()?;
        let s = s.trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    }

    fn set_refresh_token(&self, token: Option<&str>) {
        match token {
            Some(t) if !t.is_empty() => {
                if !files::write_privately(t.as_bytes(), &files::path("spotify-token")) {
                    log::warn!("couldn't save the Spotify login");
                }
            }
            _ => { let _ = std::fs::remove_file(files::path("spotify-token")); }
        }
    }

    pub fn is_logged_in(&self) -> bool {
        self.refresh_token().is_some() && !self.settings.client_id().is_empty()
    }

    pub fn missing_scopes(&self) -> Vec<String> {
        let Ok(granted) = std::fs::read_to_string(files::path("spotify-scopes")) else { return vec![] };
        let have: Vec<&str> = granted.split_whitespace().collect();
        SCOPES.split_whitespace().filter(|s| !have.contains(s)).map(String::from).collect()
    }

    pub async fn token(&self) -> Option<String> {
        let mut access = self.access.lock().await;
        if let Some((t, until)) = access.as_ref() {
            if Instant::now() < *until { return Some(t.clone()); }
        }
        let rt = self.refresh_token()?;
        let client_id = self.settings.client_id();
        if client_id.is_empty() { return None; }
        let got = self.token_request(&[("grant_type", "refresh_token"), ("refresh_token", &rt), ("client_id", &client_id)]).await;
        *access = got.clone();
        got.map(|(t, _)| t)
    }

    pub async fn invalidate(&self) { *self.access.lock().await = None; }

    pub async fn logout(&self) {
        self.set_refresh_token(None);
        *self.access.lock().await = None;
        let _ = std::fs::remove_file(files::path("spotify-scopes"));
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> Option<(String, Instant)> {
        let res = self.http.post("https://accounts.spotify.com/api/token")
            .timeout(Duration::from_secs(15)).form(form).send().await;
        let (status, json) = match res {
            Ok(r) => { let s = r.status().as_u16(); (s, r.json::<Value>().await.unwrap_or(Value::Null)) }
            Err(e) => { log::warn!("token request failed: {e}"); return None; }
        };
        let Some(at) = json.get("access_token").and_then(|v| v.as_str()).filter(|_| status == 200) else {
            log::warn!("token request failed ({status})");
            // A rejected refresh token means the login is gone: forget it.
            if form.iter().any(|(k, v)| *k == "grant_type" && *v == "refresh_token") && (status == 400 || status == 401) {
                self.set_refresh_token(None);
            }
            return None;
        };
        let ttl = json.get("expires_in").and_then(|v| v.as_f64()).unwrap_or(3600.0);
        if let Some(rt) = json.get("refresh_token").and_then(|v| v.as_str()) { self.set_refresh_token(Some(rt)); }
        if let Some(sc) = json.get("scope").and_then(|v| v.as_str()) {
            files::write_privately(sc.as_bytes(), &files::path("spotify-scopes"));
        }
        Some((at.to_string(), Instant::now() + Duration::from_secs_f64((ttl - 60.0).max(30.0))))
    }

    pub async fn login(&self) -> Result<(), String> {
        let client_id = self.settings.client_id();
        if client_id.is_empty() { return Err("Enter your Client ID first.".into()); }

        // A sign-in already waiting is replaced by this one.
        let cancel = Arc::new(AtomicBool::new(false));
        if let Some(old) = self.waiting.lock().unwrap().replace(cancel.clone()) { old.store(true, Ordering::SeqCst); }

        let verifier = random(64);
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = random(16);

        let listener = bind_with_retry().map_err(|e| format!("Couldn't listen on port 8888 ({e}). Close anything else using it and try again."))?;

        let mut url = url::Url::parse("https://accounts.spotify.com/authorize").unwrap();
        url.query_pairs_mut()
            .append_pair("response_type", "code").append_pair("client_id", &client_id)
            .append_pair("scope", SCOPES).append_pair("redirect_uri", REDIRECT_URI)
            .append_pair("state", &state).append_pair("code_challenge_method", "S256")
            .append_pair("code_challenge", &challenge);
        if let Err(e) = open::that(url.as_str()) { log::warn!("couldn't open the browser: {e}"); }

        let expected = state.clone();
        let got = tokio::task::spawn_blocking(move || wait_for_callback(listener, &expected, &cancel))
            .await.map_err(|_| "Login was cancelled.".to_string())??;

        self.token_request(&[
            ("grant_type", "authorization_code"), ("code", &got), ("redirect_uri", REDIRECT_URI),
            ("client_id", &client_id), ("code_verifier", &verifier),
        ]).await.map(|_| ())
          .ok_or_else(|| format!("Spotify rejected the login. Check the Client ID, and that {REDIRECT_URI} is listed under Redirect URIs in your Spotify app."))?;
        *self.access.lock().await = None;
        Ok(())
    }
}

fn bind_with_retry() -> std::io::Result<TcpListener> {
    let mut last = None;
    for _ in 0..10 {
        match TcpListener::bind("127.0.0.1:8888") {
            Ok(l) => return Ok(l),
            Err(e) => { last = Some(e); std::thread::sleep(Duration::from_millis(200)); }
        }
    }
    Err(last.unwrap())
}

fn wait_for_callback(listener: TcpListener, state: &str, cancel: &AtomicBool) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) { return Err("Login restarted.".into()); }
        if started.elapsed() > Duration::from_secs(600) { return Err("Login timed out.".into()); }
        let (mut conn, _) = match listener.accept() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => { std::thread::sleep(Duration::from_millis(100)); continue; }
            Err(e) => return Err(e.to_string()),
        };
        let _ = conn.set_nonblocking(false);
        let _ = conn.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = [0u8; 16384];
        let n = conn.read(&mut buf).unwrap_or(0);
        let text = String::from_utf8_lossy(&buf[..n]);
        let target = text.lines().next().and_then(|l| l.split(' ').nth(1)).unwrap_or("/").to_string();
        let parsed = url::Url::parse(&format!("http://127.0.0.1{target}")).ok();
        let query = |name: &str| parsed.as_ref().and_then(|u| u.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.to_string()));

        let is_callback = query("code").is_some() || query("error").is_some();
        let ok = is_callback && query("state").as_deref() == Some(state) && query("code").is_some();
        let title = if ok { "LOGGED IN" } else if is_callback { "LOGIN FAILED" } else { "CADENZA" };
        let html = format!(r#"<!doctype html><meta charset="utf-8"><title>Cadenza</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#030c2e;color:#f4fdff;font:600 22px system-ui,sans-serif">
<div style="transform:skewX(-12deg);background:#f4fdff;color:#06185a;padding:28px 44px;box-shadow:12px 12px 0 #3fe0ff">
<div style="font-size:40px;font-weight:900;font-style:italic">{title}</div>
<div>You can close this tab and go back to Cadenza.</div></div></body>"#);
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}", html.len());
        let _ = conn.write_all(response.as_bytes());

        if !is_callback { continue; }            // a favicon request, say
        return match (ok, query("code"), query("error")) {
            (true, Some(code), _) => Ok(code),
            (_, _, Some(err)) => Err(format!("Spotify said: {err}")),
            _ => Err("Login was cancelled.".into()),
        };
    }
}

fn random(n: usize) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..n).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect()
}
