//! Runs librespot (the Spotify Connect engine), reads what it's playing, and hands its sound to Cadenza's
//! output. Normally librespot runs inside Cadenza (the built-in engine, see embedded.rs); the old way, as a
//! separate program with an --onevent hook, is still here to switch back to (System → Engine settings).
//! Both report the same events and messages, read here the same way. A port of Librespot.swift, including
//! its recovery: songs Spotify won't unlock, songs worth one more try, dropped connections, sound that
//! stops arriving, and checking Spotify still lists Cadenza after the computer wakes up.

use regex::Regex;
use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::api::Api;
use crate::files;
use crate::history::History;
use crate::settings::Settings;
use crate::sound::Sound;

pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    /// The built-in engine, when that's the one running (instead of `child`).
    embedded: Option<Arc<crate::embedded::Engine>>,
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
    // Recovery bookkeeping (see the "recovery" part below).
    refusals: std::collections::HashMap<String, Instant>,
    last_song_refusal: Option<Instant>,
    last_key_failure: Option<Instant>,
    loading_uri: String,
    retried: std::collections::HashMap<String, Instant>,
    pending_retry: Option<String>,
    last_drop: Option<Instant>,
    last_device_fix: Option<Instant>,
    last_rescue: Option<Instant>,
    last_stop_at: Option<Instant>,
    // Playing directly in the built-in engine (see "playing directly" below).
    skip_last: Option<Instant>,
    skip_pending: u32,
    skip_flushing: bool,
    /// Songs Spotify wouldn't play in a row, and when the last one was (for how long to wait).
    hold_streak: u32,
    last_hold: Option<Instant>,
    /// Bumped by anything you do, so a wait after a refused song doesn't then skip over your choice.
    hold_token: u64,
    flowing_ticks: u32,
    stall_since: Option<Instant>,
    device_check_at: Option<(Instant, String)>,
}

fn within(t: Option<Instant>, secs: u64) -> bool { t.map_or(false, |t| t.elapsed() < Duration::from_secs(secs)) }

