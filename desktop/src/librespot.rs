//! Runs librespot (the Spotify Connect engine) as a child process, reads what it's playing from its
//! --onevent hook, and hands its sound to Cadenza's output. A port of the core of Librespot.swift; the
//! recovery tricks (refused keys, dropped sessions, stall rescue) follow in phase 2.

use regex::Regex;
use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::api::Api;
use crate::files;
use crate::settings::Settings;
use crate::sound::Sound;

pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    /// Counts starts, so a process that ends after being replaced isn't mistaken for the current one.
    generation: u64,
    state: String,              // stopped | starting | login | running | missing | error
    log: Vec<String>,
    player: Map<String, Value>,
    /// When player.progress_ms was last true.
    pos_at: f64,
    opened_auth: bool,
    events_offset: u64,
    crash_times: Vec<Instant>,
    recovering: String,
}

pub struct Librespot {
    inner: Mutex<Inner>,
    settings: Arc<Settings>,
    api: Arc<Api>,
    sound: Arc<Sound>,
    emit: Emit,
}

impl Librespot {
    pub fn new(settings: Arc<Settings>, api: Arc<Api>, sound: Arc<Sound>, emit: Emit) -> Arc<Self> {
        let me = Arc::new(Librespot {
            inner: Mutex::new(Inner { state: "stopped".into(), ..Default::default() }),
            settings, api, sound, emit,
        });
        // Read librespot's player events as they come (a few times a second is plenty).
        let watcher = Arc::clone(&me);
        std::thread::Builder::new().name("cadenza-events".into()).spawn(move || loop {
            std::thread::sleep(Duration::from_millis(250));
            watcher.read_events();
        }).ok();
        me
    }

    pub fn cache_dir(&self) -> PathBuf { files::path("librespot") }
    fn events_file(&self) -> PathBuf { files::path("librespot-events.txt") }
    pub fn has_credentials(&self) -> bool { self.cache_dir().join("credentials.json").exists() }

