//! The page's one way into the app: `native(cmd, args)` in app.js arrives here as the `native` command,
//! and answers with the same data Bridge.swift sends, so the page can't tell which app it's running in.
//!
//! Commands that aren't ported yet (the sound engine, system parts, updates) answer the way demo mode
//! does (an empty list, "not connected"), so the page keeps working around them. Each is marked with the
//! phase that brings it.

use base64::Engine;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::{files, Core};

fn s(args: &Value, key: &str) -> String { args.get(key).and_then(Value::as_str).unwrap_or("").to_string() }
fn b(args: &Value, key: &str, default: bool) -> bool { args.get(key).and_then(Value::as_bool).unwrap_or(default) }

#[tauri::command]
pub async fn native(window: WebviewWindow, core: tauri::State<'_, Arc<Core>>, cmd: String, args: Option<Value>) -> Result<Value, String> {
    // Only Cadenza's own page may talk to the app: the main window, showing the app's own files.
    let url = window.url().map_err(|e| e.to_string())?;
    let own = url.scheme() == "tauri" || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    if window.label() != "main" || !own { return Err("Not allowed".into()); }
    let core = Arc::clone(&core);
    let args = args.unwrap_or(Value::Null);
    log::info!("native {cmd}");
    handle(&core, &window, &cmd, &args).await
}

