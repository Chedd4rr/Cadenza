//! Cadenza for macOS, Windows and Linux. The page in Resources/web is the whole interface, unchanged
//! from the Mac app; this is the native side it talks to (see bridge.rs).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod auth;
mod bridge;
mod builtin;
mod cover;
mod discord;
mod dsp;
mod files;
mod history;
mod lastfm;
mod librespot;
mod loginitem;
#[cfg(target_os = "macos")]
mod macaudio;
#[cfg(target_os = "macos")]
mod menu;
mod migrate;
mod settings;
mod shortcuts;
mod sound;
mod spotify_history;
mod store;
mod system;
mod testmode;
mod translation;

use serde_json::Value;
use std::sync::Arc;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub struct Core {
    pub settings: Arc<settings::Settings>,
    pub store: Arc<store::Store>,
    pub auth: Arc<auth::Auth>,
    pub api: Arc<api::Api>,
    pub sound: Arc<sound::Sound>,
    pub librespot: Arc<librespot::Librespot>,
    pub lastfm: Arc<lastfm::LastFm>,
    pub spotify_history: Arc<spotify_history::SpotifyHistory>,
    pub http: reqwest::Client,
    /// Sends an event to the page (app.onNative).
    pub emit: librespot::Emit,
    pub system: Arc<system::System>,
    pub discord: Arc<discord::Discord>,
}

/// Runs before the page's own scripts. app.js looks for `window.cadenzaNative` and sends every
/// `native(cmd, args)` through it, exactly as it uses WebKit's message handler in the Mac app.
const SHIM: &str = r#"
(() => {
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  Object.defineProperty(window, "cadenzaNative", {
    value: Object.freeze({ postMessage: (m) => invoke("native", { cmd: String(m.cmd), args: m.args || {} }) }),
  });
  window.cadenzaPlatform = "__OS__";
  if (__PROBE__) window.cadenzaProbe = true;   // (development builds started with CADENZA_PROBE: see app.js)
  window.cadenzaFiles = "__FILES__";
  // The page's shortcuts are written for the Mac's ⌘ key. On Windows and Linux, Ctrl does that job, so
  // each key and mouse event is shown to the page with the two swapped before anything else sees it.
  if (window.cadenzaPlatform !== "macos") {
    // Ctrl+Q quits, as in other apps here (before the swap below turns it into ⌘Q for the page).
    window.addEventListener("keydown", (e) => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === "q" || e.key === "Q")) { e.preventDefault(); invoke("native", { cmd: "app.quit", args: {} }); }
    }, true);
    // The shortcut hints on screen say ⌘, ⌥ and ⇧, as on a Mac: show Ctrl, Alt and Shift instead.
    const names = { "⌘": "Ctrl", "⌥": "Alt", "⇧": "Shift" };
    const fix = (node) => {
      if (node.nodeType === 3) {
        if (/[⌘⌥⇧]/.test(node.nodeValue)) node.nodeValue = node.nodeValue.replace(/([⌘⌥⇧])\s*/g, (m, k) => names[k] + " ");
      } else if (node.nodeType === 1 && node.nodeName !== "SCRIPT" && node.nodeName !== "STYLE") {
        if (node.title && /[⌘⌥⇧]/.test(node.title)) node.title = node.title.replace(/([⌘⌥⇧])\s*/g, (m, k) => names[k] + " ");
        for (const c of node.childNodes) fix(c);
      }
    };
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === "characterData") fix(m.target);
        else for (const n of m.addedNodes) fix(n);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
    document.addEventListener("DOMContentLoaded", () => fix(document.body));
    const swap = (e) => {
      const meta = e.metaKey, ctrl = e.ctrlKey;
      Object.defineProperty(e, "metaKey", { value: ctrl });
      Object.defineProperty(e, "ctrlKey", { value: meta });
    };
    for (const t of ["keydown", "keyup", "keypress", "click", "auxclick", "mousedown", "mouseup", "wheel", "contextmenu"]) {
      window.addEventListener(t, swap, true);
    }
  }
})();
"#;

/// Sends an event to the page: `app.onNative(event, data)`, as Bridge.swift's emit does.
fn emit_to(app: &tauri::AppHandle, event: &str, data: &Value) {
    let safe: String = event.chars().filter(|c| c.is_alphanumeric() || *c == '.' || *c == '_').collect();
    if !matches!(safe.as_str(), "player" | "eq.levels" | "librespot" | "translate.progress") { log::info!("to the page: {safe} {}", data.to_string().chars().take(160).collect::<String>()); }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(format!("window.app && app.onNative('{safe}', {data})"));
    }
}

/// The address the page uses for `cadenza-files://`: the translator's code and language models.
/// Windows's web view can't use a custom scheme directly and reaches it through http://<scheme>.localhost.
pub fn files_base() -> &'static str {
    if cfg!(windows) { "http://cadenza-files.localhost/" } else { "cadenza-files://" }
}

