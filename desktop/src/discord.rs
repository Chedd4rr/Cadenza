//! "Listening to …" on your Discord profile, through the Discord app's local connection (Rich Presence).
//! No Discord login or token is involved: the Discord app running on this computer shows the status. It
//! needs a Discord application ID (free: discord.com/developers → New Application, name it "Cadenza").
//! The messages go over a local socket (macOS, Linux) or named pipe (Windows).

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::settings::Settings;

#[cfg(unix)]
type Conn = std::os::unix::net::UnixStream;
#[cfg(windows)]
type Conn = std::fs::File;

struct State {
    conn: Option<Conn>,
    connected_id: String,
    next_try: Instant,
    activity: Option<Value>,
    sent_key: String,
    sent_start: f64,
    status: String,
}

pub struct Discord {
    settings: Arc<Settings>,
    st: Mutex<State>,
}

impl Discord {
    pub fn new(settings: Arc<Settings>) -> Arc<Self> {
        let d = Arc::new(Discord {
            settings,
            st: Mutex::new(State { conn: None, connected_id: String::new(), next_try: Instant::now(), activity: None,
                                   sent_key: String::new(), sent_start: 0.0, status: "off".into() }),
        });
        // Every 20 s while it's on: reconnect if Discord was opened (or restarted) since.
        let me = d.clone();
        std::thread::Builder::new().name("cadenza-discord".into()).spawn(move || loop {
            std::thread::sleep(Duration::from_secs(20));
            if me.enabled() { me.resend(false); }
        }).ok();
        d
    }

    fn enabled(&self) -> bool { self.settings.bool("discord") }
    /// Your own application ID if you set one, otherwise Cadenza's built-in one.
    fn app_id(&self) -> String {
        let own = self.settings.string("discordAppId");
        if own.is_empty() { crate::builtin::DISCORD_APP_ID.to_string() } else { own }
    }

    /// For System: "connected", "waiting for Discord", "needs an application ID"…
    pub fn status(&self) -> Value {
        let status = if self.enabled() { self.st.lock().unwrap().status.clone() } else { "off".into() };
        json!({"enabled": self.enabled(), "status": status, "hasId": !self.app_id().is_empty()})
    }

    /// The setting was switched, or the application ID changed: start over.
    pub fn restart(&self) {
        {
            let mut s = self.st.lock().unwrap();
            s.conn = None;
            s.connected_id.clear();
            s.next_try = Instant::now();
            s.status = "off".into();
        }
        if self.enabled() { self.resend(true); }
    }

    /// Called whenever the song or play state changes (the page's now-playing info).
    pub fn update(&self, np: &Value) {
        let title = np.get("title").and_then(Value::as_str).unwrap_or("");
        let playing = np.get("playing").and_then(Value::as_bool).unwrap_or(false);
        if title.is_empty() || !playing {
            self.st.lock().unwrap().activity = None;
            return self.resend(false);
        }
        let artist = np.get("artist").and_then(Value::as_str).unwrap_or("");
        let album = np.get("album").and_then(Value::as_str).unwrap_or("");
        let duration = np.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
        let position = np.get("position").and_then(Value::as_f64).unwrap_or(0.0);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
        let start = now - position;
        let mut a = json!({
            "type": 2,                                          // "Listening to"
            "details": fit(title),
            "state": fit(&format!("by {artist}")),
            "timestamps": {"start": start as i64, "end": (start + duration.max(1000.0)) as i64},
        });
        let mut assets = serde_json::Map::new();
        if let Some(art) = np.get("art").and_then(Value::as_str).filter(|a| a.starts_with("https://")) { assets.insert("large_image".into(), json!(art)); }
        if !album.is_empty() { assets.insert("large_text".into(), json!(fit(album))); }
        if !assets.is_empty() { a["assets"] = Value::Object(assets); }
        if let Some(uri) = np.get("uri").and_then(Value::as_str) {
            let p: Vec<&str> = uri.split(':').collect();
            if p.len() == 3 && (p[1] == "track" || p[1] == "episode") {
                a["buttons"] = json!([{"label": "Open in Spotify", "url": format!("https://open.spotify.com/{}/{}", p[1], p[2])}]);
            }
        }
        let key = format!("{title}|{artist}");
        let send = {
            let mut s = self.st.lock().unwrap();
            s.activity = Some(a);
            // Same song, still on time: nothing to send. A seek moves the start time, so resend then.
            let moved = (start - s.sent_start).abs() > 4000.0;
            if key != s.sent_key || moved { s.sent_key = key; s.sent_start = start; true } else { false }
        };
        if send { self.resend(true); }
    }