/// Things noticed while holding the lock, done once it's let go.
enum Then {
    CheckSound, Retry(String), RetryLater(String), Dropped(String, bool), Refused(String), Held(String),
    // The sound engine: a new song (its length), a position report (ms, length), a jump, and letting go of
    // sound Cadenza is holding when Spotify says it's playing.
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
        // Every 2 s: follow the sound, rescue a stalled engine, notice the computer waking up.
        let keeper = Arc::clone(&me);
        std::thread::Builder::new().name("cadenza-engine-keeper".into()).spawn(move || {
            let mut last = SystemTime::now();
            loop {
                std::thread::sleep(Duration::from_secs(2));
                // The wall clock jumping far ahead of the 2 s just slept means the computer was asleep.
                let gap = SystemTime::now().duration_since(last).unwrap_or_default();
                last = SystemTime::now();
                if gap > Duration::from_secs(20) { keeper.schedule_device_check(8, "the computer woke up"); }
                keeper.follow_the_sound();
                keeper.watch_sound();
                keeper.run_device_check();
            }
        }).ok();
        // Closing the lid pauses the music, like taking headphones off, so it doesn't come back on by itself
        // when the computer wakes. (The Swift app pauses as the Mac goes to sleep; here it's noticed as it
        // wakes, within half a second, by the wall clock jumping ahead.)
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
                    let api = sleeper.api.clone();
                    tauri::async_runtime::spawn(async move { api.request("PUT", "/me/player/pause", None).await; });
                }
            }
        }).ok();
        // Start from an empty events file: what's in it is from the last time Cadenza ran, and reading it
        // would replay those songs as if they were playing now.
        files::write_privately(b"", &me.events_file());
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

    /// The built-in engine is the normal one; "program" in settings brings back the separate program.
    pub fn uses_builtin(&self) -> bool { self.settings.string("engine") != "program" }

    pub fn start(self: &Arc<Self>) {
        let mut g = self.inner.lock().unwrap();
        if Self::running(&g) { return; }
        if self.uses_builtin() { return self.start_builtin(&mut g); }
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

    fn start_builtin(self: &Arc<Self>, g: &mut Inner) {
        let cache = self.cache_dir();
        let _ = std::fs::create_dir_all(&cache);
        kill_strays(&cache);                                    // a separate program left from before
        g.generation += 1;
        let generation = g.generation;
        let pipe = crate::sound::MemPipe::new();
        self.sound.attach_memory(pipe.clone());
        let (m, e, x) = (Arc::clone(self), Arc::clone(self), Arc::clone(self));
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
        g.opened_auth = true;                                   // (the built-in engine opens the sign-in page itself)
        push_log(g, format!("Started the built-in engine (librespot {}) as \"{}\", {} kbps.", LIBRESPOT_VERSION, self.settings.device_name(), self.settings.bitrate()));
        let s = if self.has_credentials() { "starting" } else { "login" };
        self.set_state(g, s);
    }

    /// The built-in engine stopped: on purpose (nothing to do) or not (handled like the program crashing).
    fn builtin_ended(self: &Arc<Self>, generation: u64, why: String) {
        let mut g = self.inner.lock().unwrap();
        if g.generation != generation || g.embedded.is_none() { return; }      // stopped or replaced on purpose
        g.embedded = None;
        if !why.is_empty() { push_log(&mut g, format!("The built-in engine stopped: {why}")); }
        self.after_exit(g);
    }

    fn running(g: &Inner) -> bool { g.child.is_some() || g.embedded.is_some() }

    /// Stops whichever engine is running.
    fn kill(g: &mut Inner) {
        if let Some(mut c) = g.child.take() { let _ = c.kill(); let _ = c.wait(); }
        if let Some(e) = g.embedded.take() { e.stop(); }
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
        static LOADING: OnceLock<Regex> = OnceLock::new();
        let auth = AUTH.get_or_init(|| Regex::new(r#"https://accounts\.spotify\.com/authorize[^\s"'<>]*"#).unwrap());
        let loading = LOADING.get_or_init(|| Regex::new(r"with Spotify URI <(spotify:track:[A-Za-z0-9]+)>").unwrap());
        let mut then: Vec<Then> = vec![];
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
        // A key timeout is a hiccup: worth trying the song again. A refusal ("Unable to load key", once the
        // bundled librespot has given up retrying) means Spotify won't unlock that one song right now.
        if text.contains("audio key response timeout") { g.last_key_failure = Some(Instant::now()); }
        if let Some(c) = loading.captures(text) { g.loading_uri = c[1].to_string(); }
        if text.contains("Unable to load key") { let u = g.loading_uri.clone(); then.push(Then::Refused(u)); }
        // The built-in engine paused on a song it couldn't play, instead of skipping on (Cadenza's patch).
        if let Some(i) = text.find("Holding: the current track is unavailable <") {
            let uri = text[i..].split('<').nth(1).unwrap_or("").trim_end_matches('>').to_string();
            then.push(Then::Held(uri));
        }
        // Spotify closed librespot's connection. librespot only notices about 30 s later and comes back
        // without your playlist, so don't wait for it.
        if text.contains("Connection to server closed") || text.contains("Spirc shut down unexpectedly") {
            let active = g.player.get("active").and_then(Value::as_bool).unwrap_or(false);
            then.push(Then::Dropped("Spotify closed the connection".into(), active));
        }
        drop(g);
        self.run(then);
    }

    /// The process ended. If Cadenza didn't stop it, it fell over: start it again after a pause that grows
    /// with each crash (1 s, 3 s, 10 s, 30 s, then once a minute), unless the login itself is bad.
    fn exited(self: &Arc<Self>, generation: u64) {
        let mut g = self.inner.lock().unwrap();
        if g.generation != generation || g.child.is_none() { return; }      // stopped or replaced on purpose
        let status = g.child.take().and_then(|mut c| c.wait().ok());
        let code = status.and_then(|s| s.code()).map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
        push_log(&mut g, format!("librespot exited ({code})"));
        self.after_exit(g);
    }

    /// The engine stopped by itself: start it again after a pause that grows with each crash, unless the
    /// login itself is bad.
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

    /// Restart engine (System → Engine settings, or the palette): if music was playing here, pick it back up
    /// at the same song and second afterwards, as an automatic restart does.
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
        // (Test mode has its own, or the two apps would keep rewriting each other's.)
        let name = if files::test_mode() { "cadenza-test-librespot-event.sh" } else { "cadenza-librespot-event.sh" };
        // The script is run as you, so it must be somewhere nobody else can write: a shared /tmp would let
        // another account on the computer swap in its own script. See private_hook_dir.
        let Some(dir) = private_hook_dir() else {
            push_log(g, "Couldn't set up player events: no private folder without spaces in its name.".into());
            return None;
        };
        let hook = dir.join(name);
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
        // Written to a new file and renamed into place, so nothing already at that name is ever followed.
        let tmp = dir.join(format!(".{name}.{}", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let written = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)
            .and_then(|mut f| { use std::io::Write; f.write_all(script.as_bytes()) })
            .and_then(|_| std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o700)))
            .and_then(|_| std::fs::rename(&tmp, &hook));
        if written.is_err() {
            let _ = std::fs::remove_file(&tmp);
            push_log(g, "Couldn't set up player events.".into());
            return None;
        }
        files::write_privately(b"", &events);
        g.events_offset = 0;
        Some(hook.display().to_string())
    }

    /// Windows has no sh, so Cadenza itself is the hook: librespot runs "Cadenza.exe --librespot-event"
    /// and the copy that starts that way writes one line and quits (see run_event_hook).
    #[cfg(windows)]
    fn prepare_event_hook(&self, g: &mut Inner) -> Option<String> {
        let Some(exe) = hook_program() else {
            push_log(g, "Couldn't set up player events: Cadenza's folder has a space in its name.".into());
            return None;
        };
        files::write_privately(b"", &self.events_file());
        g.events_offset = 0;
        Some(format!("{} {EVENT_ARG}", exe.display()))
    }

    #[cfg(not(any(unix, windows)))]
    fn prepare_event_hook(&self, _g: &mut Inner) -> Option<String> { None }

    fn read_events(self: &Arc<Self>) {
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
        drop(guard);
        self.handle_events(&text);
    }

    /// Player events, one per line (from the program's event script, or the built-in engine).
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
                    // A song that failed to load was to be tried again after this one: if librespot moved on
                    // past it, go back for it.
                    if let Some(failed) = g.pending_retry.take() {
                        let now = if uri.is_empty() { format!("spotify:track:{track_id}") } else { uri.to_string() };
                        if now != failed { then.push(Then::Retry(failed)); }
                    }
                    let p = &mut g.player;
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
                    // Spotify says it's playing but Cadenza is still holding the sound (a "playing" report
                    // that came late or out of order): let it go, or librespot stalls behind it.
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
                    g.player.insert("active".into(), json!(false));
                    g.player.insert("is_playing".into(), json!(false));
                    g.last_stop_at = Some(Instant::now());
                    changed = true;
                }
                "session_disconnected" => {
                    // The session dropped, or another device took over. The play state is left to librespot's
                    // own "paused"/"stopped" reports.
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
                    // Usually the next song failing to preload while this one plays on; librespot skips it
                    // by itself either way.
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
        self.history.observe(&g.player);
        // An interrupted sleep fade mustn't leave the volume down.
        if !self.sound.sleep_fading() && self.sound.transition_volume() < 0.999 { self.sound.reset_transition(); }
    }

    /// Spotify is playing here, but Cadenza is holding the sound. librespot can only write as fast as
    /// Cadenza takes the sound, so it would sit stuck and the music would "hang". Unless you paused in the
    /// last few seconds (Spotify's "paused" just hasn't arrived yet), play.
    fn release_if_held(&self) {
        if !self.sound.holding() { return; }
        if self.sound.locally_paused_at().map_or(false, |t| t.elapsed() < Duration::from_secs(4)) { return; }
        self.note("Spotify is playing but Cadenza's player was still paused: letting the sound through.");
        self.sound.local_resume();
    }

    /// Where the engine is right now, for picking up there next time (saved when Cadenza quits).
    pub fn snapshot(&self) -> Option<Value> { Self::position_snapshot(&self.inner.lock().unwrap()) }

    /// Whether librespot here is the device Spotify is playing on (for the instant controls).
    pub fn is_active_here(&self) -> bool { Self::active_here(&self.inner.lock().unwrap()) }
    pub fn is_playing_here(&self) -> bool { Self::playing_here(&self.inner.lock().unwrap()) }

    /// You paused in Cadenza: the sound stopped at once and Spotify was asked to pause. A few seconds later,
    /// check Spotify really did. If not, ask once more; if it still plays, follow Spotify, so librespot isn't
    /// left stuck behind a paused player.
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
                    // Spotify did pause; its report to librespot just never arrived.
                    if status == 200 || status == 204 {
                        let mut g = me.inner.lock().unwrap();
                        g.player.insert("is_playing".into(), json!(false));
                        me.emit_player(&mut g);
                    }
                    return;
                }
                if attempt == 0 {
                    me.note("Spotify didn't pause: asking again.");
                    me.api.request("PUT", "/me/player/pause", None).await;
                } else {
                    me.note("Spotify kept playing after being asked to pause: playing here too so nothing gets stuck.");
                    me.sound.local_resume();
                }
            }
        });
    }

    // MARK: playing directly

    /// Does something with the music straight in the built-in engine, instead of through Spotify's web
    /// interface. {"ok": false} means the page should use the web interface instead: the separate program
    /// is the engine, it isn't connected yet, the request is for another device, or (for anything but
    /// starting something new) another device is the one playing.
    pub fn direct(self: &Arc<Self>, action: &str, a: &Value) -> Value {
        use crate::embedded::Direct;
        let no = |why: &str| json!({"ok": false, "reason": why});
        let (engine, active) = {
            let mut g = self.inner.lock().unwrap();
            let Some(e) = g.embedded.clone() else { return no("not the built-in engine") };
            if g.state != "running" { return no("the engine isn't connected yet"); }
            if let Some(dev) = a.get("device_id").and_then(Value::as_str) {
                if dev != crate::embedded::device_id(&self.settings.device_name()) { return no("another device"); }
            }
            g.hold_token += 1;                                  // you chose something: a waiting skip is off
            (e, Self::active_here(&g))
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
            },
            _ if !active => return no("another device is playing"),
            "play" => Direct::Play,
            "pause" => Direct::Pause,
            "next" => return self.direct_next(engine),
            "previous" => Direct::Previous,
            "seek" => Direct::Seek(n("position").unwrap_or(0) as u32),
            "volume" => Direct::Volume(n("volume").unwrap_or(70) as u32),
            "shuffle" => Direct::Shuffle(a.get("state").and_then(Value::as_bool).unwrap_or(false)),
            "repeat" => Direct::Repeat(s("state").unwrap_or_else(|| "off".into())),
            "queue" => match s("uri") { Some(u) => Direct::Queue(u), None => return no("no song") },
            _ => return no("unknown"),
        };
        match engine.direct(d) {
            Ok(()) => json!({"ok": true}),
            Err(e) => { self.note(format!("The built-in engine couldn't do that ({action}): {e}")); no(&e) }
        }
    }

    /// Next. A single press skips at once. Presses that follow quickly are gathered and done together once
    /// they stop (one jump that many songs ahead), so skipping through ten songs fast loads two songs, not ten:
    /// each song loaded asks Spotify for its key, and asked too often, Spotify starts refusing.
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

    /// The built-in engine paused on a song it couldn't play (see the hold-refused patch). If Spotify refused
    /// its key, wait before the next one, longer each time it happens again soon (1.5 s, 3 s, 6 s, 12 s, 20 s,
    /// 30 s), so asking again doesn't just get refused again. Otherwise (the song isn't available, say) move
    /// on almost at once. A song that only failed because its key was slow gets another try instead (see
    /// retry_later).
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
        push_log(&mut g, format!("Spotify won't play {uri}{}: moving on in {:.1} s.", if refused { " right now" } else { "" }, wait as f64 / 1000.0));
        drop(g);
        if refused { (self.emit)("engine.held", json!({"uri": uri, "wait_ms": wait})); }
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(wait));
            if me.inner.lock().unwrap().hold_token != token { return; }   // you picked something meanwhile
            let _ = engine.direct(crate::embedded::Direct::Next(1));
            let _ = engine.direct(crate::embedded::Direct::Play);
        });
    }

    // MARK: recovery

    fn run(self: &Arc<Self>, then: Vec<Then>) {
        for t in then {
            match t {
                Then::CheckSound => self.check_sound(),
                Then::NewSong(dur) => {
                    // A new song starts at full volume (in case the sleep fade was cut short).
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
    /// librespot is busy skipping songs Spotify won't unlock: silence is expected, don't restart anything.
    fn refused_recently(g: &Inner) -> bool { within(g.last_song_refusal, 15) }

    /// Spotify sometimes refuses to unlock a song ("error audio key 0 2"). It's per song and temporary:
    /// librespot skips it and the next one usually plays. Log it, tell autoplay to leave it out a while, carry on.
    fn key_refused(&self, uri: String) {
        let mut g = self.inner.lock().unwrap();
        g.last_song_refusal = Some(Instant::now());
        g.refusals.retain(|_, t| t.elapsed() < Duration::from_secs(600));
        if uri.is_empty() { return; }
        // Logged once per song, but the page hears about every refusal: it counts them to stop a chain of
        // them, and a chain often goes back through songs that were refused a few minutes earlier.
        if g.refusals.insert(uri.clone(), Instant::now()).is_none() {
            push_log(&mut g, format!("Spotify won't unlock {uri} right now; librespot skips it and the next song plays."));
        }
        drop(g);
        (self.emit)("engine.refused", json!({"uri": uri}));
    }

    /// A song that didn't load only because Spotify was slow to send its key (often just before a dropped
    /// connection) gets one more try. A song that's really unavailable fails again and is skipped for good.
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
            // Usually it's the next song, failing while it got ready: let this one finish, then go back for it.
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

    /// Where the engine is right now ({uri, position_ms, duration_ms, at}), or None if nothing's here.
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

    /// Spotify dropped the engine's connection while music was playing here: restart librespot straight
    /// away and hand the page what was playing and where, so it starts the same playlist (or DJ set, radio,
    /// true shuffle) at the same song and second. Not playing here: librespot reconnects by itself, and a
    /// check makes sure Spotify still lists Cadenza.
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
        g.player.insert("is_playing".into(), json!(false));     // the new librespot says "playing" once it really is
        self.emit_player(&mut g);
        drop(g);
        self.restart_then_resume(Some(snapshot), 15.0);
    }

    /// Restart librespot and pick the music back up: the page resumes from `spot` if given (it knows the
    /// playlist), otherwise playback is handed back to Cadenza as it was.
    fn restart_then_resume(self: &Arc<Self>, spot: Option<Value>, timeout: f64) {
        self.restart();
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(700));
            if !me.wait_running(timeout) { return; }
            std::thread::sleep(Duration::from_millis(1200));     // a moment for Spotify to list the new librespot
            match &spot {
                Some(s) if s.get("uri").is_some() => (me.emit)("engine.resume", s.clone()),
                _ => { let m = Arc::clone(&me); tauri::async_runtime::spawn(async move { m.transfer_here(true, 10).await; }); }
            }
            // If nothing is playing a little later (the page couldn't), fall back to a plain hand-over.
            std::thread::sleep(Duration::from_secs(10));
            if !Self::playing_here(&me.inner.lock().unwrap()) {
                me.note("Still nothing playing after the restart: handing the music back to Cadenza.");
                let m = Arc::clone(&me);
                tauri::async_runtime::spawn(async move { m.transfer_here(true, 10).await; });
            }
        });
    }

    /// A few seconds after playback starts here, check the sound is really coming through. If librespot
    /// says it's playing but no sound has reached Cadenza, restart it (at most once a minute).
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

    /// Every 2 s while music plays here: no sound for 9 s means the engine has stalled (the output itself
    /// is reopened by the sound watchdog). Only if Spotify agrees it's playing here, restart librespot and
    /// pick the song back up; otherwise a missed "paused" report would un-pause the music by itself.
    fn watch_sound(self: &Arc<Self>) {
        let mut g = self.inner.lock().unwrap();
        // You just paused: Cadenza stops the sound itself before Spotify confirms, so silence is expected.
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

    /// The sound is the best evidence: librespot only sends it while playing. If sound has kept arriving
    /// for a few seconds but librespot's last report said paused or stopped (reports can be missed around a
    /// song change), show it as playing instead of leaving the page thinking the song stopped early.
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

    /// After the computer wakes up, or the connection drops while nothing plays here, librespot's link to
    /// Spotify is often dead although it still runs. A little later, check Spotify still lists Cadenza.
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
    pub async fn check_device(self: &Arc<Self>) -> bool { self.check_device_because("the page couldn't find it").await }

    async fn check_device_because(self: &Arc<Self>, reason: &str) -> bool {
        if !self.settings.bool("manageLibrespot") || !self.has_credentials() || self.resolve_path().is_none() { return false; }
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
        if self.uses_builtin() { out.push(format!("librespot: built in, version {LIBRESPOT_VERSION}")); }
        else { match self.resolve_path() {
            Some(p) => {
                let v = Command::new(&p).arg("--version").output().ok()
                    .map(|o| String::from_utf8_lossy(if o.stdout.is_empty() { &o.stderr } else { &o.stdout }).trim().to_string())
                    .unwrap_or_else(|| "?".into());
                out.push(format!("librespot: {v} ({})", files::tidy(&p)));
            }
            None => out.push("librespot: not found".into()),
        } }
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

/// The librespot built into Cadenza (librespot.sh's pinned commit, set by build.rs).
const LIBRESPOT_VERSION: &str = match option_env!("CADENZA_LIBRESPOT_VERSION") { Some(v) => v, None => "0.8.0" };

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

/// A folder only you can write to, with no spaces in its path (librespot splits --onevent on spaces):
/// the per-user runtime folder on Linux, macOS's per-user temporary folder, Cadenza's own data folder, or
/// a cadenza-<your id> folder in /tmp that Cadenza made and only you can open.
#[cfg(unix)]
fn private_hook_dir() -> Option<PathBuf> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    // SAFETY: getuid has no preconditions and can't fail.
    let me = unsafe { libc::getuid() };
    let spaced = |p: &Path| p.display().to_string().contains(char::is_whitespace);
    // Yours, a real folder (not a link), and nobody else can write in it.
    let private = |p: &Path| std::fs::symlink_metadata(p).map(|m| m.is_dir() && m.uid() == me && m.mode() & 0o022 == 0).unwrap_or(false);
    let mut candidates: Vec<PathBuf> = vec![];
    if let Some(run) = std::env::var_os("XDG_RUNTIME_DIR") { candidates.push(run.into()); }
    if cfg!(target_os = "macos") { candidates.push(std::env::temp_dir()); }   // /var/folders/…/T, per user
    candidates.push(files::support_dir().to_path_buf());
    if let Some(dir) = candidates.into_iter().find(|d| !spaced(d) && private(d)) { return Some(dir); }
    let own = PathBuf::from(format!("/tmp/cadenza-{me}"));
    if std::fs::create_dir(&own).is_ok() { let _ = std::fs::set_permissions(&own, std::fs::Permissions::from_mode(0o700)); }
    private(&own).then_some(own)
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

// MARK: the Windows event hook

/// The argument that makes Cadenza.exe act as librespot's event hook instead of opening the app.
pub const EVENT_ARG: &str = "--librespot-event";

/// If Cadenza was started as librespot's event hook, writes the event to the events file and returns
/// true, and the caller quits straight away. librespot passes the event in environment variables. The
/// line is the same as the one the sh script writes on Mac and Linux. (Test mode reaches the right file
/// because librespot passes on Cadenza's environment, CADENZA_TEST included.)
pub fn run_event_hook() -> bool {
    if std::env::args().nth(1).as_deref() != Some(EVENT_ARG) { return false; }
    use std::io::Write;
    let var = |k: &str| std::env::var(k).unwrap_or_default();
    // Tabs and line breaks would break the line apart: lists get | between items, text gets spaces.
    let list = |k: &str| var(k).replace(['\n', '\r', '\t'], "|");
    let text = |k: &str| var(k).replace(['\n', '\r', '\t'], " ");
    let line = format!("{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}{}\t{}\n",
        text("PLAYER_EVENT"), text("URI"), text("TRACK_ID"), text("NAME"), list("ARTISTS"), text("ALBUM"),
        list("COVERS"), text("DURATION_MS"), text("POSITION_MS"), text("VOLUME"), text("SHUFFLE"), text("REPEAT"),
        chrono::Local::now().format("%H:%M:%S"));
    let path = files::path("librespot-events.txt");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());       // one write, so lines from two events can't mix
    }
    true
}