fn main() {
    // librespot starts Cadenza.exe to pass on each player event (Windows); that copy only writes it down.
    if librespot::run_event_hook() { return; }
    env_logger_lite();
    tauri::Builder::default()
        // Only one Cadenza at a time: opening it again (or a cadenza:// link) goes to the one running.
        // (A link it was opened with reaches the running one through the links plugin below.)
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let link = argv.iter().any(|a| a.starts_with("cadenza:"));
            if let Some(sys) = app.try_state::<Arc<system::System>>() { if !link { sys.show_main(); } }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        // The main window opens where you left it, at the size you left it. (The mini player keeps its own spot.)
        .plugin(tauri_plugin_window_state::Builder::default()
            .with_state_flags(tauri_plugin_window_state::StateFlags::SIZE | tauri_plugin_window_state::StateFlags::POSITION
                | tauri_plugin_window_state::StateFlags::MAXIMIZED)
            .with_denylist(&["mini"])
            .build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, _shortcut, event| {
            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                if let Some(sys) = app.try_state::<Arc<system::System>>() { sys.toggle_main(); }
            }
        }).build())
        .register_uri_scheme_protocol("cadenza-files", |ctx, request| files_scheme(ctx.app_handle(), request))
        .invoke_handler(tauri::generate_handler![bridge::native, system::mini])
        .setup(|app| {
            let handle = app.handle().clone();
            let http = reqwest::Client::builder()
                .user_agent(format!("Cadenza/{} (https://github.com/Chedd4rr/Cadenza)", env!("CARGO_PKG_VERSION")))
                .build()?;
            testmode::prepare();                                       // (test mode only: its first start)
            migrate::run();                                            // (on a Mac, the first start: the Swift app's settings)
            let settings = Arc::new(settings::Settings::load());
            let store = store::Store::load();
            let auth = Arc::new(auth::Auth::new(settings.clone(), http.clone()));
            let api = Arc::new(api::Api::new(auth.clone(), http.clone()));
            let emitter = handle.clone();
            let emit: librespot::Emit = Arc::new(move |event: &str, data: Value| emit_to(&emitter, event, &data));
            let sound = sound::Sound::start(settings.clone(), emit.clone());
            let history = Arc::new(history::History::default());
            let librespot = librespot::Librespot::new(settings.clone(), api.clone(), sound.clone(), history, emit.clone());
            let lastfm = Arc::new(lastfm::LastFm::new(settings.clone(), http.clone()));
            let system = system::System::new(handle.clone());
            app.manage(system.clone());
            let core = Arc::new(Core {
                settings: settings.clone(), store, auth, api, sound, librespot: librespot.clone(), lastfm,
                spotify_history: Arc::new(spotify_history::SpotifyHistory::default()), http, emit,
                system: system.clone(), discord: discord::Discord::new(settings.clone()),
            });
            app.manage(core.clone());

            let probing = cfg!(debug_assertions) && std::env::var_os("CADENZA_PROBE").is_some();
            let shim = SHIM.replace("__OS__", std::env::consts::OS).replace("__FILES__", files_base())
                .replace("__PROBE__", if probing { "true" } else { "false" });
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(if files::test_mode() { "Cadenza (test)" } else { "Cadenza" })
                .inner_size(1440.0, 900.0)
                .min_inner_size(1100.0, 700.0)
                .center()
                // Cadenza's navy behind the page while it loads, instead of a white flash.
                .background_color(tauri::window::Color(3, 12, 46, 255));
            // On a Mac, the page reaches the top of the window with the traffic lights over it and no title,
            // as in the Swift app. (The strip at the top still drags the window.)
            #[cfg(target_os = "macos")]
            let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
            builder
                .initialization_script(&shim)
                .on_page_load(|w, payload| {
                    if payload.event() == tauri::webview::PageLoadEvent::Finished {
                        if let Some(sys) = w.app_handle().try_state::<Arc<system::System>>() { sys.page_loaded(); }
                    }
                })
                .build()?;
            system.start(core.clone());
            #[cfg(target_os = "macos")]
            {
                app.set_menu(menu::build(&handle, false)?)?;
                app.on_menu_event(|app, e| menu::picked(app, e.id().as_ref()));
            }
            apply_hotkey(&handle);
            loginitem::tidy(&handle);

            // cadenza:// links. Registered with the system here too, so they also work in a development build.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                #[cfg(any(target_os = "linux", windows))]
                { let _ = app.deep_link().register_all(); }
                let sys = system.clone();
                app.deep_link().on_open_url(move |e| { for u in e.urls() { sys.link(u.as_str()); } });
                if let Ok(Some(urls)) = app.deep_link().get_current() { for u in urls { system.link(u.as_str()); } }
            }

            if settings.bool("manageLibrespot") { librespot.start(); }
            // For testing the bridge in development builds: CADENZA_PROBE holds a script to run in the page.
            #[cfg(debug_assertions)]
            if let Ok(script) = std::env::var("CADENZA_PROBE") {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    if let Some(w) = h.get_webview_window("main") { let _ = w.eval(script); }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" { return; }
            let Some(sys) = window.app_handle().try_state::<Arc<system::System>>() else { return };
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // The music keeps going with the window closed, while the tray (or the Dock) can bring it back.
                    if sys.keeps_running_when_closed() {
                        api.prevent_close();
                        let _ = window.hide();
                        sys.set_asleep(true);
                    } else {
                        window.app_handle().exit(0);
                    }
                }
                tauri::WindowEvent::Focused(true) => sys.set_asleep(false),
                tauri::WindowEvent::Resized(_) => { if window.is_minimized().unwrap_or(false) { sys.set_asleep(true); } }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("couldn't start Cadenza")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => { if let Some(sys) = app.try_state::<Arc<system::System>>() { sys.show_main(); } }
            tauri::RunEvent::Exit => {
                if let Some(core) = app.try_state::<Arc<Core>>() {
                    // Exactly where the song was, so the next Play starts there.
                    if let Some(spot) = core.librespot.snapshot() { core.store.set("enginePosition", spot); }
                    core.store.flush();
                    core.librespot.shutdown();
                }
            }
            _ => {}
        });
}