    fn resend(&self, force: bool) {
        if !self.enabled() { return; }
        let id = self.app_id();
        let mut s = self.st.lock().unwrap();
        if id.is_empty() { s.status = "needs an application ID".into(); return; }
        if s.conn.is_none() || s.connected_id != id {
            s.conn = None;
            if Instant::now() < s.next_try { return; }
            match connect(&id) {
                Ok(c) => { s.conn = Some(c); s.connected_id = id; s.status = "connected".into(); s.sent_key.clear(); }
                Err(e) => { s.status = e; s.next_try = Instant::now() + Duration::from_secs(15); return; }
            }
        } else if !force { return; }
        let mut args = json!({"pid": std::process::id()});
        if let Some(a) = &s.activity { args["activity"] = a.clone(); }
        let msg = json!({"cmd": "SET_ACTIVITY", "args": args, "nonce": format!("{:016x}", rand::random::<u64>())});
        let reply = s.conn.as_mut().and_then(|c| if send(c, 1, &msg) { read(c) } else { None });
        match reply {
            Some((1, j)) if j.get("evt").and_then(Value::as_str) == Some("ERROR") => {
                s.status = format!("Discord said: {}", j.pointer("/data/message").and_then(Value::as_str).unwrap_or("rejected"));
            }
            Some((1, _)) => s.status = "connected".into(),
            _ => { s.conn = None; s.connected_id.clear(); s.status = "waiting for Discord".into(); }
        }
    }
}

/// Discord wants 2 to 128 characters.
fn fit(s: &str) -> String {
    let mut t = s.trim().to_string();
    if t.chars().count() < 2 { t.push_str("  "); }
    if t.chars().count() > 128 { t = t.chars().take(127).collect::<String>() + "…"; }
    t
}

/// The Discord app's local connection: a socket named discord-ipc-0…9 in the temporary folders (macOS,
/// Linux, including Flatpak and Snap Discord), or a named pipe (Windows).
fn connect(id: &str) -> Result<Conn, String> {
    for mut c in candidates() {
        if !send(&mut c, 0, &json!({"v": 1, "client_id": id})) { continue; }
        match read(&mut c) {
            Some((2, j)) => return Err(format!("Discord said: {}", j.get("message").and_then(Value::as_str).unwrap_or("invalid application ID"))),
            Some(_) => return Ok(c),
            None => continue,
        }
    }
    Err("waiting for Discord (is the Discord app open?)".into())
}

#[cfg(unix)]
fn candidates() -> Vec<Conn> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    let mut dirs: Vec<std::path::PathBuf> = vec![];
    for var in ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"] {
        if let Some(v) = std::env::var_os(var) { dirs.push(v.into()); }
    }
    if let Some(run) = std::env::var_os("XDG_RUNTIME_DIR").map(std::path::PathBuf::from) {
        dirs.push(run.join("app/com.discordapp.Discord"));     // Flatpak
        dirs.push(run.join("snap.discord"));                   // Snap
    }
    dirs.push(std::env::temp_dir());
    dirs.push("/tmp".into());
    // SAFETY: getuid has no preconditions and can't fail.
    let me = unsafe { libc::getuid() };
    let mut out = vec![];
    for dir in dirs {
        for i in 0..10 {
            let path = dir.join(format!("discord-ipc-{i}"));
            // Only a socket that belongs to you: /tmp is shared, and another account could leave a fake
            // "discord-ipc-0" there to read what you're playing.
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
            if !meta.file_type().is_socket() || meta.uid() != me { continue; }
            if let Ok(c) = Conn::connect(&path) {
                let _ = c.set_read_timeout(Some(Duration::from_secs(2)));
                let _ = c.set_write_timeout(Some(Duration::from_secs(2)));
                out.push(c);
            }
        }
    }
    out
}

#[cfg(windows)]
fn candidates() -> Vec<Conn> {
    (0..10).filter_map(|i| std::fs::OpenOptions::new().read(true).write(true).open(format!(r"\\.\pipe\discord-ipc-{i}")).ok()).collect()
}

/// One message: a 4-byte opcode, a 4-byte length (little-endian), then JSON.
fn send(c: &mut Conn, op: u32, obj: &Value) -> bool {
    let body = obj.to_string().into_bytes();
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend_from_slice(&op.to_le_bytes());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    c.write_all(&frame).is_ok()
}

fn read(c: &mut Conn) -> Option<(u32, Value)> {
    let mut head = [0u8; 8];
    c.read_exact(&mut head).ok()?;
    let op = u32::from_le_bytes([head[0], head[1], head[2], head[3]]);
    let len = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize;
    if len >= 1 << 20 { return None; }
    let mut body = vec![0u8; len];
    c.read_exact(&mut body).ok()?;
    Some((op, serde_json::from_slice(&body).unwrap_or(Value::Null)))
}
