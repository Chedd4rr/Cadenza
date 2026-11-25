
use md5::{Digest, Md5};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::settings::Settings;

const ENDPOINT: &str = "https://ws.audioscrobbler.com/2.0/";

const READ_METHODS: &[&str] = &[
    "user.getInfo", "user.getTopArtists", "user.getTopTracks", "user.getTopAlbums", "user.getRecentTracks",
    "user.getFriends", "user.getWeeklyTrackChart", "track.getInfo", "artist.getInfo",
    "track.getSimilar", "artist.getSimilar",                  // song radio and autoplay
    "track.getTopTags", "artist.getTopTags", "tag.getTopTracks", // the playlist builder's moods
    "artist.getTopTracks",                                    // the playlist builder: artists like yours
];

pub struct LastFm {
    settings: Arc<Settings>,
    http: reqwest::Client,
    last_error: Mutex<String>,
    login_token: Mutex<String>,
    reading: tokio::sync::Mutex<Instant>,
}

impl LastFm {
    pub fn new(settings: Arc<Settings>, http: reqwest::Client) -> Self {
        LastFm { settings, http, last_error: Mutex::new(String::new()), login_token: Mutex::new(String::new()),
                 reading: tokio::sync::Mutex::new(Instant::now() - Duration::from_secs(1)) }
    }

    fn api_key(&self) -> String {
        let own = self.settings.string("lastfmKey");
        if own.is_empty() { crate::builtin::LASTFM_KEY.to_string() } else { own }
    }
    fn secret(&self) -> String { self.settings.secret("lastfmSecret") }
    pub fn user(&self) -> String { self.settings.string("lastfmUser") }

    pub fn status(&self) -> Value {
        json!({"user": self.user(), "hasKeys": !self.api_key().is_empty(), "loggedIn": !self.user().is_empty(),
               "builtinKey": self.settings.string("lastfmKey").is_empty() && !crate::builtin::LASTFM_KEY.is_empty(),
               "canSignIn": !self.api_key().is_empty() && !self.secret().is_empty(),
               "error": *self.last_error.lock().unwrap()})
    }

    pub async fn login(&self) -> Result<String, String> {
        if self.api_key().is_empty() || self.secret().is_empty() { return Err("Add your Last.fm API key and secret first".into()); }
        let Some(json) = self.call("auth.getToken", BTreeMap::new(), false).await else {
            let e = self.last_error.lock().unwrap().clone();
            return Err(if e.is_empty() { "Couldn't reach Last.fm".into() } else { e });
        };
        let Some(token) = json.get("token").and_then(Value::as_str).map(String::from) else { return Err("Couldn't reach Last.fm".into()) };
        *self.login_token.lock().unwrap() = token.clone();
        let _ = open::that(format!("https://www.last.fm/api/auth/?api_key={}&token={}", self.api_key(), token));
        for _ in 0..60 {
            tokio::time::sleep(Duration::from_secs(3)).await;
            if *self.login_token.lock().unwrap() != token { return Err("Cancelled".into()); }
            let mut p = BTreeMap::new();
            p.insert("token".to_string(), token.clone());
            if let Some(j) = self.call("auth.getSession", p, true).await {
                if let Some(key) = j.pointer("/session/key").and_then(Value::as_str) {
                    self.settings.set_secret("lastfmSession", key);
                    let name = j.pointer("/session/name").and_then(Value::as_str).unwrap_or("");
                    self.settings.put("lastfmUser", json!(name));
                    self.last_error.lock().unwrap().clear();
                    return Ok(name.to_string());
                }
            }
        }
        Err("Timed out waiting for the browser".into())
    }

    pub async fn set_user(&self, name: &str) -> Result<String, String> {
        let name = name.trim().trim_start_matches("https://www.last.fm/user/").trim_end_matches('/');
        if name.is_empty() { self.logout(); return Ok(String::new()); }
        if self.api_key().is_empty() { return Err("Add a Last.fm API key first".into()); }
        let mut p = serde_json::Map::new();
        p.insert("user".into(), json!(name));
        let (status, body) = self.read("user.getInfo", &p).await;
        if let Some(found) = body.pointer("/user/name").and_then(Value::as_str) {
            if !found.eq_ignore_ascii_case(&self.user()) { self.settings.set_secret("lastfmSession", ""); }
            self.settings.put("lastfmUser", json!(found));
            self.last_error.lock().unwrap().clear();
            return Ok(found.to_string());
        }
        Err(match body.get("message").and_then(Value::as_str) {
            Some(_) if body.get("error").and_then(Value::as_i64) == Some(6) => format!("Last.fm has no user called {name}"),
            Some(m) => m.to_string(),
            None if status == 0 => "Couldn't reach Last.fm".into(),
            None => format!("Last.fm answered {status}"),
        })
    }

