//! Your preferences (settings.json) and passwords and tokens (secrets.json), both private files in the
//! support folder.

use serde_json::{json, Map, Value};
use std::sync::Mutex;

use crate::files;

/// Keys the page is allowed to read and change.
pub const KEYS: &[&str] = &[
    "theme", "notifications", "menuBar", "miniStyle", "playlistTags", "clientId", "manageLibrespot",
    "deviceName", "bitrate", "mediaKeys", "globalHotkey", "reduceMotion", "openAtLogin",
    "themedCovers", "sfx", "sfxVolume", "normalize", "eqPerDevice", "autoplay", "trueShuffle", "crossfade",
    "geniusToken", "discord", "discordAppId", "lastfmKey", "lastfmSecret", "updateRepo", "autoUpdate",
    "shortcuts",
];

/// Settings that are passwords or tokens. They live in secrets.json and are never sent back to the page.
pub const SECRET_KEYS: &[&str] = &["geniusToken", "lastfmSecret", "lastfmSession"];

pub const DEFAULT_REPO: &str = "Chedd4rr/Cadenza";

fn defaults() -> Map<String, Value> {
    let v = json!({
        "theme": "tide", "notifications": true, "menuBar": true, "miniStyle": "theme", "playlistTags": true,
        "clientId": "", "manageLibrespot": true, "deviceName": "Cadenza", "bitrate": 320,
        "mediaKeys": true, "globalHotkey": true, "reduceMotion": "system", "themedCovers": false, "volume": 70,
        "sfx": true, "sfxVolume": 55, "normalize": true, "eqPerDevice": true, "autoplay": true,
        "trueShuffle": true, "crossfade": 6, "discord": false, "discordAppId": "", "lastfmKey": "",
        "updateRepo": DEFAULT_REPO, "autoUpdate": true, "openAtLogin": false,
        "shortcuts": {},
    });
    match v { Value::Object(m) => m, _ => Map::new() }
}

pub struct Settings {
    values: Mutex<Map<String, Value>>,
    secrets: Mutex<Map<String, Value>>,
}

impl Settings {
    pub fn load() -> Self {
        let values = match files::read_json("settings.json") { Some(Value::Object(m)) => m, _ => Map::new() };
        let secrets = match files::read_json("secrets.json") { Some(Value::Object(m)) => m, _ => Map::new() };
        Settings { values: Mutex::new(values), secrets: Mutex::new(secrets) }
    }

    /// A value, falling back to its default.
    pub fn get(&self, key: &str) -> Value {
        if let Some(v) = self.values.lock().unwrap().get(key) { return v.clone(); }
        defaults().get(key).cloned().unwrap_or(Value::Null)
    }

    pub fn string(&self, key: &str) -> String {
        self.get(key).as_str().unwrap_or("").trim().to_string()
    }
    pub fn bool(&self, key: &str) -> bool {
        self.get(key).as_bool().unwrap_or(false)
    }
    pub fn int(&self, key: &str) -> i64 {
        let v = self.get(key);
        v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)).unwrap_or(0)
    }

    pub fn client_id(&self) -> String { self.string("clientId") }
    pub fn device_name(&self) -> String {
        let n = self.string("deviceName");
        let n = if n.is_empty() { "Cadenza".to_string() } else { n };
        // In test mode Spotify lists it as a separate speaker, so you can move the music between the two.
        if crate::files::test_mode() && !n.ends_with("(test)") { format!("{n} (test)") } else { n }
    }
    pub fn bitrate(&self) -> i64 {
        let b = self.int("bitrate");
        if [96, 160, 320].contains(&b) { b } else { 320 }
    }
    pub fn volume(&self) -> i64 { self.int("volume").clamp(0, 100) }

    pub fn secret(&self, key: &str) -> String {
        self.secrets.lock().unwrap().get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
    }

    /// Saves the value, or deletes it when empty. False if the file couldn't be written.
    pub fn set_secret(&self, key: &str, value: &str) -> bool {
        let mut s = self.secrets.lock().unwrap();
        if value.is_empty() { s.remove(key); } else { s.insert(key.into(), Value::String(value.into())); }
        files::write_json("secrets.json", &Value::Object(s.clone()))
    }

    /// Everything the page may see. Secrets only say whether they're set.
    pub fn all(&self) -> Value {
        let mut out = Map::new();
        for &k in KEYS {
            if SECRET_KEYS.contains(&k) {
                out.insert(k.into(), Value::String(if self.secret(k).is_empty() { "" } else { "set" }.into()));
            } else {
                out.insert(k.into(), self.get(k));
            }
        }
        out.insert("deviceName".into(), Value::String(self.device_name()));
        out.insert("bitrate".into(), json!(self.bitrate()));
        Value::Object(out)
    }

    /// False for keys the page isn't allowed to set.
    pub fn set(&self, key: &str, value: &Value) -> bool {
        if !KEYS.contains(&key) { return false; }
        if SECRET_KEYS.contains(&key) {
            return self.set_secret(key, value.as_str().unwrap_or("").trim());
        }
        let v = match value { Value::String(s) => Value::String(s.trim().to_string()), other => other.clone() };
        self.put(key, v)
    }

    /// For values the app keeps itself (the volume), without the page's key check.
    pub fn put(&self, key: &str, value: Value) -> bool {
        let mut m = self.values.lock().unwrap();
        m.insert(key.into(), value);
        files::write_json("settings.json", &Value::Object(m.clone()))
    }
}
