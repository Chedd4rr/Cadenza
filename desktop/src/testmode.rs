//! Test mode: running this app beside your normal Cadenza to compare them, most usefully on a Mac, where
//! you can play the same song through the Swift app and this one and switch back and forth.
//!
//! The first time, it copies what it needs from your normal Cadenza folder into its own "Cadenza Test"
//! folder (sign-ins, taste profile, history, saved page data) and, on a Mac, your settings from the Swift
//! app's preferences (Client ID, EQ, crossfade, theme…). After that the two never share anything: test mode
//! only ever reads from your real folder, once, and never writes to it. Delete the test folder to start over.

use serde_json::{Map, Value};
use std::process::Command;

use crate::files;

/// Files copied from the real folder the first time.
const COPY: &[&str] = &[
    "spotify-token", "spotify-scopes", "secrets.json", "taste.json", "store.json", "history.jsonl",
    "spotify-history.json", "lastfm-plays.json", "settings.json", "librespot/credentials.json",
];

/// Settings read from the Mac app's preferences (UserDefaults), with their names here.
const MAC_SETTINGS: &[&str] = &[
    "clientId", "theme", "crossfade", "normalize", "bitrate", "volume", "autoplay", "trueShuffle", "playlistTags",
    "sfx", "sfxVolume", "reduceMotion", "themedCovers", "notifications", "lastfmKey", "lastfmUser", "discordAppId",
    "eqEnabled", "eqPreamp", "eqGains", "eqPreset", "eqPerDevice",
];
const MAC_DOMAIN: &str = "io.github.chedd4rr.cadenza";

pub fn prepare() {
    if !files::test_mode() { return; }
    let marker = files::path(".copied-from-real");
    if marker.exists() { return; }
    let real = files::real_dir();
    let mut copied = vec![];
    for name in COPY {
        let from = real.join(name);
        let Ok(data) = std::fs::read(&from) else { continue };
        let to = files::path(name);
        if let Some(dir) = to.parent() { let _ = std::fs::create_dir_all(dir); }
        if files::write_privately(&data, &to) { copied.push(*name); }
    }
    if cfg!(target_os = "macos") { import_mac_settings(); }
    files::write_privately(b"", &marker);
    log::info!("test mode: copied {} from {}", copied.join(", "), files::tidy(&real));
}

/// Reads the Swift app's preferences with macOS's own `defaults` and `plutil` tools, one setting at a time
/// (so one odd value can't spoil the rest), and saves them as this app's settings.
fn import_mac_settings() {
    let tmp = std::env::temp_dir().join(format!("cadenza-test-prefs-{}.plist", std::process::id()));
    let exported = Command::new("defaults").args(["export", MAC_DOMAIN]).arg(&tmp).status().map(|s| s.success()).unwrap_or(false);
    if !exported { return; }
    let mut settings = match files::read_json("settings.json") { Some(Value::Object(m)) => m, _ => Map::new() };
    let mut got = vec![];
    for key in MAC_SETTINGS {
        let out = Command::new("plutil").args(["-extract", key, "json", "-o", "-"]).arg(&tmp).output();
        let Ok(out) = out else { continue };
        if !out.status.success() { continue; }
        if let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) { settings.insert((*key).into(), v); got.push(*key); }
    }
    log::info!("test mode: settings from the Mac app: {}", if got.is_empty() { "none found".to_string() } else { got.join(", ") });
    let _ = std::fs::remove_file(&tmp);
    files::write_json("settings.json", &Value::Object(settings));
}