    pub fn logout(&self) {
        self.login_token.lock().unwrap().clear();
        self.settings.set_secret("lastfmSession", "");
        self.settings.put("lastfmUser", json!(""));
    }

    pub async fn read(&self, method: &str, params: &serde_json::Map<String, Value>) -> (u16, Value) {
        if !READ_METHODS.contains(&method) { return (400, json!({"message": "Not allowed"})); }
        let key = self.api_key();
        if key.is_empty() { return (0, json!({"message": "no-key"})); }
        let mut p: BTreeMap<String, String> = BTreeMap::new();
        for (k, v) in params {
            match v { Value::String(s) => { p.insert(k.clone(), s.clone()); } Value::Number(n) => { p.insert(k.clone(), n.to_string()); } _ => {} }
        }
        p.insert("method".into(), method.into());
        p.insert("api_key".into(), key);
        p.insert("format".into(), "json".into());
        let user = self.user();
        if method.starts_with("user.") && p.get("user").map_or(true, |u| u.is_empty()) {
            if user.is_empty() { return (0, json!({"message": "no-user"})); }
            p.insert("user".into(), user.clone());
        }
        if (method == "track.getInfo" || method == "artist.getInfo") && p.get("username").map_or(true, |u| u.is_empty()) && !user.is_empty() {
            p.insert("username".into(), user);
        }
        // One at a time, a quarter of a second apart.
        let mut last = self.reading.lock().await;
        let wait = Duration::from_millis(250).saturating_sub(last.elapsed());
        if !wait.is_zero() { tokio::time::sleep(wait).await; }
        *last = Instant::now();
        let res = self.http.get(ENDPOINT).query(&p).timeout(Duration::from_secs(15)).send().await;
        drop(last);
        match res {
            Ok(r) => { let s = r.status().as_u16(); (s, r.json::<Value>().await.unwrap_or(Value::Null)) }
            Err(_) => (0, Value::Null),
        }
    }

    async fn call(&self, method: &str, mut p: BTreeMap<String, String>, quiet: bool) -> Option<Value> {
        p.insert("method".into(), method.into());
        p.insert("api_key".into(), self.api_key());
        let sig: String = p.iter().map(|(k, v)| format!("{k}{v}")).collect::<String>() + &self.secret();
        p.insert("api_sig".into(), format!("{:x}", Md5::digest(sig.as_bytes())));
        p.insert("format".into(), "json".into());
        let res = self.http.post(ENDPOINT).form(&p).timeout(Duration::from_secs(15)).send().await;
        let json = match res { Ok(r) => r.json::<Value>().await.ok(), Err(_) => None };
        let Some(json) = json else {
            if !quiet { *self.last_error.lock().unwrap() = "Couldn't reach Last.fm".into(); }
            return None;
        };
        if let Some(code) = json.get("error").and_then(Value::as_i64) {
            if !quiet {
                *self.last_error.lock().unwrap() = json.get("message").and_then(Value::as_str).map(String::from).unwrap_or_else(|| format!("Last.fm error {code}"));
            }
            if code == 9 { self.logout(); }                         // the session is no longer valid: log in again
            return None;
        }
        Some(json)
    }
}