async fn handle(core: &Arc<Core>, window: &WebviewWindow, cmd: &str, args: &Value) -> Result<Value, String> {
    Ok(match cmd {
        // MARK: Spotify
        "api" => {
            let method = args.get("method").and_then(Value::as_str).unwrap_or("GET");
            let path = args.get("path").and_then(Value::as_str).unwrap_or("/");
            let (status, body) = core.api.request(method, path, args.get("body")).await;
            json!({"status": status, "body": body})
        }
        "api.activity" => core.api.activity(),

        "auth.status" => {
            // Refresh first, so we know which permissions the current login has.
            let _ = core.auth.token().await;
            json!({"loggedIn": core.auth.is_logged_in(), "clientId": core.settings.client_id(),
                   "redirectURI": crate::auth::REDIRECT_URI, "missingScopes": core.auth.missing_scopes()})
        }
        "auth.setClientId" => {
            let id = s(args, "clientId").trim().to_string();
            if id != core.settings.client_id() { core.auth.logout().await; core.api.reset_block(); }   // the old login belongs to the old Client ID
            core.settings.put("clientId", json!(id));
            json!(true)
        }
        "auth.login" => match core.auth.login().await {
            Ok(()) => { let _ = window.set_focus(); json!({"ok": true, "message": null}) }
            Err(m) => json!({"ok": false, "message": m}),
        },
        "auth.logout" => { core.auth.logout().await; core.api.reset_block(); json!(true) }

        // MARK: the engine
        "librespot.status" => core.librespot.status(),
        "librespot.restart" => { core.librespot.restart_keep_playing(); json!(true) }
        "engine.ensure" => json!({"ok": core.librespot.check_device().await}),
        "librespot.transferHere" => {
            let play = b(args, "play", true);
            let ls = Arc::clone(&core.librespot);
            tauri::async_runtime::spawn(async move { ls.transfer_here(play, 6).await; });
            json!(true)
        }

        // MARK: settings and saved data
        "settings.get" => settings_for_page(core),
        "settings.set" => {
            let key = s(args, "key");
            let Some(value) = args.get("value") else { return Ok(json!(false)) };
            if confirm_setting(core, window, &key, value).await {
                if key == "clientId" && value.as_str().map(str::trim) != Some(core.settings.client_id().as_str()) {
                    core.auth.logout().await;
                    core.api.reset_block();
                }
                core.settings.set(&key, value);
                apply_setting(core, window, &key);
            }
            settings_for_page(core)
        }
        "store.get" => core.store.get(&s(args, "key")),
        "store.set" => { core.store.set(&s(args, "key"), args.get("value").cloned().unwrap_or(Value::Null)); json!(true) }

        "taste.get" => files::read_json("taste.json").filter(Value::is_object).unwrap_or(Value::Null),
        "taste.set" => json!(save_capped("taste.json", args.get("value"), 8 << 20, true)),
        "taste.clear" => {
            let yes = ask(window, "Forget your taste profile?",
                "Autoplay starts learning from scratch. Your history, likes and playlists aren't touched, and you can rebuild it from your imported history any time.",
                Some("Forget")).await;
            if yes { let _ = std::fs::remove_file(files::path("taste.json")); }
            json!(yes)
        }
        "lastfmPlays.get" => files::read_json("lastfm-plays.json").unwrap_or(Value::Null),
        "lastfmPlays.set" => {
            // Only the expected shape: {user, upTo, plays: [[time, song, artist, album]]}.
            let v = args.get("value");
            let shaped = v.map_or(false, |v| v.get("user").map_or(false, Value::is_string)
                && v.get("upTo").map_or(false, Value::is_number) && v.get("plays").map_or(false, Value::is_array));
            json!(shaped && save_capped("lastfm-plays.json", v, 64 << 20, false))
        }
        "history.get" => {
            let since = args.get("since").and_then(Value::as_f64).unwrap_or(0.0);
            tauri::async_runtime::spawn_blocking(move || crate::history::entries(since)).await.unwrap_or(json!([]))
        }
        "spotifyHistory.get" => {
            let h = Arc::clone(&core.spotify_history);
            tauri::async_runtime::spawn_blocking(move || h.snapshot()).await.unwrap_or(json!({"tracks": [], "plays": []}))
        }
        "spotifyHistory.import" => {
            // You pick the files in a dialog, so the page never chooses what gets read.
            let picked = pick_history_files(window).await;
            if picked.is_empty() { return Ok(Value::Null); }
            let h = Arc::clone(&core.spotify_history);
            tauri::async_runtime::spawn_blocking(move || h.import(&picked)).await.unwrap_or(Value::Null)
        }
        "spotifyHistory.clear" => {
            let yes = ask(window, "Remove your imported Spotify history?",
                "Stats goes back to Last.fm or Cadenza's own history. Your Spotify account and the files you imported aren't touched, and you can import them again any time.",
                Some("Remove")).await;
            if yes { let h = Arc::clone(&core.spotify_history); let _ = tauri::async_runtime::spawn_blocking(move || h.clear()).await; }
            json!(yes)
        }

        // MARK: the window and the system
        "clipboard" => { let _ = window.app_handle().clipboard().write_text(s(args, "text")); json!(true) }
        "openURL" => {
            // Only Spotify links and web pages. Anything else (file paths, other apps' links) could start programs.
            let link = s(args, "url");
            if let Ok(u) = url::Url::parse(&link) {
                if matches!(u.scheme().to_ascii_lowercase().as_str(), "spotify" | "https") { let _ = open::that(link); }
            }
            json!(true)
        }
        "window.fullscreen" => {
            let was = window.is_fullscreen().unwrap_or(false);
            let on = args.get("on").and_then(Value::as_bool).unwrap_or(!was);
            if on != was { let _ = window.set_fullscreen(on); }
            json!(was)
        }
        "diagnostics" => {
            let text = diagnostics(core);
            let _ = window.app_handle().clipboard().write_text(text.clone());
            json!(text)
        }
        "cover.dataURL" => cover_data_url(core, &s(args, "url")).await.map(Value::String).unwrap_or(Value::Null),

        // MARK: Last.fm, lyrics, Genius, translation
        "lastfm.status" => core.lastfm.status(),
        "lastfm.login" => {
            let r = core.lastfm.login().await;
            (core.emit)("lastfm", core.lastfm.status());
            match r {
                Ok(user) => { let _ = window.set_focus(); json!({"ok": true, "message": user}) }
                Err(m) => json!({"ok": false, "message": m}),
            }
        }
        // Choosing a new shortcut: the Mac menu's shortcuts and the show/hide shortcut step aside meanwhile,
        // or they'd catch the keys before the page.
        "shortcuts.capture" => {
            let on = b(args, "on", false);
            crate::rebuild_menu(window.app_handle(), on);
            if on {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let _ = window.app_handle().global_shortcut().unregister_all();
            } else {
                crate::apply_hotkey(window.app_handle());
            }
            json!(true)
        }
        "lastfm.setUser" => {
            let r = core.lastfm.set_user(&s(args, "user")).await;
            if r.is_ok() { let _ = std::fs::remove_file(files::path("lastfm-plays.json")); }   // the old account's plays
            (core.emit)("lastfm", core.lastfm.status());
            match r { Ok(user) => json!({"ok": true, "message": user}), Err(m) => json!({"ok": false, "message": m}) }
        }
        "lastfm.get" => {
            let params = args.get("params").and_then(Value::as_object).cloned().unwrap_or_default();
            let (status, body) = core.lastfm.read(&s(args, "method"), &params).await;
            json!({"status": status, "body": body})
        }
        "lastfm.logout" => {
            core.lastfm.logout();
            let _ = std::fs::remove_file(files::path("lastfm-plays.json"));
            (core.emit)("lastfm", core.lastfm.status());
            json!(true)
        }
        "lyrics" => {
            let secs = args.get("seconds").and_then(Value::as_i64).unwrap_or(0);
            crate::lastfm::lyrics(&core.http, &s(args, "track"), &s(args, "artist"), &s(args, "album"), secs).await
        }
        "genius.search" => crate::lastfm::genius_search(&core.http, &core.settings.secret("geniusToken"), &s(args, "q")).await,
        "translate.models" => {
            let emit = core.emit.clone();
            let below = args.get("below").and_then(Value::as_str).map(String::from);
            crate::translation::prepare(&core.http, &s(args, "from"), &s(args, "to"), below.as_deref(), crate::files_base(),
                move |got, total| emit("translate.progress", json!({"got": got, "total": total}))).await
        }
        "translate.size" => json!(crate::translation::disk_usage()),
        "translate.clear" => { crate::translation::clear(); json!(true) }

        "cover.upload" => {
            let id = s(args, "playlistId");
            if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) { return Ok(json!({"status": 0})); }
            let Some(path) = pick_image(window).await else { return Ok(json!({"status": 0})) };
            let Ok(Some(b64)) = tauri::async_runtime::spawn_blocking(move || crate::cover::jpeg_base64(&path)).await else {
                return Ok(json!({"status": 0}));
            };
            json!({"status": core.api.upload("PUT", &format!("/playlists/{id}/images"), b64.into_bytes(), "image/jpeg").await})
        }

        // MARK: the sound engine
        "eq.get" => core.sound.eq_state(),
        "eq.set" => core.sound.eq_update(args),
        "eq.engine" => json!(true),                        // always on here: Cadenza's engine is the only way sound plays
        "eq.meter" => { core.sound.set_meter(b(args, "on", false)); json!(true) }
        "audio.local" => {
            // Instant pause, play and skip when this computer's engine is the one playing.
            if core.librespot.is_active_here() {
                let action = s(args, "action");
                core.sound.local(&action, core.librespot.is_playing_here());
                if action == "pause" || (action == "toggle" && core.sound.holding()) { core.librespot.verify_pause(); }
            }
            json!(true)
        }
        "outputs.list" => core.sound.outputs(),
        "outputs.set" => json!(core.sound.set_output(&s(args, "uid"))),

        // MARK: outside the window (system.rs, discord.rs)
        "nowplaying" => {
            core.system.now_playing(args.clone());
            let d = Arc::clone(&core.discord);
            let a = args.clone();
            tauri::async_runtime::spawn_blocking(move || d.update(&a));
            json!(true)
        }
        "mini.toggle" => json!(core.system.toggle_mini()),
        "discord.status" => core.discord.status(),
        "app.quit" => { window.app_handle().exit(0); json!(true) }

        // MARK: not ported yet, answered like demo mode




        "update.status" | "update.check" => json!({"repo": core.settings.string("updateRepo"), "current": env!("CARGO_PKG_VERSION"), "state": "idle", "message": "", "auto": false}),   // phase 7
        "update.install" => json!({"ok": false, "message": "Updates come in phase 7 of the port."}),

        _ => { log::info!("unknown command {cmd} {args}"); return Err(format!("Unknown command: {cmd}")) }
    })
}

