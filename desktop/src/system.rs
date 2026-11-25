
use base64::Engine;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

use crate::Core;

const TRAY_ID: &str = "cadenza";

const MINI_SHIM: &str = r#"
(() => {
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  Object.defineProperty(window, "cadenzaMini", {
    value: Object.freeze({ postMessage: (m) => invoke("mini", { cmd: String(m.cmd), value: m.value === undefined ? null : m.value }) }),
  });
  window.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest("button, input, a, select, textarea, [role=slider], .vol, .bar, .seek")) return;
    invoke("plugin:window|start_dragging", {}).catch(() => {});
  });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") invoke("mini", { cmd: "hide", value: null }); });
})();
"#;

struct Controls(souvlaki::MediaControls);
// SAFETY: every use goes through `on_main`, so the controls never actually move between threads.
unsafe impl Send for Controls {}

#[derive(Default)]
struct State {
    info: Value,
    info_at: Option<Instant>,
    art_url: String,
    art_data: String,
    art_sent: bool,
    last_song: Option<String>,
    page_ready: bool,
    pending_links: Vec<String>,
    asleep: bool,
}

pub struct System {
    app: AppHandle,
    core: Mutex<Option<Arc<Core>>>,
    st: Mutex<State>,
    controls: Arc<Mutex<Option<Controls>>>,
    menu: Mutex<Option<(MenuItem<tauri::Wry>, MenuItem<tauri::Wry>)>>,   // the "now playing" line, Play/Pause
}