pub async fn lyrics(http: &reqwest::Client, track: &str, artist: &str, album: &str, seconds: i64) -> Value {
    let get = |url: &str, q: Vec<(&str, String)>| {
        let req = http.get(url).query(&q).timeout(Duration::from_secs(12));
        async move {
            match req.send().await {
                Ok(r) if r.status().as_u16() == 200 => r.json::<Value>().await.ok(),
                _ => None,
            }
        }
    };
    let synced = |o: &Value| o.get("syncedLyrics").and_then(Value::as_str).map_or(false, |s| !s.is_empty());
    let has = |o: &Value| synced(o) || o.get("plainLyrics").and_then(Value::as_str).map_or(false, |s| !s.is_empty());
    let result = |o: &Value| json!({
        "synced": o.get("syncedLyrics").and_then(Value::as_str).unwrap_or(""),
        "plain": o.get("plainLyrics").and_then(Value::as_str).unwrap_or(""),
        "instrumental": o.get("instrumental").and_then(Value::as_bool).unwrap_or(false),
    });
    let pick = |hits: &[Value]| -> Option<Value> {
        let off = |o: &Value| (o.get("duration").and_then(Value::as_f64).unwrap_or(seconds as f64) - seconds as f64).abs();
        hits.iter().filter(|o| synced(o) && off(o) <= 8.0).min_by(|a, b| off(a).total_cmp(&off(b))).cloned()
    };

    let exact = get("https://lrclib.net/api/get", vec![("track_name", track.into()), ("artist_name", artist.into()),
        ("album_name", album.into()), ("duration", seconds.to_string())]).await.filter(Value::is_object);
    if let Some(e) = &exact { if synced(e) { return result(e); } }
    let hits: Vec<Value> = get("https://lrclib.net/api/search", vec![("track_name", track.into()), ("artist_name", artist.into())])
        .await.and_then(|v| v.as_array().cloned()).unwrap_or_default();
    if let Some(best) = pick(&hits) { return result(&best); }
    let a = artist.to_lowercase();
    let more: Vec<Value> = get("https://lrclib.net/api/search", vec![("q", format!("{artist} {track}"))])
        .await.and_then(|v| v.as_array().cloned()).unwrap_or_default().into_iter()
        .filter(|o| { let n = o.get("artistName").and_then(Value::as_str).unwrap_or("").to_lowercase(); !a.is_empty() && (n.contains(&a) || a.contains(&n)) })
        .collect();
    if let Some(best) = pick(&more) { return result(&best); }
    if let Some(e) = &exact { if has(e) { return result(e); } }
    hits.iter().chain(more.iter()).find(|o| has(o)).map(result).unwrap_or(Value::Null)
}

pub async fn genius_search(http: &reqwest::Client, token: &str, q: &str) -> Value {
    if token.is_empty() { return json!({"hits": null, "error": "no-token"}); }
    let res = http.get("https://api.genius.com/search").query(&[("q", q)]).bearer_auth(token)
        .timeout(Duration::from_secs(12)).send().await;
    let (status, body) = match res {
        Ok(r) => { let s = r.status().as_u16(); (s, r.json::<Value>().await.unwrap_or(Value::Null)) }
        Err(_) => (0, Value::Null),
    };
    if status == 401 { return json!({"hits": null, "error": "bad-token"}); }
    if status != 200 {
        return json!({"hits": null, "error": if status == 0 { "Couldn't reach Genius".to_string() } else { format!("Genius said {status}") }});
    }
    let hits: Vec<Value> = body.pointer("/response/hits").and_then(Value::as_array).map(|list| list.iter()
        .filter(|h| h.get("type").and_then(Value::as_str) == Some("song"))
        .filter_map(|h| {
            let r = h.get("result")?;
            let title = r.get("title")?.as_str()?;
            let artist = r.pointer("/primary_artist/name").and_then(Value::as_str)
                .or_else(|| r.get("artist_names").and_then(Value::as_str)).unwrap_or("");
            Some(json!({"title": title, "artist": artist}))
        }).collect()).unwrap_or_default();
    json!({"hits": hits, "error": null})
}

#[cfg(test)]
mod tests {
    use md5::{Digest, Md5};
    #[test]
    fn signature_matches_lastfms_rule() {
        let mut p = std::collections::BTreeMap::new();
        p.insert("method", "auth.getSession");
        p.insert("api_key", "KEY");
        p.insert("token", "TOK");
        let s: String = p.iter().map(|(k, v)| format!("{k}{v}")).collect::<String>() + "SECRET";
        assert_eq!(s, "api_keyKEYmethodauth.getSessiontokenTOKSECRET");
        assert_eq!(format!("{:x}", Md5::digest(s.as_bytes())).len(), 32);
    }
}