    /// Your own pick first, then a copy next to Cadenza, then the usual install places.
    pub fn resolve_path(&self) -> Option<PathBuf> {
        let exe = if cfg!(windows) { "librespot.exe" } else { "librespot" };
        let mut candidates: Vec<PathBuf> = vec![];
        let custom = self.settings.string("librespotPath");
        if !custom.is_empty() { candidates.push(expand_tilde(&custom)); }
        if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
            candidates.push(dir.join(exe));
        }
        candidates.push(files::path("engine").join(exe));
        if let Some(home) = dirs::home_dir() { candidates.push(home.join(".cargo/bin").join(exe)); }
        if cfg!(unix) {
            for p in ["/opt/homebrew/bin/librespot", "/usr/local/bin/librespot", "/usr/bin/librespot"] { candidates.push(PathBuf::from(p)); }
        }
        candidates.into_iter().find(|p| is_executable(p))
    }

    pub fn status(&self) -> Value {
        let g = self.inner.lock().unwrap();
        self.status_of(&g)
    }

    fn status_of(&self, g: &Inner) -> Value {
        json!({
            "state": g.state,
            "path": self.resolve_path().map(|p| files::tidy(&p)).unwrap_or_default(),
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
        if g.child.is_some() { return; }
        let Some(path) = self.resolve_path() else {
            push_log(&mut g, "librespot not found. Build it with desktop/librespot.sh, install it (cargo install librespot), or set its path in System → Engine settings.".into());
            return self.set_state(&mut g, "missing");
        };
        let cache = self.cache_dir();
        let _ = std::fs::create_dir_all(&cache);
        kill_strays(&cache);

        let mut args: Vec<String> = vec![
            "--name".into(), self.settings.device_name(),
            "--cache".into(), cache.display().to_string(),
            "--bitrate".into(), self.settings.bitrate().to_string(),
            "--initial-volume".into(), self.settings.volume().to_string(),
            // Spotify's default volume curve spans 60 dB, which makes everything below 100% very quiet.
            "--volume-ctrl".into(), "log".into(), "--volume-range".into(), "30".into(),
            "--backend".into(), "pipe".into(),
        ];
        // Even loudness from song to song, with a little make-up gain.
        if self.settings.bool("normalize") {
            args.extend(["--enable-volume-normalisation", "--normalisation-pregain", "3"].map(String::from));
        }
        if supports(&path, "--autoplay") {
            args.extend(["--autoplay".into(), if self.settings.bool("autoplay") { "on" } else { "off" }.into()]);
        }
        if !self.has_credentials() { args.push("--enable-oauth".into()); }
        if let Some(hook) = self.prepare_event_hook(&mut g) { args.extend(["--onevent".into(), hook]); }

        let mut cmd = Command::new(&path);
        cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);       // no console window
        }
        match cmd.spawn() {
            Ok(mut child) => {
                g.generation += 1;
                let generation = g.generation;
                if let Some(out) = child.stdout.take() { self.sound.attach(out); }
                if let Some(err) = child.stderr.take() { self.read_messages(err, generation); }
                g.child = Some(child);
                g.opened_auth = false;
                push_log(&mut g, format!("Started: {} {}", files::tidy(&path), args.join(" ")));
                let s = if self.has_credentials() { "starting" } else { "login" };
                self.set_state(&mut g, s);
            }
            Err(e) => {
                push_log(&mut g, format!("Couldn't start librespot: {e}"));
                self.set_state(&mut g, "error");
            }
        }
    }

    /// librespot's messages (its standard error), until it quits.
    fn read_messages(self: &Arc<Self>, err: impl Read + Send + 'static, generation: u64) {
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines() {
                let Ok(line) = line else { break };
                me.consume(&line);
            }
            me.exited(generation);
        });
    }

    fn consume(self: &Arc<Self>, text: &str) {
        static AUTH: OnceLock<Regex> = OnceLock::new();
        let auth = AUTH.get_or_init(|| Regex::new(r#"https://accounts\.spotify\.com/authorize[^\s"'<>]*"#).unwrap());
        let mut g = self.inner.lock().unwrap();
        push_log(&mut g, text.to_string());
        // First run: librespot prints a Spotify sign-in link. Open it.
        if !g.opened_auth {
            if let Some(m) = auth.find(text) {
                g.opened_auth = true;
                let _ = open::that(m.as_str());
                self.set_state(&mut g, "login");
            }
        }
        if g.state != "running" && (text.contains("Authenticated as") || text.contains("Connected to AP")) {
            self.set_state(&mut g, "running");
        }
        // librespot saves your login readable by everyone (and warns about it). Keep it to you.
        if text.contains("Authenticated as") || text.contains("credential file") {
            restrict(&self.cache_dir().join("credentials.json"), 0o600);
            restrict(&self.cache_dir(), 0o700);
        }
        if text.contains("no more tracks left in queue") { (self.emit)("engine.end", json!({})); }
    }

    /// The process ended. If Cadenza didn't stop it, it fell over: start it again after a pause that grows
    /// with each crash (1 s, 3 s, 10 s, 30 s, then once a minute), unless the login itself is bad.
    fn exited(self: &Arc<Self>, generation: u64) {
        let mut g = self.inner.lock().unwrap();
        if g.generation != generation || g.child.is_none() { return; }      // stopped or replaced on purpose
        let status = g.child.take().and_then(|mut c| c.wait().ok());
        let code = status.and_then(|s| s.code()).map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
        push_log(&mut g, format!("librespot exited ({code})"));
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
            if me.inner.lock().unwrap().child.is_some() { return; }
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
        if let Some(mut c) = g.child.take() { let _ = c.kill(); let _ = c.wait(); }
        self.set_state(&mut g, "stopped");
    }

    pub fn restart(self: &Arc<Self>) {
        {
            let mut g = self.inner.lock().unwrap();
            if let Some(mut c) = g.child.take() { let _ = c.kill(); let _ = c.wait(); }
            self.set_state(&mut g, "starting");
        }
        let me = Arc::clone(self);
        std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(600)); me.start(); });
    }

    /// Waits (blocking) until librespot says it's connected, up to `timeout` seconds.
    pub fn wait_running(&self, timeout: f64) -> bool {
        let until = Instant::now() + Duration::from_secs_f64(timeout);
        while Instant::now() < until {
            if self.inner.lock().unwrap().state == "running" { return true; }
            std::thread::sleep(Duration::from_millis(250));
        }
        false
    }

    // MARK: player events

    /// Writes a tiny script librespot runs on every player event; it appends one line per event to a file
    /// Cadenza reads. Returns the script's path for --onevent.
    #[cfg(unix)]
    fn prepare_event_hook(&self, g: &mut Inner) -> Option<String> {
        use std::os::unix::fs::PermissionsExt;
        // librespot splits --onevent on spaces, so the script must live somewhere without any.
        let mut hook = std::env::temp_dir().join("cadenza-librespot-event.sh");
        if hook.display().to_string().contains(char::is_whitespace) {
            hook = PathBuf::from(format!("/tmp/cadenza-{}-librespot-event.sh", user_tag()));
        }
        let events = self.events_file();
        let target = format!("'{}'", events.display().to_string().replace('\'', "'\\''"));
        let script = format!(r#"#!/bin/sh
# Written by Cadenza: passes librespot's player events to the app.
a=$(printf '%s' "$ARTISTS" | tr '\n\t' '||')
c=$(printf '%s' "$COVERS" | tr '\n\t' '||')
n=$(printf '%s' "$NAME" | tr '\n\t' '  ')
al=$(printf '%s' "$ALBUM" | tr '\n\t' '  ')
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$PLAYER_EVENT" "$URI" "$TRACK_ID" "$n" "$a" "$al" "$c" "$DURATION_MS" "$POSITION_MS" "$VOLUME" "$SHUFFLE$REPEAT" "$(date +%H:%M:%S)" >> {target}
"#);
        if std::fs::write(&hook, script).is_err() || std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).is_err() {
            push_log(g, "Couldn't set up player events.".into());
            return None;
        }
        files::write_privately(b"", &events);
        g.events_offset = 0;
        Some(hook.display().to_string())
    }

    /// Windows has no sh: player events come in phase 5 (Cadenza itself will act as the hook).
    #[cfg(not(unix))]
    fn prepare_event_hook(&self, _g: &mut Inner) -> Option<String> { None }

    fn read_events(&self) {
        let path = self.events_file();
        let Ok(mut f) = std::fs::File::open(&path) else { return };
        let size = f.metadata().map(|m| m.len()).unwrap_or(0);
        let mut guard = self.inner.lock().unwrap();
        let g = &mut *guard;
        if size < g.events_offset { g.events_offset = 0; }
        if size <= g.events_offset { return; }
        if f.seek(SeekFrom::Start(g.events_offset)).is_err() { return; }
        let mut buf = Vec::new();
        if f.read_to_end(&mut buf).is_err() { return; }
        // Only whole lines; a half-written one waits for the next look.
        let Some(end) = buf.iter().rposition(|b| *b == b'\n') else { return };
        g.events_offset += end as u64 + 1;
        let text = String::from_utf8_lossy(&buf[..end]).to_string();
        let mut changed = false;
        for line in text.lines() {
            let f: Vec<&str> = line.split('\t').collect();
            if f.len() < 11 { continue; }
            let (event, uri, track_id) = (f[0], f[1], f[2]);
            let ms = |s: &str| s.trim().parse::<i64>().ok();
            let p = &mut g.player;
            match event {
                "track_changed" => {
                    let covers: Vec<&str> = f[6].split('|').filter(|s| !s.is_empty()).collect();
                    // Spotify's 640 px album art has this marker in its URL; otherwise take the first.
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
                    changed = true;
                }
                "stopped" => {
                    let playing = p.get("is_playing").and_then(Value::as_bool).unwrap_or(false);
                    if let (Some(prog), true) = (p.get("progress_ms").and_then(Value::as_i64), playing && g.pos_at > 0.0) {
                        p.insert("progress_ms".into(), json!(prog + (now_ms() - g.pos_at) as i64));
                    }
                    g.pos_at = now_ms();
                    g.player.insert("active".into(), json!(false));
                    g.player.insert("is_playing".into(), json!(false));
                    changed = true;
                }
                "session_disconnected" => { p.insert("active".into(), json!(false)); changed = true; }
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
                }
                _ => {}
            }
        }
        if changed { self.emit_player(g); }
    }

    /// Tells the page what's playing, with the position as of right now.
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
    }

    // MARK: making sure Spotify sees Cadenza as a speaker

    /// Moves Spotify playback to this librespot (keeps the position).
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

    /// The page couldn't find Cadenza among Spotify's speakers: start librespot if it isn't running, or
    /// restart it if Spotify doesn't list it. True when it is (or should now be) listed.
    pub async fn check_device(self: &Arc<Self>) -> bool {
        if !self.settings.bool("manageLibrespot") || !self.has_credentials() || self.resolve_path().is_none() { return false; }
        let running = self.inner.lock().unwrap().child.is_some();
        if !running {
            self.note("librespot isn't running (the page couldn't find it): starting it.");
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
        self.note(format!("Spotify doesn't list {name} as a speaker: restarting librespot so it shows up again."));
        self.restart();
        let me = Arc::clone(self);
        tokio::task::spawn_blocking(move || { std::thread::sleep(Duration::from_millis(700)); me.wait_running(15.0) }).await.unwrap_or(false)
    }

    /// For "Copy diagnostics".
    pub fn diagnostics(&self) -> Vec<String> {
        let mut out = vec![];
        match self.resolve_path() {
            Some(p) => {
                let v = Command::new(&p).arg("--version").output().ok()
                    .map(|o| String::from_utf8_lossy(if o.stdout.is_empty() { &o.stderr } else { &o.stdout }).trim().to_string())
                    .unwrap_or_else(|| "?".into());
                out.push(format!("librespot: {v} ({})", files::tidy(&p)));
            }
            None => out.push("librespot: not found".into()),
        }
        let g = self.inner.lock().unwrap();
        let playing = g.player.get("is_playing").and_then(Value::as_bool).unwrap_or(false);
        out.push(format!("engine state: {}, playing here: {playing}, sound output: {}", g.state, self.sound.output_name()));
        out.push(String::new());
        out.push("== engine log ==".into());
        out.extend(g.log.iter().rev().take(80).rev().cloned());
        out
    }

    pub fn shutdown(&self) {
        let mut g = self.inner.lock().unwrap();
        if let Some(mut c) = g.child.take() { let _ = c.kill(); let _ = c.wait(); }
    }
}