impl System {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(System { app, core: Mutex::new(None), st: Mutex::new(State::default()), controls: Arc::new(Mutex::new(None)), menu: Mutex::new(None) })
    }

    /// Everything that needs the rest of the app, once it exists.
    pub fn start(self: &Arc<Self>, core: Arc<Core>) {
        *self.core.lock().unwrap() = Some(core.clone());
        self.start_media_controls();
        self.set_tray(core.settings.bool("menuBar"));
        if core.settings.bool("floatingPlayer") { self.show_mini(); }
    }

    pub fn app(&self) -> &AppHandle { &self.app }

    fn core(&self) -> Arc<Core> { self.core.lock().unwrap().clone().expect("core is set at start-up") }

    fn on_main(&self, f: impl FnOnce() + Send + 'static) { let _ = self.app.run_on_main_thread(f); }

    // MARK: playback actions (media keys, tray, mini player)

    pub fn play_pause(self: &Arc<Self>) {
        let core = self.core();
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let playing = if core.librespot.is_active_here() { Some(core.librespot.is_playing_here()) } else { None };
            let playing = match playing {
                Some(p) => { core.sound.local(if p { "pause" } else { "play" }, p); if p { core.librespot.verify_pause(); } p }
                None => core.api.request("GET", "/me/player", None).await.1.get("is_playing").and_then(Value::as_bool).unwrap_or(false),
            };
            me.send("PUT", if playing { "/me/player/pause" } else { "/me/player/play" }).await;
        });
    }

    pub fn act(self: &Arc<Self>, what: &str) {
        let core = self.core();
        if matches!(what, "next" | "previous") {
            (core.emit)("command", json!({ "cmd": what }));
            return;
        }
        let local = core.librespot.is_active_here();
        let (method, path) = match what {
            "next" => ("POST", "/me/player/next".to_string()),
            "previous" => ("POST", "/me/player/previous".to_string()),
            "play" => ("PUT", "/me/player/play".to_string()),
            "pause" => ("PUT", "/me/player/pause".to_string()),
            _ => return,
        };
        if local {
            match what { "next" | "previous" => core.sound.local("skip", true), "play" => core.sound.local_resume(), "pause" => { core.sound.local_pause(); core.librespot.verify_pause(); } _ => {} }
        }
        let me = self.clone();
        tauri::async_runtime::spawn(async move { me.send(method, &path).await; });
    }

    fn seek(self: &Arc<Self>, ms: u64) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move { me.send("PUT", &format!("/me/player/seek?position_ms={ms}")).await; });
    }

    async fn send(&self, method: &str, path: &str) {
        let core = self.core();
        if !core.librespot.direct_request(method, path) { core.api.request(method, path, None).await; }
        tokio::time::sleep(Duration::from_millis(250)).await;
        (core.emit)("refresh", Value::Null);
    }

    // MARK: media keys and Now Playing

    fn start_media_controls(self: &Arc<Self>) {
        if cfg!(target_os = "linux") && std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
            log::info!("media keys: no desktop session bus, so no MPRIS");
            return;
        }
        let me = self.clone();
        let slot = self.controls.clone();
        #[cfg(windows)]
        let hwnd = self.app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as *mut std::ffi::c_void);
        #[cfg(not(windows))]
        let hwnd: Option<*mut std::ffi::c_void> = None;
        let hwnd_addr = hwnd.map(|h| h as usize);
        self.on_main(move || {
            let config = souvlaki::PlatformConfig {
                display_name: "Cadenza",
                dbus_name: if crate::files::test_mode() { "cadenza_test" } else { "cadenza" },
                hwnd: hwnd_addr.map(|a| a as *mut std::ffi::c_void),
            };
            let mut controls = match souvlaki::MediaControls::new(config) {
                Ok(c) => c,
                Err(e) => { log::warn!("media controls unavailable: {e:?}"); return; }
            };
            let handler = me.clone();
            let attached = controls.attach(move |event| {
                use souvlaki::MediaControlEvent as E;
                match event {
                    E::Toggle => handler.play_pause(),
                    E::Play => handler.act("play"),
                    E::Pause | E::Stop => handler.act("pause"),
                    E::Next => handler.act("next"),
                    E::Previous => handler.act("previous"),
                    E::SetPosition(p) => handler.seek(p.0.as_millis() as u64),
                    E::Raise => handler.show_main(),
                    _ => {}
                }
            });
            if let Err(e) = attached { log::warn!("media controls: {e:?}"); return; }
            *slot.lock().unwrap() = Some(Controls(controls));
        });
    }

    fn update_media_controls(&self, info: &Value) {
        let slot = self.controls.clone();
        let info = info.clone();
        self.on_main(move || {
            let mut guard = slot.lock().unwrap();
            let Some(Controls(c)) = guard.as_mut() else { return };
            let s = |k: &str| info.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let title = s("title");
            if title.is_empty() { let _ = c.set_playback(souvlaki::MediaPlayback::Stopped); return; }
            let (artist, album, art) = (s("artist"), s("album"), s("art"));
            let dur = info.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
            let _ = c.set_metadata(souvlaki::MediaMetadata {
                title: Some(&title), artist: Some(&artist), album: Some(&album),
                cover_url: if art.is_empty() { None } else { Some(&art) },
                duration: if dur > 0.0 { Some(Duration::from_millis(dur as u64)) } else { None },
            });
            let pos = info.get("position").and_then(Value::as_f64).map(|p| souvlaki::MediaPosition(Duration::from_millis(p.max(0.0) as u64)));
            let playing = info.get("playing").and_then(Value::as_bool).unwrap_or(false);
            let _ = c.set_playback(if playing { souvlaki::MediaPlayback::Playing { progress: pos } } else { souvlaki::MediaPlayback::Paused { progress: pos } });
        });
    }

    // MARK: what's playing (the page sends it on every change)

    pub fn now_playing(self: &Arc<Self>, info: Value) {
        let (new_art, song_changed, first) = {
            let mut st = self.st.lock().unwrap();
            st.info = info.clone();
            st.info_at = Some(Instant::now());
            let art = info.get("art").and_then(Value::as_str).unwrap_or("").to_string();
            let new_art = if art != st.art_url { st.art_url = art.clone(); st.art_data.clear(); st.art_sent = false; Some(art) } else { None };
            let key = info.get("title").and_then(Value::as_str).filter(|t| !t.is_empty())
                .map(|t| format!("{t}|{}", info.get("artist").and_then(Value::as_str).unwrap_or("")));
            let first = st.last_song.is_none();
            let changed = key.is_some() && key != st.last_song;
            if changed { st.last_song = key; }
            (new_art, changed, first)
        };
        self.update_media_controls(&info);
        self.update_tray_text(&info);
        self.push_mini();
        if song_changed && !first { self.notify(&info); }
        if let Some(art) = new_art { self.load_cover(art); }
    }

    fn load_cover(self: &Arc<Self>, url: String) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let core = me.core();
            let bytes = if url.starts_with("https://") {
                match core.http.get(&url).timeout(Duration::from_secs(15)).send().await { Ok(r) => r.bytes().await.ok(), Err(_) => None }
            } else { None };
            let decoded = bytes.and_then(|b| image::load_from_memory(&b).ok());
            let (data, icon) = match decoded {
                Some(img) => {
                    let side = img.width().min(img.height());
                    let sq = img.crop_imm((img.width() - side) / 2, (img.height() - side) / 2, side, side);
                    let mut jpeg = std::io::Cursor::new(Vec::new());
                    let big = sq.resize_exact(480, 480, image::imageops::FilterType::Triangle).to_rgb8();
                    let _ = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85).encode_image(&big);
                    let data = format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg.into_inner()));
                    let small = sq.resize_exact(64, 64, image::imageops::FilterType::Triangle).to_rgba8();
                    (data, Some(small))
                }
                None => (String::new(), None),
            };
            {
                let mut st = me.st.lock().unwrap();
                if st.art_url != url { return; }           // a newer song came along meanwhile
                st.art_data = data;
                st.art_sent = false;
            }
            me.push_mini();
            if let Some(tray) = me.app.tray_by_id(TRAY_ID) {
                let icon = icon.map(|i| tauri::image::Image::new_owned(i.into_raw(), 64, 64)).or_else(|| me.app.default_window_icon().cloned());
                let _ = tray.set_icon(icon);
            }
        });
    }

    fn notify(&self, info: &Value) {
        let core = self.core();
        if !core.settings.bool("notifications") { return; }
        let in_front = self.app.get_webview_window("main").map_or(false, |w| w.is_focused().unwrap_or(false) && w.is_visible().unwrap_or(false));
        if in_front { return; }
        let s = |k: &str| info.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let (artist, album) = (s("artist"), s("album"));
        let body = if album.is_empty() { artist } else { format!("{artist} · {album}") };
        let _ = self.app.notification().builder().title(s("title")).body(body).show();
    }

    // MARK: tray

    pub fn set_tray(self: &Arc<Self>, on: bool) {
        if !on { let _ = self.app.remove_tray_by_id(TRAY_ID); *self.menu.lock().unwrap() = None; return; }
        if self.app.tray_by_id(TRAY_ID).is_some() { return; }
        let app = &self.app;
        let build = || -> tauri::Result<()> {
            let now = MenuItem::with_id(app, "now", "Nothing playing", false, None::<&str>)?;
            let toggle = MenuItem::with_id(app, "toggle", "Play", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[
                &now,
                &PredefinedMenuItem::separator(app)?,
                &toggle,
                &MenuItem::with_id(app, "next", "Next Song", true, None::<&str>)?,
                &MenuItem::with_id(app, "previous", "Previous Song", true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "show", "Show Cadenza", true, None::<&str>)?,
                &MenuItem::with_id(app, "mini", "Mini Player", true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "quit", "Quit Cadenza", true, None::<&str>)?,
            ])?;
            let me = self.clone();
            let me2 = self.clone();
            let mut b = TrayIconBuilder::with_id(TRAY_ID).menu(&menu).tooltip("Cadenza")
                .show_menu_on_left_click(false)
                .on_menu_event(move |_app, e| match e.id().as_ref() {
                    "toggle" => me.play_pause(),
                    "next" => me.act("next"),
                    "previous" => me.act("previous"),
                    "show" => me.show_main(),
                    "mini" => { me.toggle_mini(); }
                    "quit" => me.app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(move |_tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, position, .. } = e {
                        me2.toggle_mini_at(Some(position));
                    }
                });
            if let Some(icon) = app.default_window_icon() { b = b.icon(icon.clone()); }
            b.build(app)?;
            *self.menu.lock().unwrap() = Some((now, toggle));
            Ok(())
        };
        if let Err(e) = build() { log::warn!("no tray icon: {e}"); }
    }

    fn update_tray_text(&self, info: &Value) {
        let title = info.get("title").and_then(Value::as_str).unwrap_or("");
        let artist = info.get("artist").and_then(Value::as_str).unwrap_or("");
        let playing = info.get("playing").and_then(Value::as_bool).unwrap_or(false);
        let line = if title.is_empty() { "Nothing playing".to_string() } else { format!("{title} — {artist}") };
        if let Some((now, toggle)) = self.menu.lock().unwrap().as_ref() {
            let _ = now.set_text(line.chars().take(60).collect::<String>());
            let _ = toggle.set_text(if playing { "Pause" } else { "Play" });
        }
        if let Some(tray) = self.app.tray_by_id(TRAY_ID) {
            let _ = tray.set_tooltip(Some(if title.is_empty() { "Cadenza".to_string() } else { format!("{title} — {artist}") }));
        }
    }

    // MARK: the mini player

    pub fn mini_open(&self) -> bool { self.app.get_webview_window("mini").map_or(false, |w| w.is_visible().unwrap_or(false)) }

    pub fn toggle_mini(self: &Arc<Self>) -> bool { self.toggle_mini_at(None) }

    fn toggle_mini_at(self: &Arc<Self>, near: Option<PhysicalPosition<f64>>) -> bool {
        if self.mini_open() { self.hide_mini(); false } else { self.show_mini_at(near); true }
    }

    pub fn show_mini(self: &Arc<Self>) { self.show_mini_at(None) }

    fn show_mini_at(self: &Arc<Self>, near: Option<PhysicalPosition<f64>>) {
        let w = match self.app.get_webview_window("mini") {
            Some(w) => w,
            None => {
                let mut b = WebviewWindowBuilder::new(&self.app, "mini", WebviewUrl::App("mini/mini.html".into()))
                    .title("Cadenza mini player")
                    .inner_size(324.0, 500.0)
                    .decorations(false)
                    .transparent(true)
                    .shadow(false)
                    .resizable(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .visible_on_all_workspaces(true)
                    .initialization_script(MINI_SHIM)
                    .on_page_load(|w, payload| {
                        if payload.event() == tauri::webview::PageLoadEvent::Finished {
                            if let Some(sys) = w.app_handle().try_state::<Arc<System>>() {
                                let _ = w.eval("window.mini && mini.setVisible(true)");
                                sys.st.lock().unwrap().art_sent = false;      // a new page: it has no cover yet
                                sys.push_mini();
                            }
                        }
                    });
                // Where you last left it.
                let saved = self.core().settings.get("miniPos");
                if let (Some(x), Some(y)) = (saved.get("x").and_then(Value::as_f64), saved.get("y").and_then(Value::as_f64)) {
                    b = b.position(x, y);
                }
                match b.build() {
                    Ok(w) => {
                        let me = self.clone();
                        w.on_window_event(move |e| {
                            if let tauri::WindowEvent::Moved(p) = e {
                                if let Ok(scale) = me.app.get_webview_window("mini").map_or(Ok(1.0), |w| w.scale_factor()) {
                                    me.core().settings.put("miniPos", json!({"x": p.x as f64 / scale, "y": p.y as f64 / scale}));
                                }
                            }
                        });
                        w
                    }
                    Err(e) => { log::warn!("couldn't open the mini player: {e}"); return; }
                }
            }
        };
        // Opened from the tray: just above (or below) the icon.
        if let Some(p) = near {
            let size = w.outer_size().unwrap_or_default();
            let monitor_h = w.current_monitor().ok().flatten().map(|m| m.size().height as f64).unwrap_or(1080.0);
            let x = (p.x - size.width as f64 / 2.0).max(0.0);
            let y = if p.y > monitor_h / 2.0 { p.y - size.height as f64 - 8.0 } else { p.y + 8.0 };
            let _ = w.set_position(PhysicalPosition::new(x, y));
        }
        let _ = w.show();
        self.core().settings.put("floatingPlayer", json!(true));
        let _ = w.eval("window.mini && mini.setVisible(true)");
        self.push_mini();
    }

    pub fn hide_mini(&self) {
        if let Some(w) = self.app.get_webview_window("mini") {
            let _ = w.eval("window.mini && mini.setVisible(false)");
            let _ = w.hide();
        }
        if let Some(core) = self.core.lock().unwrap().clone() { core.settings.put("floatingPlayer", json!(false)); }
    }

    pub fn push_mini(&self) {
        let Some(w) = self.app.get_webview_window("mini") else { return };
        if !w.is_visible().unwrap_or(true) { return; }
        let (info, at, art) = {
            let mut st = self.st.lock().unwrap();
            let art = if st.art_sent { None } else { st.art_sent = true; Some(st.art_data.clone()) };
            (st.info.clone(), st.info_at, art)
        };
        let mut payload = serde_json::Map::new();
        for key in ["title", "artist", "album", "playing", "liked", "volume", "duration", "position", "theme"] {
            if let Some(v) = info.get(key).filter(|v| !v.is_null()) { payload.insert(key.into(), v.clone()); }
        }
        if let Some(pos) = info.get("position").and_then(Value::as_f64) {
            let playing = info.get("playing").and_then(Value::as_bool).unwrap_or(false);
            let mut now = pos + if playing { at.map_or(0.0, |t| t.elapsed().as_secs_f64() * 1000.0) } else { 0.0 };
            if let Some(d) = info.get("duration").and_then(Value::as_f64).filter(|d| *d > 0.0) { now = now.min(d); }
            payload.insert("position".into(), json!(now));
        }
        if let Some(art) = art { payload.insert("art".into(), json!(art)); }      // left out: keep the one it has
        let style = if self.core.lock().unwrap().as_ref().map_or(false, |c| c.settings.string("miniStyle") == "mp3") { "mp3" } else { "theme" };
        payload.insert("style".into(), json!(style));
        let reduce = self.core.lock().unwrap().as_ref().map(|c| c.settings.get("reduceMotion")).unwrap_or(Value::Null);
        payload.insert("reduce".into(), match reduce.as_str() { Some("on") => json!(true), Some("off") => json!(false), _ => if reduce == json!(true) { json!(true) } else { Value::Null } });
        let _ = w.eval(format!("window.mini && mini.apply({})", Value::Object(payload)));
    }

    /// A message from the mini page.
    pub fn mini_message(self: &Arc<Self>, cmd: &str, value: &Value) {
        let core = self.core();
        match cmd {
            "toggle" => self.play_pause(),
            "next" | "previous" => self.act(cmd),
            "like" => (core.emit)("like", Value::Null),
            "show" => self.show_main(),
            "hide" => self.hide_mini(),
            "volume" => if let Some(v) = value.as_f64() { (core.emit)("volume", json!({"value": v.clamp(0.0, 100.0) as i64})) },
            "size" => {
                let (w, h) = (value.get("w").and_then(Value::as_f64), value.get("h").and_then(Value::as_f64));
                if let (Some(w), Some(h), Some(win)) = (w, h, self.app.get_webview_window("mini")) {
                    let _ = win.set_size(LogicalSize::new(w.clamp(160.0, 520.0), h.clamp(160.0, 760.0)));
                }
            }
            _ => {}
        }
    }

    // MARK: the main window

    pub fn show_main(&self) {
        if let Some(w) = self.app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        self.set_asleep(false);
        if let Some(core) = self.core.lock().unwrap().clone() { (core.emit)("opened", Value::Null); }
    }

    pub fn toggle_main(&self) {
        let Some(w) = self.app.get_webview_window("main") else { return };
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
            let _ = w.hide();
            self.set_asleep(true);
        } else { self.show_main(); }
    }

    pub fn set_asleep(&self, on: bool) {
        {
            let mut st = self.st.lock().unwrap();
            if st.asleep == on { return; }
            st.asleep = on;
        }
        if let Some(core) = self.core.lock().unwrap().clone() { (core.emit)(if on { "sleep" } else { "wake" }, Value::Null); }
    }

    pub fn keeps_running_when_closed(&self) -> bool {
        cfg!(target_os = "macos") || self.app.tray_by_id(TRAY_ID).is_some()
    }

    pub fn page_loaded(self: &Arc<Self>) {
        let me = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(2500));
            let waiting = { let mut st = me.st.lock().unwrap(); st.page_ready = true; std::mem::take(&mut st.pending_links) };
            for l in waiting { me.link(&l); }
        });
    }

    pub fn link(self: &Arc<Self>, link: &str) {
        let Ok(url) = url::Url::parse(link) else { return };
        if !url.scheme().eq_ignore_ascii_case("cadenza") { return; }
        {
            let mut st = self.st.lock().unwrap();
            if !st.page_ready { st.pending_links.push(link.to_string()); return; }
        }
        let action = url.host_str().map(String::from).unwrap_or_else(|| url.path().replace('/', "")).to_lowercase();
        let query: serde_json::Map<String, Value> = url.query_pairs().map(|(k, v)| (k.to_lowercase(), json!(v))).collect();
        match action.as_str() {
            "mini" => { self.toggle_mini(); }                 // works even with the window closed
            "show" => self.show_main(),
            "hide" => { if let Some(w) = self.app.get_webview_window("main") { let _ = w.hide(); } self.set_asleep(true); }
            _ => { let core = self.core(); (core.emit)("url", json!({"action": action, "query": query})); }
        }
    }
}

#[tauri::command]
pub async fn mini(window: tauri::WebviewWindow, sys: tauri::State<'_, Arc<System>>, cmd: String, value: Option<Value>) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    let own = url.scheme() == "tauri" || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    if window.label() != "mini" || !own { return Err("Not allowed".into()); }
    sys.mini_message(&cmd, &value.unwrap_or(Value::Null));
    Ok(())
}