/// Where librespot can run Cadenza from. librespot splits the --onevent setting on spaces, and Cadenza
/// is usually installed under the user's folder (C:\Users\Jane Doe\...), so: the real path if it has no
/// spaces, else its short 8.3 form, else a copy in C:\ProgramData\Cadenza.
#[cfg(windows)]
fn hook_program() -> Option<PathBuf> {
    let spaced = |p: &Path| p.display().to_string().contains(char::is_whitespace);
    let exe = std::env::current_exe().ok()?;
    if !spaced(&exe) { return Some(exe); }
    if let Some(short) = short_path(&exe).filter(|p| !spaced(p)) { return Some(short); }
    // C:\ProgramData is shared by every account on the PC, and a folder someone else made there is theirs to
    // change. So the copy goes in a folder with a name nobody can guess, made by Cadenza itself (which makes
    // it yours) and remembered in Cadenza's private data folder for next time.
    let base = PathBuf::from(std::env::var_os("ProgramData")?);
    let base = if spaced(&base) { short_path(&base).filter(|p| !spaced(p))? } else { base };
    let remembered = files::path("event-hook-folder.txt");
    let mut dir = std::fs::read_to_string(&remembered).ok().map(|s| PathBuf::from(s.trim())).filter(|d| d.starts_with(&base) && d.is_dir());
    if dir.is_none() {
        use rand::Rng;
        let name: String = rand::thread_rng().sample_iter(&rand::distributions::Alphanumeric).take(20).map(char::from).collect();
        let fresh = base.join(format!("cadenza-{}", name.to_lowercase()));
        std::fs::create_dir(&fresh).ok()?;                   // fails if it already exists: then it isn't ours
        files::write_privately(fresh.display().to_string().as_bytes(), &remembered);
        dir = Some(fresh);
    }
    let copy = dir?.join("cadenza-event.exe");
    // If the copy is in use (the other Cadenza's librespot is running it), the one there is ours and still works.
    if std::fs::copy(&exe, &copy).is_err() && !copy.exists() { return None; }
    Some(copy)
}

/// The short (8.3) form of a path, which never has spaces, if the drive keeps short names.
#[cfg(windows)]
fn short_path(p: &Path) -> Option<PathBuf> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    #[link(name = "kernel32")]
    extern "system" { fn GetShortPathNameW(long: *const u16, short: *mut u16, size: u32) -> u32; }
    let wide: Vec<u16> = p.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut buf = vec![0u16; 1024];
    // SAFETY: both buffers are valid for the lengths given; the call writes at most `size` units.
    let n = unsafe { GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if n == 0 || n >= buf.len() { return None; }
    Some(PathBuf::from(std::ffi::OsString::from_wide(&buf[..n])))
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
    // Windows doesn't end librespot when Cadenza crashes, so this matters more there. The folder goes in
    // through an environment variable so nothing in it is read as PowerShell.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let script = "$c = $env:CADENZA_STRAYS; Get-CimInstance Win32_Process -Filter \"Name = 'librespot.exe'\" | \
            Where-Object { $_.CommandLine -and $_.CommandLine.Contains($c) } | \
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
        let _ = Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("CADENZA_STRAYS", _cache).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .creation_flags(0x0800_0000).status();
    }
}
