//! The page's one way into the app: `native(cmd, args)` in app.js arrives here as the `native` command,
//! and answers with the same data Bridge.swift sends, so the page can't tell which app it's running in.
//!
//! Commands that aren't ported yet answer the way demo mode does (an empty list, "not connected"),
//! so the page keeps working around them. Each is marked with the phase that brings it.

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
        "librespot.restart" => { core.librespot.restart(); json!(true) }
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
        "lastfmPlays.set" => json!(save_capped("lastfm-plays.json", args.get("value"), 64 << 20, false)),
        "history.get" => {
            let since = args.get("since").and_then(Value::as_f64).unwrap_or(0.0);
            tauri::async_runtime::spawn_blocking(move || history_since(since)).await.unwrap_or(json!([]))
        }
        "spotifyHistory.get" => {
            // Phase 2 brings the import itself; an import made by the Mac app is read as it is.
            match files::read_json("spotify-history.json") {
                Some(v) if v.get("tracks").is_some() && v.get("plays").is_some() => json!({"tracks": v["tracks"], "plays": v["plays"]}),
                _ => json!({"tracks": [], "plays": []}),
            }
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

        // MARK: not ported yet, answered like demo mode
        "nowplaying" => json!(true),                                                      // phase 4: media keys, tray, notifications
        "outputs.list" => json!([]),                                                      // phase 3
        "outputs.set" => json!(false),
        "eq.get" | "eq.set" => {                                                          // phase 3: the EQ itself
            let mut st = core.store.get("__eq");
            if !st.is_object() { st = json!({"enabled": false, "preamp": 0, "gains": [0,0,0,0,0,0,0,0,0,0], "preset": "Flat"}); }
            if cmd == "eq.set" {
                if let (Some(m), Some(a)) = (st.as_object_mut(), args.as_object()) {
                    for k in ["enabled", "preamp", "gains", "preset"] { if let Some(v) = a.get(k) { m.insert(k.into(), v.clone()); } }
                }
                core.store.set("__eq", st.clone());
            }
            let m = st.as_object_mut().unwrap();
            m.insert("freqs".into(), json!([32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]));
            m.insert("engine".into(), json!(true));
            m.insert("running".into(), json!(true));
            m.insert("device".into(), json!(core.sound.output_name()));
            m.insert("perDevice".into(), json!(false));
            st
        }
        "eq.engine" | "eq.meter" | "audio.local" | "mini.toggle" => json!(true),          // phases 3–4
        "lastfm.status" => json!({"user": "", "hasKeys": false, "loggedIn": false, "error": ""}),   // phase 2
        "lastfm.get" => json!({"status": 0, "body": null}),
        "lastfm.login" => json!({"ok": false, "message": "Last.fm comes in the next step of the port."}),
        "lastfm.logout" => json!(true),
        "discord.status" => json!({"enabled": false, "status": "not available yet", "hasId": false}),   // phase 4
        "update.status" | "update.check" => json!({"repo": core.settings.string("updateRepo"), "current": env!("CARGO_PKG_VERSION"), "state": "idle", "message": "", "auto": false}),   // phase 7
        "update.install" => json!({"ok": false, "message": "Updates come in phase 7 of the port."}),
        "translate.size" => json!(0),                                                     // phase 2
        "translate.models" => json!({"models": null, "error": "Translation comes in the next step of the port."}),
        "translate.clear" => json!(true),
        "genius.search" => json!({"hits": [], "error": "Not available yet"}),
        "lyrics" => json!({"synced": "", "plain": "", "instrumental": false}),
        "spotifyHistory.import" | "spotifyHistory.clear" | "cover.upload" => json!(false),

        _ => { log::info!("unknown command {cmd} {args}"); return Err(format!("Unknown command: {cmd}")) }
    })
}

fn settings_for_page(core: &Core) -> Value {
    let mut v = core.settings.all();
    v["mediaKeysTrusted"] = json!(true);
    v
}

/// Saves a JSON object the page hands over, refusing anything odd or too big.
fn save_capped(name: &str, value: Option<&Value>, max: usize, needs_version: bool) -> bool {
    let Some(v) = value.filter(|v| v.is_object()) else { return false };
    if needs_version && !v.get("v").map(Value::is_number).unwrap_or(false) { return false; }
    let Ok(data) = serde_json::to_vec(v) else { return false };
    data.len() <= max && files::write_privately(&data, &files::path(name))
}

/// Cadenza's own listening log, one JSON play per line.
fn history_since(since: f64) -> Value {
    let Ok(text) = std::fs::read_to_string(files::path("history.jsonl")) else { return json!([]) };
    let out: Vec<Value> = text.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|o| since <= 0.0 || o.get("at").and_then(Value::as_f64).map_or(true, |at| at >= since))
        .collect();
    Value::Array(out)
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
        format!("Cadenza {} (Tauri, {} {})", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH),
        format!("signed in to Spotify: {}", core.auth.is_logged_in()),
        String::new(),
    ];
    out.extend(core.librespot.diagnostics());
    out.push(String::new());
    out.push("== sound output ==".into());
    out.push(core.sound.output_name());
    out.extend(core.sound.log().into_iter().rev().take(30).rev());
    let text = out.join("\n");
    // The same redactions as the Mac app: your home folder, your Spotify username, search words.
    let mut text = match dirs::home_dir() { Some(h) => text.replace(&h.display().to_string(), "~"), None => text };
    let user = regex::Regex::new(r#"Authenticated as "[^"]*""#).unwrap();
    text = user.replace_all(&text, r#"Authenticated as "…""#).to_string();
    let q = regex::Regex::new(r"([?&]q=)[^&\s]*").unwrap();
    q.replace_all(&text, "${1}…").to_string()
}
