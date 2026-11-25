
use regex::Regex;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::api::Api;
use crate::files;
use crate::history::History;
use crate::settings::Settings;
use crate::sound::Sound;

pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

#[derive(Clone, Default)]
pub struct SongPath {
    pub uri: String,
    pub format: String,
    pub loudness_db: Option<f64>,
    /// Levelled as part of its album (rather than on its own).
    pub album: bool,
}

fn note_song_path(g: &mut Inner, line: &str) {
    let uri = |s: &str| -> String { s.split('<').nth(1).and_then(|x| x.split('>').next()).unwrap_or("").to_string() };
    if let Some(rest) = line.strip_prefix("file ") {
        let u = uri(rest);
        let format = rest.rsplit('>').next().unwrap_or("").trim().to_string();
        if !u.is_empty() && !format.is_empty() {
            if g.files.len() > 16 { g.files.clear(); }
            g.files.insert(u, format);
        }
    } else if let Some(rest) = line.strip_prefix("playing ") {
        let u = uri(rest);
        if u.is_empty() { return; }
        let after = rest.rsplit('>').next().unwrap_or("");
        let loudness_db = after.trim().strip_prefix("loudness ").filter(|l| !l.starts_with("off"))
            .and_then(|l| l.split_whitespace().next()).and_then(|n| n.parse::<f64>().ok());
        let format = g.files.get(&u).cloned().unwrap_or_default();
        let album = after.contains("(Album)");
        g.song = Some(SongPath { uri: u, format, loudness_db, album });
    }
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

#[derive(Default)]
struct Inner {
    /// The engine, while it's running.
    embedded: Option<Arc<crate::embedded::Engine>>,
    generation: u64,
    state: String,
    log: Vec<String>,
    player: Map<String, Value>,
    /// When player.progress_ms was last true.
    pos_at: f64,
    crash_times: Vec<Instant>,
    recovering: String,
    // Recovery bookkeeping (see the "recovery" part below).
    refusals: std::collections::HashMap<String, Instant>,
    last_song_refusal: Option<Instant>,
    last_key_failure: Option<Instant>,
    loading_uri: String,
    files: std::collections::HashMap<String, String>,
    song: Option<SongPath>,
    retried: std::collections::HashMap<String, Instant>,
    pending_retry: Option<String>,
    last_drop: Option<Instant>,
    last_device_fix: Option<Instant>,
    last_rescue: Option<Instant>,
    last_stop_at: Option<Instant>,
    skip_last: Option<Instant>,
    skip_pending: u32,
    skip_flushing: bool,
    hold_streak: u32,
    last_hold: Option<Instant>,
    hold_token: u64,
    hold_until: Option<Instant>,
    hold_skips: u32,
    track_loaded: bool,
    flowing_ticks: u32,
    stall_since: Option<Instant>,
    device_check_at: Option<(Instant, String)>,
}

fn within(t: Option<Instant>, secs: u64) -> bool { t.map_or(false, |t| t.elapsed() < Duration::from_secs(secs)) }

enum Then {
    CheckSound, Retry(String), RetryLater(String), Dropped(String, bool), Refused(String), Held(String),
    NewSong(Option<i64>), Position(i64, Option<i64>), Seeked, ReleaseIfHeld,
}

pub struct Librespot {
    inner: Mutex<Inner>,
    settings: Arc<Settings>,
    api: Arc<Api>,
    sound: Arc<Sound>,
    history: Arc<History>,
    emit: Emit,
}

impl Librespot {
    pub fn new(settings: Arc<Settings>, api: Arc<Api>, sound: Arc<Sound>, history: Arc<History>, emit: Emit) -> Arc<Self> {
        let me = Arc::new(Librespot {
            inner: Mutex::new(Inner { state: "stopped".into(), ..Default::default() }),
            settings, api, sound, history, emit,
        });
        tidy_old_engine_files();
        let keeper = Arc::clone(&me);
        std::thread::Builder::new().name("cadenza-engine-keeper".into()).spawn(move || {
            let mut last = SystemTime::now();
            loop {
                std::thread::sleep(Duration::from_secs(2));
                let gap = SystemTime::now().duration_since(last).unwrap_or_default();
                last = SystemTime::now();
                if gap > Duration::from_secs(20) { keeper.schedule_device_check(8, "the computer woke up"); }
                keeper.follow_the_sound();
                keeper.watch_sound();
                keeper.run_device_check();
            }
        }).ok();
        let sleeper = Arc::clone(&me);
        std::thread::Builder::new().name("cadenza-sleep-watch".into()).spawn(move || {
            let mut last = SystemTime::now();
            loop {
                std::thread::sleep(Duration::from_millis(500));
                let gap = SystemTime::now().duration_since(last).unwrap_or_default();
                last = SystemTime::now();
                if gap > Duration::from_secs(20) && sleeper.is_playing_here() {
                    sleeper.sound.local_pause();
                    sleeper.note("The computer was asleep: pausing.");
                    let me = sleeper.clone();
                    tauri::async_runtime::spawn(async move {
                        if !me.direct_request("PUT", "/me/player/pause") { me.api.request("PUT", "/me/player/pause", None).await; }
                    });
                }
            }
        }).ok();
        me
    }

    pub fn cache_dir(&self) -> PathBuf { files::path("librespot") }
    pub fn has_credentials(&self) -> bool { self.cache_dir().join("credentials.json").exists() }


    pub fn status(&self) -> Value {
        let g = self.inner.lock().unwrap();
        self.status_of(&g)
    }

    fn status_of(&self, g: &Inner) -> Value {
        json!({
            "state": g.state,
            "managed": self.settings.bool("manageLibrespot"),
            "deviceName": self.settings.device_name(),
            "hasCredentials": self.has_credentials(),
            "log": g.log.iter().rev().take(40).rev().cloned().collect::<Vec<_>>(),
            "recovering": g.recovering,
        })
    }

    fn set_state(&self, g: &mut Inner, s: &str) {
        g.state = s.into();
        (self.emit)("librespot", self.status_of(g));
        if g.recovering == "gave-up" { g.recovering.clear(); }
    }

    pub fn note(&self, line: impl Into<String>) {
        let mut g = self.inner.lock().unwrap();
        push_log(&mut g, line.into());
    }

    pub fn start(self: &Arc<Self>) {
        let mut g = self.inner.lock().unwrap();
        if Self::running(&g) { return; }
        self.start_builtin(&mut g);
    }

    pub fn loudness_changed(&self) {
        crate::embedded::set_normalize_type(&self.settings.string("normalizeType"));
        if let Some(e) = self.inner.lock().unwrap().embedded.as_ref() { e.loudness(); }
    }

    fn start_builtin(self: &Arc<Self>, g: &mut Inner) {
        let cache = self.cache_dir();
        let _ = std::fs::create_dir_all(&cache);
        g.generation += 1;
        let generation = g.generation;
        let pipe = crate::sound::MemPipe::new();
        self.sound.attach_memory(pipe.clone());
        let (m, e, x) = (Arc::clone(self), Arc::clone(self), Arc::clone(self));
        crate::embedded::set_normalize_type(&self.settings.string("normalizeType"));
        let cfg = crate::embedded::Config {
            name: self.settings.device_name(),
            cache: cache.clone(),
            bitrate: self.settings.bitrate().to_string(),
            volume: self.settings.volume(),
            normalize: self.settings.bool("normalize"),
            autoplay: self.settings.bool("autoplay"),
        };
        let hooks = crate::embedded::Hooks {
            message: Box::new(move |line| { if m.inner.lock().unwrap().generation == generation { m.consume(&line); } }),
            event: Box::new(move |line| { if e.inner.lock().unwrap().generation == generation { e.handle_events(&line); } }),
            ended: Box::new(move |why| x.builtin_ended(generation, why)),
        };
        g.embedded = Some(crate::embedded::Engine::start(cfg, pipe, hooks));
        push_log(g, format!("Started the built-in engine (librespot {}) as \"{}\", {} kbps.", LIBRESPOT_VERSION, self.settings.device_name(), self.settings.bitrate()));
        let s = if self.has_credentials() { "starting" } else { "login" };
        self.set_state(g, s);
    }

    fn builtin_ended(self: &Arc<Self>, generation: u64, why: String) {
        let mut g = self.inner.lock().unwrap();
        if g.generation != generation || g.embedded.is_none() { return; }      // stopped or replaced on purpose
        g.embedded = None;
        if !why.is_empty() { push_log(&mut g, format!("The built-in engine stopped: {why}")); }
        self.after_exit(g);
    }

    fn running(g: &Inner) -> bool { g.embedded.is_some() }

    /// Stops whichever engine is running.
    fn kill(g: &mut Inner) {
        if let Some(e) = g.embedded.take() { e.stop(); }
    }


    fn consume(self: &Arc<Self>, text: &str) {
        static LOADING: OnceLock<Regex> = OnceLock::new();
        let loading = LOADING.get_or_init(|| Regex::new(r"with Spotify URI <(spotify:track:[A-Za-z0-9]+)>").unwrap());
        let mut then: Vec<Then> = vec![];
        let mut g = self.inner.lock().unwrap();
        push_log(&mut g, text.to_string());
        if g.state != "running" && (text.contains("Authenticated as") || text.contains("Connected to AP")) {
            self.set_state(&mut g, "running");
        }
        if text.contains("Authenticated as") || text.contains("credential file") {
            restrict(&self.cache_dir().join("credentials.json"), 0o600);
            restrict(&self.cache_dir(), 0o700);
        }
        if text.contains("no more tracks left in queue") { (self.emit)("engine.end", json!({})); }
        // Another device (your phone, say) took over.
        if text.contains("device became inactive") {
            g.player.insert("active".into(), json!(false));
            g.track_loaded = false;
            self.emit_player(&mut g);
        }
        if text.contains("audio key response timeout") { g.last_key_failure = Some(Instant::now()); }
        if let Some(c) = loading.captures(text) { g.loading_uri = c[1].to_string(); }
        if let Some(i) = text.find("Cadenza: ") { note_song_path(&mut g, &text[i + 9..]); }
        if text.contains("Unable to load key") { let u = g.loading_uri.clone(); then.push(Then::Refused(u)); }
        if let Some(i) = text.find("Holding: the current track is unavailable <") {
            let uri = text[i..].split('<').nth(1).unwrap_or("").trim_end_matches('>').to_string();
            then.push(Then::Held(uri));
        }
        if text.contains("Connection to server closed") || text.contains("Spirc shut down unexpectedly") {
            let active = g.player.get("active").and_then(Value::as_bool).unwrap_or(false);
            then.push(Then::Dropped("Spotify closed the connection".into(), active));
        }
        drop(g);
        self.run(then);
    }


    fn after_exit(self: &Arc<Self>, mut g: std::sync::MutexGuard<'_, Inner>) {
        g.player.insert("is_playing".into(), json!(false));
        self.emit_player(&mut g);

        let recent = g.log.iter().rev().take(30).cloned().collect::<Vec<_>>().join("\n").to_lowercase();
        let bad_login = ["bad credentials", "badcredentials", "authentication failed", "premium account"].iter().any(|s| recent.contains(s));
        if !self.settings.bool("manageLibrespot") || !self.has_credentials() || bad_login {
            if bad_login {
                push_log(&mut g, "librespot can't log in to Spotify. Leaving it stopped: log in again in System → Engine settings.".into());
                g.recovering = "gave-up".into();
            }
            return self.set_state(&mut g, "error");
        }
        g.crash_times.retain(|t| t.elapsed() < Duration::from_secs(600));
        g.crash_times.push(Instant::now());
        let delay = [1u64, 3, 10, 30, 60][(g.crash_times.len() - 1).min(4)];
        push_log(&mut g, format!("librespot stopped unexpectedly. Restarting it in {delay} s…"));
        g.recovering = "restarting".into();
        self.set_state(&mut g, "starting");
        drop(g);
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(delay));
            if Self::running(&me.inner.lock().unwrap()) { return; }
            me.start();
            if me.wait_running(15.0) {
                let mut g = me.inner.lock().unwrap();
                g.recovering = "recovered".into();
                let s = g.state.clone();
                me.set_state(&mut g, &s);
                g.recovering.clear();
            }
        });
    }

    pub fn stop(&self) {
        let mut g = self.inner.lock().unwrap();
        Self::kill(&mut g);
        self.set_state(&mut g, "stopped");
    }

    pub fn restart_keep_playing(self: &Arc<Self>) {
        let spot = {
            let mut g = self.inner.lock().unwrap();
            push_log(&mut g, "Restarting the audio engine (you asked).".into());
            if Self::playing_here(&g) { Self::position_snapshot(&g) } else { None }
        };
        match spot {
            Some(s) => { let mut s = s; if let Some(m) = s.as_object_mut() { m.remove("at"); } self.restart_then_resume(Some(s), 15.0) }
            None => self.restart(),
        }
    }

    pub fn restart(self: &Arc<Self>) {
        {
            let mut g = self.inner.lock().unwrap();
            Self::kill(&mut g);
            self.set_state(&mut g, "starting");
        }
        let me = Arc::clone(self);
        std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(600)); me.start(); });
    }

    pub fn wait_running(&self, timeout: f64) -> bool {
        let until = Instant::now() + Duration::from_secs_f64(timeout);
        while Instant::now() < until {
            if self.inner.lock().unwrap().state == "running" { return true; }
            std::thread::sleep(Duration::from_millis(250));
        }
        false
    }

    // MARK: player events





    fn handle_events(self: &Arc<Self>, text: &str) {
        let mut guard = self.inner.lock().unwrap();
        let g = &mut *guard;
        let mut changed = false;
        let mut then: Vec<Then> = vec![];
        for line in text.lines() {
            let f: Vec<&str> = line.split('\t').collect();
            if f.len() < 11 { continue; }
            let (event, uri, track_id) = (f[0], f[1], f[2]);
            let ms = |s: &str| s.trim().parse::<i64>().ok();
            if event != "volume_changed" { push_log(g, format!("event: {event} at {} ms", f[8].trim())); }
            let p = &mut g.player;
            match event {
                "track_changed" => {
                    g.track_loaded = true;
                    g.hold_streak = 0;
                    if let Some(failed) = g.pending_retry.take() {
                        let now = if uri.is_empty() { format!("spotify:track:{track_id}") } else { uri.to_string() };
                        if now != failed { then.push(Then::Retry(failed)); }
                    }
                    let p = &mut g.player;
                    let covers: Vec<&str> = f[6].split('|').filter(|s| !s.is_empty()).collect();
                    let art = covers.iter().find(|c| c.contains("ab67616d0000b273")).or(covers.first()).copied().unwrap_or("");
                    p.insert("uri".into(), json!(if uri.is_empty() { format!("spotify:track:{track_id}") } else { uri.to_string() }));
                    p.insert("name".into(), json!(f[3]));
                    p.insert("artists".into(), json!(f[4].split('|').filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", ")));
                    p.insert("album".into(), json!(f[5]));
                    p.insert("image".into(), json!(art));
                    if let Some(d) = ms(f[7]) { p.insert("duration_ms".into(), json!(d)); }
                    p.insert("progress_ms".into(), json!(0));
                    g.pos_at = now_ms();
                    changed = true;
                    then.push(Then::NewSong(ms(f[7])));
                    if Self::playing_here(g) { then.push(Then::ReleaseIfHeld); }
                }
                "playing" | "paused" | "seeked" | "position_correction" => {
                    let playing = p.get("is_playing").and_then(Value::as_bool).unwrap_or(false);
                    if let (Some(prog), true) = (p.get("progress_ms").and_then(Value::as_i64), playing && g.pos_at > 0.0) {
                        p.insert("progress_ms".into(), json!(prog + (now_ms() - g.pos_at) as i64));
                    }
                    g.pos_at = now_ms();
                    let p = &mut g.player;
                    let now_playing = match event { "playing" => true, "paused" => false, _ => playing || !p.contains_key("is_playing") };
                    p.insert("is_playing".into(), json!(now_playing));
                    if let Some(pos) = ms(f[8]) { p.insert("progress_ms".into(), json!(pos)); }
                    if !uri.is_empty() { p.insert("uri".into(), json!(uri)); }
                    p.insert("active".into(), json!(true));
                    if event == "playing" { then.push(Then::CheckSound); }
                    if event == "seeked" { then.push(Then::Seeked); }        // the new spot is heard at once
                    if event != "paused" && now_playing { then.push(Then::ReleaseIfHeld); }
                    if let Some(pos) = ms(f[8]) {
                        let dur = g.player.get("duration_ms").and_then(Value::as_i64);
                        then.push(Then::Position(pos, dur));
                    }
                    if event == "paused" { g.last_stop_at = Some(Instant::now()); }
                    changed = true;
                }
                "stopped" => {
                    let playing = p.get("is_playing").and_then(Value::as_bool).unwrap_or(false);
                    if let (Some(prog), true) = (p.get("progress_ms").and_then(Value::as_i64), playing && g.pos_at > 0.0) {
                        p.insert("progress_ms".into(), json!(prog + (now_ms() - g.pos_at) as i64));
                    }
                    g.pos_at = now_ms();
                    g.track_loaded = false;
                    g.player.insert("is_playing".into(), json!(false));
                    g.last_stop_at = Some(Instant::now());
                    changed = true;
                }
                "session_disconnected" => {
                    let was = p.get("active").and_then(Value::as_bool).unwrap_or(false);
                    p.insert("active".into(), json!(false));
                    changed = true;
                    then.push(Then::Dropped("librespot reported the session dropped".into(), was));
                }
                "session_connected" | "started" | "loading" => { p.insert("active".into(), json!(true)); changed = true; }
                "volume_changed" => {
                    if let Some(v) = ms(f[9]) {
                        let pct = ((v as f64) / 65535.0 * 100.0).round() as i64;
                        p.insert("volume".into(), json!(pct));
                        self.settings.put("volume", json!(pct));
                    }
                    changed = true;
                }
                "unavailable" => {
                    let line = format!("librespot couldn't load a song ({track_id}); it skips it by itself.");
                    push_log(g, line);
                    then.push(Then::RetryLater(if uri.is_empty() { format!("spotify:track:{track_id}") } else { uri.to_string() }));
                }
                _ => {}
            }
        }
        if changed { self.emit_player(g); }
        drop(guard);
        self.run(then);
    }

    fn emit_player(&self, g: &mut Inner) {
        let now = now_ms();
        g.player.insert("device".into(), json!(self.settings.device_name()));
        let mut out = g.player.clone();
        let playing = out.get("is_playing").and_then(Value::as_bool).unwrap_or(false);
        if let (Some(p), true) = (out.get("progress_ms").and_then(Value::as_i64), playing && g.pos_at > 0.0) {
            let d = out.get("duration_ms").and_then(Value::as_i64).unwrap_or(i64::MAX);
            out.insert("progress_ms".into(), json!(d.min(p + (now - g.pos_at) as i64)));
        }
        out.insert("at".into(), json!(now));
        (self.emit)("player", Value::Object(out));
        self.history.observe(&g.player);
        // An interrupted sleep fade mustn't leave the volume down.
        if !self.sound.sleep_fading() && self.sound.transition_volume() < 0.999 { self.sound.reset_transition(); }
    }

    fn release_if_held(&self) {
        if !self.sound.holding() { return; }
        if self.sound.locally_paused_at().map_or(false, |t| t.elapsed() < Duration::from_secs(4)) { return; }
        self.note("Spotify is playing but Cadenza's player was still paused: letting the sound through.");
        self.sound.local_resume();
    }

    pub fn snapshot(&self) -> Option<Value> { Self::position_snapshot(&self.inner.lock().unwrap()) }

    pub fn is_active_here(&self) -> bool { Self::active_here(&self.inner.lock().unwrap()) }
    pub fn is_playing_here(&self) -> bool { Self::playing_here(&self.inner.lock().unwrap()) }

    pub fn verify_pause(self: &Arc<Self>) {
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            for attempt in 0..2 {
                tokio::time::sleep(Duration::from_secs(if attempt == 0 { 4 } else { 3 })).await;
                let held = me.sound.holding() && me.is_playing_here()
                    && me.sound.locally_paused_at().map_or(false, |t| t.elapsed() > Duration::from_secs(3));
                if !held { return; }                                   // paused properly, or playing again
                let (status, p) = me.api.request("GET", "/me/player", None).await;
                let still = status == 200 && p.get("is_playing").and_then(Value::as_bool) == Some(true)
                    && p.pointer("/device/name").and_then(Value::as_str) == Some(me.settings.device_name().as_str());
                if !still {
                    if status == 200 || status == 204 {
                        let mut g = me.inner.lock().unwrap();
                        g.player.insert("is_playing".into(), json!(false));
                        me.emit_player(&mut g);
                    }
                    return;
                }
                if attempt == 0 {
                    me.note("Spotify didn't pause: asking again.");
                    if !me.direct_request("PUT", "/me/player/pause") { me.api.request("PUT", "/me/player/pause", None).await; }
                } else {
                    me.note("Spotify kept playing after being asked to pause: playing here too so nothing gets stuck.");
                    me.sound.local_resume();
                }
            }
        });
    }

    // MARK: playing directly

    pub fn direct(self: &Arc<Self>, action: &str, a: &Value) -> Value {
        use crate::embedded::Direct;
        let no = |why: &str| json!({"ok": false, "reason": why});
        let (engine, active, loaded) = {
            let mut g = self.inner.lock().unwrap();
            let Some(e) = g.embedded.clone() else { return no("not the built-in engine") };
            if g.state != "running" { return no("the engine isn't connected yet"); }
            if let Some(dev) = a.get("device_id").and_then(Value::as_str) {
                if dev != crate::embedded::device_id(&self.settings.device_name()) { return no("another device"); }
            }
            let waiting = g.hold_until.map_or(false, |t| Instant::now() < t);
            if action == "next" && waiting {
                g.hold_skips += 1;
                let left = g.hold_until.map(|t| t.saturating_duration_since(Instant::now()).as_secs_f64()).unwrap_or(0.0);
                let n = g.hold_skips + 1;
                drop(g);
                (self.emit)("engine.held", json!({"wait_ms": (left * 1000.0) as u64, "skips": n}));
                return json!({"ok": true});
            }
            if action == "play" && waiting {
                let n = g.hold_skips + 1;
                g.hold_until = None; g.hold_skips = 0; g.hold_token += 1;
                drop(g);
                let _ = e.direct(crate::embedded::Direct::Next(n));
                let _ = e.direct(crate::embedded::Direct::Play);
                return json!({"ok": true});
            }
            if !matches!(action, "queue" | "clear") { g.hold_token += 1; g.hold_until = None; g.hold_skips = 0; }
            (e, Self::active_here(&g), g.track_loaded)
        };
        let s = |k: &str| a.get(k).and_then(Value::as_str).map(String::from);
        let n = |k: &str| a.get(k).and_then(Value::as_u64);
        let d = match action {
            "load" => Direct::Load {
                tracks: a.get("tracks").and_then(Value::as_array).map(|v| v.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
                context: s("context"),
                from_uri: s("from_uri"),
                from_index: n("from_index").map(|x| x as u32),
                position: n("position").unwrap_or(0) as u32,
                play: a.get("play").and_then(Value::as_bool).unwrap_or(true),
                shuffle: a.get("shuffle").and_then(Value::as_bool).unwrap_or(false),
                repeat: s("repeat").unwrap_or_else(|| "off".into()),
                take_over: !active,
            },
            _ if !active => return no("another device is playing"),
            "play" if !loaded => return no("nothing loaded"),
            "play" => Direct::Play,
            "pause" => Direct::Pause,
            "next" => return self.direct_next(engine),
            "previous" => Direct::Previous,
            "seek" => Direct::Seek(n("position").unwrap_or(0) as u32),
            "volume" => Direct::Volume(n("volume").unwrap_or(70) as u32),
            "shuffle" => Direct::Shuffle(a.get("state").and_then(Value::as_bool).unwrap_or(false)),
            "repeat" => Direct::Repeat(s("state").unwrap_or_else(|| "off".into())),
            "queue" => match s("uri") { Some(u) => Direct::Queue(u), None => return no("no song") },
            "clear" => Direct::ClearQueue,
            _ => return no("unknown"),
        };
        match engine.direct(d) {
            Ok(()) => json!({"ok": true}),
            Err(e) => { self.note(format!("The built-in engine couldn't do that ({action}): {e}")); no(&e) }
        }
    }

    pub fn song_path(&self) -> (Option<SongPath>, bool) {
        let g = self.inner.lock().unwrap();
        let here = g.player.get("active").and_then(Value::as_bool).unwrap_or(false);
        (g.song.clone(), here)
    }

    pub fn direct_request(self: &Arc<Self>, method: &str, path: &str) -> bool {
        let (p, q) = path.split_once('?').unwrap_or((path, ""));
        let qv = |k: &str| url::form_urlencoded::parse(q.as_bytes()).find(|(a, _)| a == k).map(|(_, v)| v.to_string());
        let (action, args) = match (method, p) {
            ("POST", "/me/player/next") => ("next", json!({})),
            ("POST", "/me/player/previous") => ("previous", json!({})),
            ("PUT", "/me/player/play") => ("play", json!({})),
            ("PUT", "/me/player/pause") => ("pause", json!({})),
            ("PUT", "/me/player/seek") => ("seek", json!({"position": qv("position_ms").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0)})),
            _ => return false,
        };
        self.direct(action, &args).get("ok").and_then(Value::as_bool).unwrap_or(false)
    }

    fn direct_next(self: &Arc<Self>, engine: Arc<crate::embedded::Engine>) -> Value {
        const GAP: Duration = Duration::from_millis(350);
        let mut g = self.inner.lock().unwrap();
        let burst = g.skip_last.map_or(false, |t| t.elapsed() < GAP);
        g.skip_last = Some(Instant::now());
        if !burst {
            drop(g);
            return match engine.direct(crate::embedded::Direct::Next(1)) { Ok(()) => json!({"ok": true}), Err(e) => json!({"ok": false, "reason": e}) };
        }
        g.skip_pending += 1;
        if !g.skip_flushing {
            g.skip_flushing = true;
            let me = Arc::clone(self);
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(50));
                let mut g = me.inner.lock().unwrap();
                if g.skip_last.map_or(false, |t| t.elapsed() < GAP) { continue; }
                let n = std::mem::take(&mut g.skip_pending);
                g.skip_flushing = false;
                drop(g);
                if n > 0 {
                    me.note(format!("Skipped {n} more songs in one go."));
                    let _ = engine.direct(crate::embedded::Direct::Next(n));
                }
                break;
            });
        }
        json!({"ok": true})
    }

    fn held(self: &Arc<Self>, uri: String) {
        const WAITS: [u64; 6] = [1500, 3000, 6000, 12000, 20000, 30000];
        let mut g = self.inner.lock().unwrap();
        let Some(engine) = g.embedded.clone() else { return };
        let refused = within(g.last_song_refusal, 8);
        if !refused && within(g.last_key_failure, 20) { return; }   // retry_later has it
        if !within(g.last_hold, 90) { g.hold_streak = 0; }
        g.last_hold = Some(Instant::now());
        let wait = if refused { let w = WAITS[(g.hold_streak as usize).min(WAITS.len() - 1)]; g.hold_streak += 1; w } else { 300 };
        let token = g.hold_token;
        g.hold_until = Some(Instant::now() + Duration::from_millis(wait));
        g.hold_skips = 0;
        push_log(&mut g, format!("Spotify won't play {uri}{}: moving on in {:.1} s.", if refused { " right now" } else { "" }, wait as f64 / 1000.0));
        drop(g);
        if refused { (self.emit)("engine.held", json!({"uri": uri, "wait_ms": wait})); }
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(wait));
            let n = {
                let mut g = me.inner.lock().unwrap();
                if g.hold_token != token { return; }               // you picked something meanwhile
                g.hold_until = None;
                std::mem::take(&mut g.hold_skips) + 1
            };
            if n > 1 { me.note(format!("Skipping {n} songs ahead (Next was pressed while waiting).")); }
            let _ = engine.direct(crate::embedded::Direct::Next(n));
            let _ = engine.direct(crate::embedded::Direct::Play);
        });
    }

    // MARK: recovery

    fn run(self: &Arc<Self>, then: Vec<Then>) {
        for t in then {
            match t {
                Then::CheckSound => self.check_sound(),
                Then::NewSong(dur) => {
                    if self.sound.transition_volume() < 0.999 && !self.sound.sleep_fading() { self.sound.ramp_transition(1.0, 1.6); }
                    self.sound.track_changed();
                    self.sound.song_position(None, dur, true);
                }
                Then::Position(ms, dur) => self.sound.song_position(Some(ms as f64), dur, false),
                Then::Seeked => self.sound.seeked(),
                Then::ReleaseIfHeld => self.release_if_held(),
                Then::Retry(uri) => self.retry_now(uri),
                Then::RetryLater(uri) => self.retry_later(uri),
                Then::Dropped(reason, was_active) => self.session_dropped(&reason, was_active),
                Then::Refused(uri) => self.key_refused(uri),
                Then::Held(uri) => self.held(uri),
            }
        }
    }

    fn playing_here(g: &Inner) -> bool { g.player.get("is_playing").and_then(Value::as_bool).unwrap_or(false) }
    fn active_here(g: &Inner) -> bool { Self::running(g) && g.player.get("active").and_then(Value::as_bool).unwrap_or(false) }
    fn refused_recently(g: &Inner) -> bool { within(g.last_song_refusal, 15) }

    fn key_refused(&self, uri: String) {
        let mut g = self.inner.lock().unwrap();
        g.last_song_refusal = Some(Instant::now());
        g.refusals.retain(|_, t| t.elapsed() < Duration::from_secs(600));
        if uri.is_empty() { return; }
        if g.refusals.insert(uri.clone(), Instant::now()).is_none() {
            push_log(&mut g, format!("Spotify won't unlock {uri} right now; librespot skips it and the next song plays."));
        }
        drop(g);
        (self.emit)("engine.refused", json!({"uri": uri}));
    }

    fn retry_later(self: &Arc<Self>, uri: String) {
        let mut g = self.inner.lock().unwrap();
        if g.refusals.contains_key(&uri) || !within(g.last_key_failure, 20) || within(g.last_drop, 45) || !Self::active_here(&g) { return; }
        if g.retried.get(&uri).map_or(false, |t| t.elapsed() < Duration::from_secs(600)) { return; }
        g.retried.retain(|_, t| t.elapsed() < Duration::from_secs(600));
        g.retried.insert(uri.clone(), Instant::now());
        if g.player.get("uri").and_then(Value::as_str) == Some(uri.as_str()) {
            drop(g);
            self.retry_now(uri);
        } else {
            g.pending_retry = Some(uri);
            push_log(&mut g, "Spotify was slow to send that song's key: Cadenza will try it again after this song.".into());
        }
    }

    fn retry_now(self: &Arc<Self>, uri: String) {
        self.note(format!("Trying the song that didn't load once more ({uri})."));
        let emit = self.emit.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(1));
            emit("engine.resume", json!({"uri": uri, "position_ms": 0, "retry": true}));
        });
    }

    fn position_snapshot(g: &Inner) -> Option<Value> {
        let uri = g.player.get("uri").and_then(Value::as_str).filter(|u| !u.is_empty())?;
        if !Self::active_here(g) { return None; }
        let now = now_ms();
        let mut pos = g.player.get("progress_ms").and_then(Value::as_i64).unwrap_or(0);
        if Self::playing_here(g) && g.pos_at > 0.0 { pos += (now - g.pos_at) as i64; }
        let dur = g.player.get("duration_ms").and_then(Value::as_i64).unwrap_or(0);
        if dur > 0 { pos = pos.min(dur); }
        Some(json!({"uri": uri, "position_ms": pos, "duration_ms": dur, "at": now as i64}))
    }

    fn session_dropped(self: &Arc<Self>, reason: &str, was_active: bool) {
        let mut g = self.inner.lock().unwrap();
        if !self.settings.bool("manageLibrespot") || !Self::running(&g) { return; }
        if !was_active || !Self::playing_here(&g) {
            drop(g);
            return self.schedule_device_check(20, reason);
        }
        if within(g.last_drop, 45) { return; }                   // one recovery at a time
        g.last_drop = Some(Instant::now());
        g.last_device_fix = Some(Instant::now());               // this restart is the fix
        g.device_check_at = None;
        let mut snapshot = Self::position_snapshot(&g).unwrap_or(json!({}));
        if let Some(m) = snapshot.as_object_mut() { m.remove("at"); }
        push_log(&mut g, format!("Spotify closed the engine's connection ({reason}): restarting it now and picking up where you were."));
        g.player.insert("is_playing".into(), json!(false));
        self.emit_player(&mut g);
        drop(g);
        self.restart_then_resume(Some(snapshot), 15.0);
    }

    fn restart_then_resume(self: &Arc<Self>, spot: Option<Value>, timeout: f64) {
        self.restart();
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(700));
            if !me.wait_running(timeout) { return; }
            std::thread::sleep(Duration::from_millis(1200));
            match &spot {
                Some(s) if s.get("uri").is_some() => (me.emit)("engine.resume", s.clone()),
                _ => { let m = Arc::clone(&me); tauri::async_runtime::spawn(async move { m.transfer_here(true, 10).await; }); }
            }
            std::thread::sleep(Duration::from_secs(10));
            if !Self::playing_here(&me.inner.lock().unwrap()) {
                me.note("Still nothing playing after the restart: handing the music back to Cadenza.");
                let m = Arc::clone(&me);
                tauri::async_runtime::spawn(async move { m.transfer_here(true, 10).await; });
            }
        });
    }

    fn check_sound(self: &Arc<Self>) {
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(1));
            me.sound.ensure_audible();
            std::thread::sleep(Duration::from_secs(4));
            let g = me.inner.lock().unwrap();
            if !Self::running(&g) || !Self::playing_here(&g) || me.sound.seconds_since_audio() <= 4.0
                || Self::refused_recently(&g) || within(g.last_rescue, 60) { return; }
            drop(g);
            me.rescue("Playing, but no sound is reaching Cadenza: restarting the audio engine.");
        });
    }

    fn rescue(self: &Arc<Self>, why: &str) {
        let spot = {
            let mut g = self.inner.lock().unwrap();
            g.last_rescue = Some(Instant::now());
            g.last_device_fix = Some(Instant::now());
            push_log(&mut g, why.into());
            Self::position_snapshot(&g)
        };
        self.restart_then_resume(spot, 12.0);
    }

    fn watch_sound(self: &Arc<Self>) {
        let mut g = self.inner.lock().unwrap();
        let paused_here = self.sound.locally_paused_at().map_or(false, |t| t.elapsed() < Duration::from_secs(12));
        let stalled = Self::running(&g) && Self::playing_here(&g) && Self::active_here(&g) && self.sound.seconds_since_audio() > 3.0
            && !Self::refused_recently(&g) && !paused_here;
        if !stalled { g.stall_since = None; return; }
        let since = *g.stall_since.get_or_insert_with(Instant::now);
        if since.elapsed() < Duration::from_secs(9) || within(g.last_rescue, 60) { return; }
        g.stall_since = None;
        g.last_rescue = Some(Instant::now());
        drop(g);
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let (status, p) = me.api.request("GET", "/me/player", None).await;
            let here = status == 200 && p.get("is_playing").and_then(Value::as_bool) == Some(true)
                && p.pointer("/device/name").and_then(Value::as_str) == Some(me.settings.device_name().as_str());
            if !here {
                me.note("No sound, but Spotify says it isn't playing here: leaving it paused.");
                let mut g = me.inner.lock().unwrap();
                g.player.insert("is_playing".into(), json!(false));
                me.emit_player(&mut g);
                return;
            }
            me.rescue("Still no sound: restarting the audio engine and picking the song back up.");
        });
    }

    fn follow_the_sound(&self) {
        let mut g = self.inner.lock().unwrap();
        if !Self::running(&g) { g.flowing_ticks = 0; return; }
        g.flowing_ticks = if self.sound.seconds_since_audio() < 0.3 { g.flowing_ticks + 1 } else { 0 };
        if g.flowing_ticks < 2 || Self::playing_here(&g) || within(g.last_stop_at, 4) { return; }
        g.pos_at = now_ms();
        g.player.insert("is_playing".into(), json!(true));
        g.player.insert("active".into(), json!(true));
        push_log(&mut g, "Sound is playing although librespot reported a stop: showing it as playing.".into());
        self.emit_player(&mut g);
    }

    pub fn schedule_device_check(&self, after_secs: u64, reason: &str) {
        self.inner.lock().unwrap().device_check_at = Some((Instant::now() + Duration::from_secs(after_secs), reason.to_string()));
    }

    fn run_device_check(self: &Arc<Self>) {
        let due = {
            let mut g = self.inner.lock().unwrap();
            match &g.device_check_at {
                Some((at, _)) if Instant::now() >= *at => g.device_check_at.take().map(|(_, r)| r),
                _ => None,
            }
        };
        let Some(reason) = due else { return };
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move { me.check_device_because(&reason).await; });
    }

    // MARK: making sure Spotify sees Cadenza as a speaker

    pub async fn transfer_here(&self, play: bool, attempts: u32) -> bool {
        let name = self.settings.device_name();
        for _ in 0..=attempts {
            let (_, json) = self.api.request("GET", "/me/player/devices", None).await;
            let id = json.get("devices").and_then(Value::as_array).and_then(|list| {
                list.iter().find(|d| d.get("name").and_then(Value::as_str) == Some(&name)).and_then(|d| d.get("id")).and_then(Value::as_str).map(String::from)
            });
            if let Some(id) = id {
                let (status, _) = self.api.request("PUT", "/me/player", Some(&json!({"device_ids": [id], "play": play}))).await;
                if status < 300 { return true; }
                tokio::time::sleep(Duration::from_millis(600)).await;
            } else {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
        false
    }

    pub async fn check_device(self: &Arc<Self>) -> bool { self.check_device_because("the page couldn't find it").await }

    async fn check_device_because(self: &Arc<Self>, reason: &str) -> bool {
        if !self.settings.bool("manageLibrespot") || !self.has_credentials() { return false; }
        let running = Self::running(&self.inner.lock().unwrap());
        if !running {
            self.note(format!("librespot isn't running ({reason}): starting it."));
            self.start();
            let me = Arc::clone(self);
            return tokio::task::spawn_blocking(move || me.wait_running(15.0)).await.unwrap_or(false);
        }
        let (status, json) = self.api.request("GET", "/me/player/devices", None).await;
        if status != 200 { return false; }
        let name = self.settings.device_name();
        let listed = json.get("devices").and_then(Value::as_array)
            .map(|l| l.iter().any(|d| d.get("name").and_then(Value::as_str) == Some(&name))).unwrap_or(false);
        if listed { return true; }
        {
            // At most one restart every 45 s.
            let mut g = self.inner.lock().unwrap();
            if within(g.last_device_fix, 45) { return false; }
            g.last_device_fix = Some(Instant::now());
        }
        self.note(format!("Spotify doesn't list {name} as a speaker ({reason}): restarting librespot so it shows up again."));
        self.restart();
        let me = Arc::clone(self);
        tokio::task::spawn_blocking(move || { std::thread::sleep(Duration::from_millis(700)); me.wait_running(15.0) }).await.unwrap_or(false)
    }

    /// For "Copy diagnostics".
    pub fn diagnostics(&self) -> Vec<String> {
        let mut out = vec![];
        out.push(format!("librespot: built in, version {LIBRESPOT_VERSION}"));
        let g = self.inner.lock().unwrap();
        let playing = g.player.get("is_playing").and_then(Value::as_bool).unwrap_or(false);
        out.push(format!("engine state: {}, playing here: {playing}, sound output: {}", g.state, self.sound.output_name()));
        out.push(String::new());
        out.push("== engine log ==".into());
        out.extend(g.log.iter().rev().take(80).rev().cloned());
        out
    }

    pub fn shutdown(&self) {
        self.history.finish();
        let mut g = self.inner.lock().unwrap();
        Self::kill(&mut g);
    }
}

const LIBRESPOT_VERSION: &str = match option_env!("CADENZA_LIBRESPOT_VERSION") { Some(v) => v, None => "0.8.0" };

fn push_log(g: &mut Inner, line: String) {
    log::info!("engine: {line}");
    g.log.push(line);
    if g.log.len() > 200 { let extra = g.log.len() - 200; g.log.drain(..extra); }
}

fn restrict(_p: &Path, _mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(_p, std::fs::Permissions::from_mode(_mode));
    }
}

