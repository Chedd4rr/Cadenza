//! Moving over from the Swift Mac app. Both apps use the same folder (~/Library/Application Support/
//! Cadenza), so the Spotify sign-in, librespot's login, secrets.json, history, the taste profile and the
//! saved page data are simply there. Only the settings live elsewhere: the Swift app keeps them in macOS's
//! preferences (UserDefaults). The first time this app starts on a Mac, it reads them from there into
//! settings.json, once. Nothing the Swift app reads is changed, so you can still go back to it.

use serde_json::{Map, Value};
use std::process::Command;

use crate::files;

const DOMAIN: &str = "io.github.chedd4rr.cadenza";

/// Every setting the Swift app keeps in UserDefaults that this app uses, under the same names. (Passwords
/// and tokens aren't here: the Swift app already keeps those in secrets.json. Start at login isn't
/// either: that's the system's own setting, read live.)
pub const MAC_SETTINGS: &[&str] = &[
    "clientId", "theme", "notifications", "menuBar", "miniStyle", "playlistTags", "manageLibrespot",
    "deviceName", "bitrate", "mediaKeys", "globalHotkey", "reduceMotion", "themedCovers",
    "sfx", "sfxVolume", "normalize", "autoplay", "trueShuffle", "crossfade", "discord", "discordAppId",
    "lastfmKey", "lastfmUser", "updateRepo", "autoUpdate", "volume", "floatingPlayer",
    "eqEnabled", "eqPreamp", "eqGains", "eqPreset", "eqPerDevice", "eqProfiles",
];

/// On a Mac, the first time (not in test mode, which does its own copy): bring the Swift app's settings over.
pub fn run() {
    if !cfg!(target_os = "macos") || files::test_mode() { return; }
    let marker = files::path(".settings-from-mac-app");
    if marker.exists() { return; }
    let got = import_mac_settings();
    // Only mark it done once it worked (or there was nothing to bring over), so a hiccup tries again next time.
    if got.is_some() { files::write_privately(b"", &marker); }
}

/// Reads the Swift app's preferences with macOS's own `defaults` and `plutil` tools, one setting at a time
/// (so one odd value can't spoil the rest), and saves them into settings.json. They win over anything
/// already there, which can only be from an earlier try of this app. Returns the names brought over, or
/// None if the preferences couldn't be read.
pub fn import_mac_settings() -> Option<Vec<&'static str>> {
    let tmp = std::env::temp_dir().join(format!("cadenza-prefs-{}.plist", std::process::id()));
    let exported = Command::new("defaults").args(["export", DOMAIN]).arg(&tmp).status().map(|s| s.success()).unwrap_or(false);
    if !exported {
        // No preferences at all means the Swift app was never used here: nothing to bring over.
        log::info!("settings from the Mac app: none found");
        return Some(vec![]);
    }
    let mut settings = match files::read_json("settings.json") { Some(Value::Object(m)) => m, _ => Map::new() };
    let mut got = vec![];
    for key in MAC_SETTINGS {
        let Ok(out) = Command::new("plutil").args(["-extract", key, "json", "-o", "-"]).arg(&tmp).output() else { continue };
        if !out.status.success() { continue; }
        if let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) { settings.insert((*key).into(), v); got.push(*key); }
    }
    let _ = std::fs::remove_file(&tmp);
    log::info!("settings from the Mac app: {}", if got.is_empty() { "none found".to_string() } else { got.join(", ") });
    if !got.is_empty() && !files::write_json("settings.json", &Value::Object(settings)) { return None; }
    Some(got)
}