fn settings_for_page(core: &Core) -> Value {
    let mut v = core.settings.all();
    v["mediaKeysTrusted"] = json!(true);
    // Whether this copy has Cadenza's own Last.fm key and Discord ID built in (the page then needs neither).
    v["builtinLastfm"] = json!(!crate::builtin::LASTFM_KEY.is_empty());
    v["builtinDiscord"] = json!(!crate::builtin::DISCORD_APP_ID.is_empty());
    // Whether Cadenza really starts at login, as the system has it.
    v["openAtLogin"] = json!(crate::loginitem::enabled(core.system.app()));
    v
}

/// A setting changed: put it into effect (AppDelegate.applySetting in the Mac app).
fn apply_setting(core: &Arc<Core>, window: &WebviewWindow, key: &str) {
    let managed = core.settings.bool("manageLibrespot");
    match key {
        "manageLibrespot" => if managed { core.librespot.start() } else { core.librespot.stop() },
        "librespotPath" | "deviceName" | "bitrate" | "normalize" | "autoplay" => if managed { core.librespot.restart() },
        "globalHotkey" => crate::apply_hotkey(window.app_handle()),
        // Your shortcuts changed on the keyboard page: the Mac menu and the show/hide shortcut follow.
        "shortcuts" => { crate::rebuild_menu(window.app_handle(), false); crate::apply_hotkey(window.app_handle()); }
        "menuBar" => core.system.set_tray(core.settings.bool("menuBar")),
        "miniStyle" | "reduceMotion" => core.system.push_mini(),
        "discord" | "discordAppId" => {
            let d = Arc::clone(&core.discord);
            std::thread::spawn(move || d.restart());
            (core.emit)("refresh", Value::Null);
        }
        "openAtLogin" => { crate::loginitem::set(window.app_handle(), core.settings.bool("openAtLogin")); }
        _ => {}
    }
}

