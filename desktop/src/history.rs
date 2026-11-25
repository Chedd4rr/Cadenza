
use serde_json::{json, Map, Value};
use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::files;

#[derive(Default)]
struct Current {
    uri: String,
    meta: Map<String, Value>,
    started_at_ms: u64,
    heard: Duration,
    playing_since: Option<Instant>,
}

#[derive(Default)]
pub struct History {
    cur: Mutex<Current>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl History {
    /// Called with librespot's player state every time it changes.
    pub fn observe(&self, p: &Map<String, Value>) {
        let mut c = self.cur.lock().unwrap();
        let new_uri = p.get("uri").and_then(Value::as_str).unwrap_or("").to_string();
        let playing = p.get("is_playing").and_then(Value::as_bool) == Some(true) && p.get("active").and_then(Value::as_bool) != Some(false);
        if let Some(since) = c.playing_since.take() { c.heard += since.elapsed(); }
        if new_uri != c.uri {
            finish_locked(&mut c);
            c.uri = new_uri;
            c.meta.clear();
            c.heard = Duration::ZERO;
            c.started_at_ms = now_ms();
        }
        for key in ["name", "artists", "album", "image", "duration_ms"] {
            if let Some(v) = p.get(key) { c.meta.insert(key.into(), v.clone()); }
        }
        c.playing_since = if playing { Some(Instant::now()) } else { None };
    }

    /// Cadenza is quitting: log the current song if it counts.
    pub fn finish(&self) {
        let mut c = self.cur.lock().unwrap();
        finish_locked(&mut c);
    }
}

fn finish_locked(c: &mut Current) {
    if let Some(since) = c.playing_since { c.heard += since.elapsed(); c.playing_since = Some(Instant::now()); }
    let heard = std::mem::take(&mut c.heard).as_secs_f64();
    let name = c.meta.get("name").and_then(Value::as_str).unwrap_or("");
    if !c.uri.starts_with("spotify:track:") || name.is_empty() { return; }
    let duration = c.meta.get("duration_ms").and_then(Value::as_f64).unwrap_or(0.0) / 1000.0;
    if !(heard >= 30.0 || (duration > 0.0 && heard >= duration / 2.0)) { return; }
    let s = |k: &str| c.meta.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let entry = json!({
        "uri": c.uri, "name": name, "artists": s("artists"), "album": s("album"), "image": s("image"),
        "ms": (heard * 1000.0) as u64, "at": c.started_at_ms, "dur": (duration * 1000.0) as u64,
    });
    append(&entry);
}

fn append(entry: &Value) {
    let path = files::path("history.jsonl");
    let line = format!("{entry}\n");
    if path.exists() {
        if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(&path) {
            let _ = f.write_all(line.as_bytes());
            return;
        }
    }
    files::write_privately(line.as_bytes(), &path);        // created readable only by you
}

pub fn entries(since: f64) -> Value {
    let Ok(text) = std::fs::read_to_string(files::path("history.jsonl")) else { return json!([]) };
    Value::Array(text.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|o| o.is_object())
        .filter(|o| since <= 0.0 || o.get("at").and_then(Value::as_f64).map_or(true, |at| at >= since))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_a_play_once_half_is_heard() {
        crate::files::use_test_dir();
        let _ = std::fs::remove_file(files::path("history.jsonl"));
        let h = History::default();
        let mut p = Map::new();
        p.insert("uri".into(), json!("spotify:track:x"));
        p.insert("name".into(), json!("Short"));
        p.insert("artists".into(), json!("Someone"));
        p.insert("duration_ms".into(), json!(1600));
        p.insert("is_playing".into(), json!(true));
        p.insert("active".into(), json!(true));
        h.observe(&p);
        std::thread::sleep(Duration::from_millis(900));    // past half of a 1.6 s song
        p.insert("uri".into(), json!("spotify:track:y"));
        p.insert("name".into(), json!("Next"));
        h.observe(&p);                                      // the next song started: the first one counts
        h.finish();                                         // the second was barely heard: it doesn't
        let all = entries(0.0);
        assert_eq!(all.as_array().unwrap().len(), 1, "{all}");
        assert_eq!(all[0]["name"], "Short");
        assert!(all[0]["ms"].as_u64().unwrap() >= 800);
    }
}
