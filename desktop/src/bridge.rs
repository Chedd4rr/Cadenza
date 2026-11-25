//! The page's one way into the app: `native(cmd, args)` in app.js arrives here as the `native` command,
//! and answers with the data the page expects, the same as demo mode's made-up answers.

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
        "player.direct" => {
            let action = args.get("action").and_then(Value::as_str).unwrap_or("").to_string();
            core.librespot.direct(&action, &args)
        }
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

        // The taste profile, or (with a "mode") that mode's own profile, kept in its own file.
        "taste.get" => taste_file(args).and_then(|f| files::read_json(&f)).filter(Value::is_object).unwrap_or(Value::Null),
        "taste.set" => json!(taste_file(args).map(|f| save_capped(&f, args.get("value"), 8 << 20, true)).unwrap_or(false)),
        "taste.remove" => {
            // Deleting a mode's profile (the main one is only ever cleared with "taste.clear").
            let gone = args.get("mode").and_then(Value::as_str).filter(|m| !m.is_empty()).and_then(|_| taste_file(args))
                .map(|f| std::fs::remove_file(files::path(&f)).is_ok()).unwrap_or(false);
            json!(gone)
        }
        "taste.clear" => {
            let yes = ask(window, "Forget your taste profile?",
                "Autoplay starts learning from scratch. Your history, likes and playlists aren't touched, and you can rebuild it from your imported history any time.",
                Some("Forget")).await;
            if yes { if let Some(f) = taste_file(args) { let _ = std::fs::remove_file(files::path(&f)); } }
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

        // MARK: saving and opening your own files (Wrapped pictures, playlist backups). You choose the place
        // in a dialog, so the page never decides where anything is written or read.
        "file.save" => save_file(window, args).await,
        "file.open" => open_file(window, args).await,

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
        // Headphone EQ: search AutoEq's list, download one profile, or read an Equalizer APO file's text.
        "eq.autoeqSearch" => crate::autoeq::find(&core.http, &s(args, "q")).await,
        "eq.autoeqLoad" => crate::autoeq::load(&core.http, &s(args, "path")).await,
        "eq.parse" => {
            let text = s(args, "text");
            if text.len() > 1 << 20 { json!({"ok": false, "message": "That file is too large"}) } else { crate::autoeq::parsed(&text, &s(args, "name")) }
        }
        "sound.tone" => { core.sound.test_tone(&s(args, "which")); json!(true) }
        "sound.buffer" => core.sound.buffer(args.get("frames").and_then(Value::as_u64)),
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

        // MARK: the signal path (signalpath.rs)
        "sound.path" => {
            let (song, here) = core.librespot.song_path();
            #[cfg(target_os = "macos")]
            let device_rate = crate::macaudio::default_output_rate();
            #[cfg(not(target_os = "macos"))]
            let device_rate = None;
            crate::signalpath::build(crate::signalpath::Input { song, here, settings: &core.settings, out: core.sound.path_info(), device_rate })
        }

        // MARK: updates (updater.rs)
        "update.status" => core.updater.status(),
        "update.check" => core.updater.check().await,
        "update.install" => core.updater.install().await,

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

/// A setting changed: put it into effect.
fn apply_setting(core: &Arc<Core>, window: &WebviewWindow, key: &str) {
    let managed = core.settings.bool("manageLibrespot");
    match key {
        "manageLibrespot" => if managed { core.librespot.start() } else { core.librespot.stop() },
        "deviceName" | "bitrate" | "normalize" | "autoplay" => if managed { core.librespot.restart() },
        "normalizeType" => core.librespot.loudness_changed(),
        "matchRate" | "exclusive" => core.sound.reopen(),
        "balance" | "mono" | "swapChannels" | "invertPolarity" => core.sound.apply_channels(),
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
/// The file for a taste profile: taste.json, or taste-<mode>.json for a mode (a short name of letters and
/// digits, so it can't point anywhere else). None if the mode name isn't one.
fn taste_file(args: &Value) -> Option<String> {
    match args.get("mode").and_then(Value::as_str).filter(|m| !m.is_empty()) {
        None => Some("taste.json".into()),
        Some(m) if m.len() <= 24 && m.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) => Some(format!("taste-{m}.json")),
        Some(_) => None,
    }
}

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

/// Saves a file the page made (a picture, or text such as a backup) where you choose: {name, kind: "png" |
/// "json", base64 or text}. Answers {ok, name} or {ok: false} if you cancel.
async fn save_file(window: &WebviewWindow, args: &Value) -> Value {
    let kind = match args.get("kind").and_then(Value::as_str) { Some("png") => "png", Some("json") => "json", _ => return json!({"ok": false, "message": "Unknown file type"}) };
    let data: Vec<u8> = if let Some(b) = args.get("base64").and_then(Value::as_str) {
        match base64::engine::general_purpose::STANDARD.decode(b.trim_start_matches("data:image/png;base64,")) { Ok(d) => d, Err(_) => return json!({"ok": false, "message": "Couldn't read the picture"}) }
    } else if let Some(t) = args.get("text").and_then(Value::as_str) { t.as_bytes().to_vec() } else { return json!({"ok": false, "message": "Nothing to save"}) };
    if data.len() > 32 << 20 { return json!({"ok": false, "message": "That's too large to save"}); }
    // A plain file name: no folders, nothing odd.
    let name: String = args.get("name").and_then(Value::as_str).unwrap_or("Cadenza").chars()
        .filter(|c| c.is_alphanumeric() || " ._-()".contains(*c)).take(80).collect();
    let name = if name.to_lowercase().ends_with(&format!(".{kind}")) { name } else { format!("{name}.{kind}") };
    let (tx, rx) = tokio::sync::oneshot::channel();
    let label = if kind == "png" { "Picture (.png)" } else { "Cadenza file (.json)" };
    window.dialog().file().set_parent(window).set_title("Save").set_file_name(&name).add_filter(label, &[kind])
        .save_file(move |p| { let _ = tx.send(p); });
    let Some(path) = rx.await.ok().flatten().and_then(|p| p.into_path().ok()) else { return json!({"ok": false}) };
    match std::fs::write(&path, &data) {
        Ok(()) => json!({"ok": true, "name": path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()}),
        Err(e) => json!({"ok": false, "message": format!("Couldn't save it: {e}")}),
    }
}

/// Reads a .json file you choose (a backup): {ok, name, text}, or {ok: false} if you cancel. At most 16 MB.
async fn open_file(window: &WebviewWindow, args: &Value) -> Value {
    let title = args.get("title").and_then(Value::as_str).unwrap_or("Open").chars().take(80).collect::<String>();
    let (tx, rx) = tokio::sync::oneshot::channel();
    // "json" (a Cadenza backup) or "txt" (an EQ file in Equalizer APO's format).
    let (label, ext): (&str, &[&str]) = if args.get("kind").and_then(Value::as_str) == Some("txt") { ("EQ file (.txt)", &["txt"]) } else { ("Cadenza file (.json)", &["json"]) };
    window.dialog().file().set_parent(window).set_title(&title).add_filter(label, ext)
        .pick_file(move |p| { let _ = tx.send(p); });
    let Some(path) = rx.await.ok().flatten().and_then(|p| p.into_path().ok()) else { return json!({"ok": false}) };
    match std::fs::metadata(&path) {
        Ok(m) if m.len() <= 16 << 20 => {}
        _ => return json!({"ok": false, "message": "That file is too large"}),
    }
    match std::fs::read_to_string(&path) {
        Ok(text) => json!({"ok": true, "name": path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), "text": text}),
        Err(_) => json!({"ok": false, "message": "Couldn't read that file"}),
    }
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

/// One setting decides what code Cadenza runs: the GitHub repository it installs updates from. The page
/// can't change it on its own: a dialog asks you first.
async fn confirm_setting(core: &Core, window: &WebviewWindow, key: &str, value: &Value) -> bool {
    let new = value.as_str().unwrap_or("").trim().to_string();
    match key {
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
    // Redacted: your home folder, your Spotify username, search words.
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

#[cfg(test)]
mod taste_file_tests {
    use super::taste_file;
    use serde_json::json;

    #[test]
    fn modes_get_their_own_safe_file() {
        assert_eq!(taste_file(&json!({})).as_deref(), Some("taste.json"));
        assert_eq!(taste_file(&json!({"mode": ""})).as_deref(), Some("taste.json"));
        assert_eq!(taste_file(&json!({"mode": "focus2"})).as_deref(), Some("taste-focus2.json"));
        assert_eq!(taste_file(&json!({"mode": "../x"})), None);
        assert_eq!(taste_file(&json!({"mode": "Focus"})), None);
        assert_eq!(taste_file(&json!({"mode": "a".repeat(25)})), None);
    }
}