fn push_log(g: &mut Inner, line: String) {
    log::info!("engine: {line}");
    g.log.push(line);
    if g.log.len() > 200 { let extra = g.log.len() - 200; g.log.drain(..extra); }
}

fn expand_tilde(p: &str) -> PathBuf {
    match (p.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(p),
    }
}

fn is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else { return false };
    if !meta.is_file() { return false; }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    { true }
}

fn restrict(_p: &Path, _mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(_p, std::fs::Permissions::from_mode(_mode));
    }
}

#[cfg(unix)]
fn user_tag() -> String {
    std::env::var("UID").or_else(|_| std::env::var("USER")).unwrap_or_else(|_| "user".into())
}

/// Older librespot versions quit on an option they don't know, so check its --help first (once per path).
fn supports(path: &Path, option: &str) -> bool {
    static HELP: OnceLock<Mutex<std::collections::HashMap<PathBuf, String>>> = OnceLock::new();
    let cache = HELP.get_or_init(Default::default);
    let mut c = cache.lock().unwrap();
    let text = c.entry(path.to_path_buf()).or_insert_with(|| {
        Command::new(path).arg("--help").output().ok()
            .map(|o| format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)))
            .unwrap_or_default()
    });
    text.contains(option)
}

/// librespot copies left behind by a crashed Cadenza would hold on to the device name and swallow the
/// music. Ours are recognised by their cache folder, so another app's librespot is left alone.
fn kill_strays(_cache: &Path) {
    #[cfg(unix)]
    {
        let escaped: String = _cache.display().to_string().chars()
            .map(|c| if ".[]()*+?{}|^$\\".contains(c) { format!("\\{c}") } else { c.to_string() }).collect();
        let _ = Command::new("pkill").args(["-f", &format!("librespot.*--cache {escaped}")]).status();
    }
}