/// Saves a JSON object the page hands over, refusing anything odd or too big.
fn save_capped(name: &str, value: Option<&Value>, max: usize, needs_version: bool) -> bool {
    let Some(v) = value.filter(|v| v.is_object()) else { return false };
    if needs_version && !v.get("v").map(Value::is_number).unwrap_or(false) { return false; }
    let Ok(data) = serde_json::to_vec(v) else { return false };
    data.len() <= max && files::write_privately(&data, &files::path(name))
}

/// Cadenza's own listening log, one JSON play per line.
/// The Spotify history files to import: the .zip Spotify sends, or the .json files from it.
async fn pick_history_files(window: &WebviewWindow) -> Vec<std::path::PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window.dialog().file().set_parent(window).set_title("Import your Spotify listening history")
        .add_filter("Spotify history (.zip or .json)", &["zip", "json"])
        .pick_files(move |paths| { let _ = tx.send(paths); });
    rx.await.ok().flatten().unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect()
}

/// A picture for a playlist cover.
async fn pick_image(window: &WebviewWindow) -> Option<std::path::PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window.dialog().file().set_parent(window).set_title("Choose a cover image for this playlist")
        .add_filter("Images", &["jpg", "jpeg", "png", "webp", "gif", "bmp"])
        .pick_file(move |path| { let _ = tx.send(path); });
    rx.await.ok().flatten().and_then(|p| p.into_path().ok())
}

/// A dialog on the main window. With `ok` None it's just a notice (answers false).
async fn ask(window: &WebviewWindow, title: &str, text: &str, ok: Option<&str>) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut d = window.dialog().message(text).title(title).parent(window);
    d = match ok {
        Some(ok) => d.kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancelCustom(ok.into(), "Cancel".into())),
        None => d.buttons(MessageDialogButtons::Ok),
    };
    d.show(move |yes| { let _ = tx.send(yes); });
    let yes = rx.await.unwrap_or(false);
    ok.is_some() && yes
}