fn tidy_old_engine_files() {
    let _ = std::fs::remove_file(files::path("librespot-events.txt"));
    let note = files::path("event-hook-folder.txt");
    if let Ok(dir) = std::fs::read_to_string(&note) {
        let dir = PathBuf::from(dir.trim());
        let ours = dir.file_name().and_then(|n| n.to_str()).map_or(false, |n| n.starts_with("cadenza-"))
            && dir.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()).map_or(false, |n| n.eq_ignore_ascii_case("ProgramData"));
        if ours { let _ = std::fs::remove_dir_all(&dir); }
        let _ = std::fs::remove_file(&note);
    }
}

#[cfg(test)]
mod song_path_tests {
    use super::*;

    #[test]
    fn the_two_log_lines_give_the_songs_file_and_loudness() {
        let mut g = Inner::default();
        note_song_path(&mut g, "file <spotify:track:AAA> OGG_VORBIS_320");
        note_song_path(&mut g, "playing <spotify:track:AAA> loudness -2.41 dB (Track)");
        let s = g.song.clone().unwrap();
        assert_eq!((s.uri.as_str(), s.format.as_str(), s.loudness_db), ("spotify:track:AAA", "OGG_VORBIS_320", Some(-2.41)));

        note_song_path(&mut g, "file <spotify:track:BBB> OGG_VORBIS_160");
        assert_eq!(g.song.as_ref().unwrap().uri, "spotify:track:AAA");
        note_song_path(&mut g, "playing <spotify:track:BBB> loudness off");
        let s = g.song.unwrap();
        assert_eq!((s.format.as_str(), s.loudness_db), ("OGG_VORBIS_160", None));
    }

    #[test]
    fn other_lines_and_odd_ones_are_ignored() {
        let mut g = Inner::default();
        note_song_path(&mut g, "file <> OGG_VORBIS_320");
        note_song_path(&mut g, "playing nothing");
        note_song_path(&mut g, "something else");
        assert!(g.song.is_none() && g.files.is_empty());
    }
}