/// The global shortcut that shows or hides Cadenza from any app: Option-⌘-P on a Mac and Ctrl+Alt+P
/// elsewhere, unless you changed it on the keyboard page; off if you turned it off in System.
pub fn apply_hotkey(app: &tauri::AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();                               // it's the only one Cadenza has
    let Some(core) = app.try_state::<Arc<Core>>() else { return };
    if !core.settings.bool("globalHotkey") { return; }
    let combo = shortcuts::get(&core.settings, "showHide");
    if !shortcuts::has_command_key(&combo) && !combo.contains("Alt+") { return; }   // a plain key would be taken from every app
    let Some(key) = shortcuts::accelerator(&combo) else { return };
    if let Err(e) = gs.register(key.as_str()) { log::warn!("couldn't set the global shortcut {key}: {e}"); }
}

/// The Mac menu again, with your current shortcuts (or none, while you choose a new one).
pub fn rebuild_menu(app: &tauri::AppHandle, plain: bool) {
    #[cfg(target_os = "macos")]
    match menu::build(app, plain) { Ok(m) => { let _ = app.set_menu(m); } Err(e) => log::warn!("couldn't rebuild the menu: {e}") }
    #[cfg(not(target_os = "macos"))]
    { let _ = (app, plain); }
}

/// Serves `cadenza-files://app/vendor/…` (the translator's code, from the page's own folder) and
/// `cadenza-files://models/<hash>.bin|spm` (downloaded language models). Nothing else.
fn files_scheme(app: &tauri::AppHandle, request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::Response;
    let not_found = || Response::builder().status(404).body(Vec::new()).unwrap();
    let uri = request.uri();
    // cadenza-files://app/vendor/x on macOS and Linux; http://cadenza-files.localhost/app/vendor/x on Windows.
    let mut parts: Vec<String> = uri.path().split('/').filter(|p| !p.is_empty()).map(String::from).collect();
    let host = uri.host().unwrap_or("");
    if host != "app" && host != "models" { if parts.is_empty() { return not_found(); } } else { parts.insert(0, host.to_string()); }
    if parts.iter().any(|p| p == ".." || p.contains('\\')) { return not_found(); }

    let file = match parts.first().map(String::as_str) {
        Some("models") if parts.len() == 2 => {
            let re = regex::Regex::new(r"^[0-9a-f]{64}\.(bin|spm)$").unwrap();
            if !re.is_match(&parts[1]) { return not_found(); }
            files::path("translation-models").join(&parts[1])
        }
        Some("app") if parts.len() >= 3 && parts[1] == "vendor" => {
            let rel = parts[2..].join("/");
            match app.asset_resolver().get(format!("vendor/{rel}")) {
                Some(asset) => return reply(asset.bytes, &rel),
                None => return not_found(),
            }
        }
        _ => return not_found(),
    };
    match std::fs::read(&file) {
        Ok(bytes) => reply(bytes, &file.display().to_string()),
        Err(_) => not_found(),
    }
}

fn reply(bytes: Vec<u8>, name: &str) -> tauri::http::Response<Vec<u8>> {
    let kind = if name.ends_with(".js") { "text/javascript" } else if name.ends_with(".wasm") { "application/wasm" } else { "application/octet-stream" };
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", kind)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .body(bytes)
        .unwrap()
}

/// Log messages go to standard error when CADENZA_LOG is set (no logging crate needed for that).
fn env_logger_lite() {
    struct L;
    impl log::Log for L {
        fn enabled(&self, _: &log::Metadata) -> bool { true }
        fn log(&self, r: &log::Record) { eprintln!("[{}] {}", r.level(), r.args()); }
        fn flush(&self) {}
    }
    if std::env::var_os("CADENZA_LOG").is_some() {
        static LOGGER: L = L;
        let _ = log::set_logger(&LOGGER);
        log::set_max_level(log::LevelFilter::Info);
    }
}