/// Two settings decide what code Cadenza runs: the librespot program it starts, and the GitHub repository
/// it installs updates from. The page can't change them on its own: a dialog asks you first.
async fn confirm_setting(core: &Core, window: &WebviewWindow, key: &str, value: &Value) -> bool {
    let new = value.as_str().unwrap_or("").trim().to_string();
    match key {
        "librespotPath" => {
            if new.is_empty() || new == core.settings.string("librespotPath") { return true; }
            let path = match (new.strip_prefix("~/"), dirs::home_dir()) { (Some(r), Some(h)) => h.join(r), _ => new.clone().into() };
            if !path.is_file() {
                ask(window, "That isn't a program", &format!("Cadenza couldn't find a program at {}. Point it at the librespot file itself.", path.display()), None).await;
                return false;
            }
            ask(window, "Use this program as the audio engine?",
                &format!("Cadenza will start {} every time it opens and send it your music. Only choose a librespot you installed yourself.", path.display()),
                Some("Use It")).await
        }
        "updateRepo" => {
            let mut repo = new.trim_start_matches("https://github.com/").trim_end_matches(".git").trim_matches('/').to_string();
            if repo.is_empty() || repo == core.settings.string("updateRepo") || repo == crate::settings::DEFAULT_REPO { return true; }
            let valid = regex::Regex::new(r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$").unwrap().is_match(&repo);
            if !valid {
                ask(window, "That isn't a GitHub repository", &format!("Write it as owner/name, for example {}.", crate::settings::DEFAULT_REPO), None).await;
                return false;
            }
            repo = repo.clone();
            ask(window, &format!("Get updates from {repo}?"),
                &format!("Cadenza will offer to install new versions published at github.com/{repo}. Only pick a repository you trust."),
                Some("Use It")).await
        }
        _ => true,
    }
}

/// The cover as a data: URL, for themes that read its colours (the page can't read the pixels of a
/// picture from another site). Only from Spotify's and Last.fm's picture servers, and only JPEG or PNG,
/// so this can't become a way for the page to read anything else.
async fn cover_data_url(core: &Core, link: &str) -> Option<String> {
    let u = url::Url::parse(link).ok()?;
    let host = u.host_str()?.to_ascii_lowercase();
    let allowed = ["scdn.co", "spotifycdn.com", "spotify.com", "fastly.net", "last.fm", "lst.fm"];
    if u.scheme() != "https" || !allowed.iter().any(|a| host == *a || host.ends_with(&format!(".{a}"))) { return None; }
    let bytes = core.http.get(u).timeout(std::time::Duration::from_secs(15)).send().await.ok()?.bytes().await.ok()?;
    let mime = if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) { "image/jpeg" } else if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) { "image/png" } else { return None };
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

fn diagnostics(core: &Core) -> String {
    let mut out = vec![
        format!("Cadenza {} (Tauri, {} {}){}", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH,
                if crate::files::test_mode() { ", test mode" } else { "" }),
        format!("signed in to Spotify: {}", core.auth.is_logged_in()),
        String::new(),
    ];
    out.extend(core.librespot.diagnostics());
    out.push(String::new());
    out.push("== Spotify requests (latest) ==".into());
    out.extend(core.api.recent_log(40));
    out.push(String::new());
    out.push("== sound output ==".into());
    out.push(core.sound.output_name());
    out.extend(core.sound.log().into_iter().rev().take(30).rev());
    let text = out.join("\n");
    // The same redactions as the Mac app: your home folder, your Spotify username, search words.
    let mut text = match dirs::home_dir() { Some(h) => text.replace(&h.display().to_string(), "~"), None => text };
    let user = regex::Regex::new(r#"Authenticated as ['"][^'"]*['"]"#).unwrap();
    text = user.replace_all(&text, "Authenticated as '(hidden)'").to_string();
    // Your login name, as a whole word (it can turn up in paths that aren't under your home folder).
    for var in ["USER", "USERNAME", "LOGNAME"] {
        if let Ok(name) = std::env::var(var) {
            if name.len() >= 2 {
                let re = regex::Regex::new(&format!(r"\b{}\b", regex::escape(&name))).unwrap();
                text = re.replace_all(&text, "(you)").to_string();
            }
        }
    }
    let q = regex::Regex::new(r"([?&]q=)[^&\s]*").unwrap();
    q.replace_all(&text, "${1}…").to_string()
}
