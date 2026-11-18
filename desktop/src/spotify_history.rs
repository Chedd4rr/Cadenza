//! Your Spotify listening history from the files Spotify sends when you ask for your data
//! (spotify.com/account/privacy). A port of SpotifyHistory.swift, with the same rules and the same saved
//! file, so an import made by the Mac app reads here and the other way round.
//!
//! - Extended streaming history (Streaming_History_Audio_*.json): every play, with skip details.
//! - Account data (StreamingHistory_music_*.json): the last year, without song links or skip details.
//!
//! Only what Stats and the taste profile need is kept: when, how long, the song's name, artist, album and
//! link, and these flags: 1 skipped, 2 finished, 4 picked by you, 8 ended because you started something
//! else, 16 ended for a reason that says nothing about the song. IP addresses, countries and devices are
//! never saved. A play is matched by the minute it ended plus the song's name and artist, so nothing is
//! counted twice.
//!
//! Saved as spotify-history.json: {version, tracks: [[link, name, artist, album]],
//! plays: [[end time in seconds, song number, ms played, flags]]}.

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::files;

const MINIMUM_MS: i64 = 30_000;
const MAX_FILE_BYTES: u64 = 300 * 1024 * 1024;        // one history file is about 10-20 MB
const MAX_ZIP_ENTRIES: usize = 5000;
const MAX_ZIP_BYTES: u64 = 2_000_000_000;

#[derive(Default)]
struct Data {
    tracks: Vec<[String; 4]>,
    index: HashMap<String, usize>,
    plays: Vec<Vec<i64>>,
    seen: HashSet<String>,
    loaded: bool,
}

#[derive(Default)]
pub struct SpotifyHistory {
    data: Mutex<Data>,
}

enum Outcome { Added, AddedSkip, Duplicate, Skipped }

fn key(end_sec: i64, id: &str) -> String { format!("{}|{id}", end_sec.div_euclid(60)) }
fn track_id(name: &str, artist: &str) -> String { format!("{name}\u{1}{artist}").to_lowercase() }

fn int(v: Option<&Value>) -> i64 {
    match v {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

impl SpotifyHistory {
    fn load(d: &mut Data) {
        if d.loaded { return; }
        d.loaded = true;
        let Some(obj) = files::read_json("spotify-history.json") else { return };
        // (Padded to four fields rather than dropped, so the song numbers in plays stay right.)
        d.tracks = obj.get("tracks").and_then(Value::as_array).map(|rows| rows.iter().map(|r| {
            let f = |i: usize| r.get(i).and_then(Value::as_str).unwrap_or("").to_string();
            [f(0), f(1), f(2), f(3)]
        }).collect()).unwrap_or_default();
        let n = d.tracks.len() as i64;
        d.plays = obj.get("plays").and_then(Value::as_array).map(|rows| rows.iter().filter_map(|p| {
            let v: Vec<i64> = p.as_array()?.iter().map(|x| int(Some(x))).collect();
            ((v.len() == 3 || v.len() == 4) && v[1] >= 0 && v[1] < n).then_some(v)
        }).collect()).unwrap_or_default();
        for (i, t) in d.tracks.iter().enumerate() { d.index.insert(track_id(&t[1], &t[2]), i); }
        let keys: Vec<String> = d.plays.iter().map(|p| { let t = &d.tracks[p[1] as usize]; key(p[0], &track_id(&t[1], &t[2])) }).collect();
        d.seen.extend(keys);
    }

    fn save(d: &Data) {
        let obj = json!({"version": 1, "tracks": d.tracks, "plays": d.plays});
        files::write_json("spotify-history.json", &obj);
    }

    /// Everything imported, for the Stats page. Empty lists if nothing was imported.
    pub fn snapshot(&self) -> Value {
        let mut d = self.data.lock().unwrap();
        Self::load(&mut d);
        json!({"tracks": d.tracks, "plays": d.plays})
    }

    /// Forget the imported history (Cadenza's own history and Last.fm are untouched).
    pub fn clear(&self) {
        let mut d = self.data.lock().unwrap();
        *d = Data { loaded: true, ..Default::default() };
        let _ = std::fs::remove_file(files::path("spotify-history.json"));
    }

    /// Reads the picked files: .json files, folders holding them, or the .zip Spotify sends.
    pub fn import(&self, picked: &[PathBuf]) -> Value {
        let mut d = self.data.lock().unwrap();
        Self::load(&mut d);

        // Every history file's contents: picked directly, inside a picked folder, or inside a picked .zip.
        let mut sources: Vec<Vec<u8>> = vec![];
        for p in picked {
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if p.is_dir() {
                for f in json_files_in(p) { if let Some(b) = read_capped(&f) { sources.push(b); } }
            } else if ext == "zip" {
                sources.extend(read_zip(p));
            } else if ext == "json" {
                if let Some(b) = read_capped(p) { sources.push(b); }
            }
        }

        let (mut used, mut read, mut added, mut duplicates, mut short, mut skips) = (0, 0, 0, 0, 0, 0);
        let before = d.plays.len();
        let mut fixes: HashMap<String, i64> = HashMap::new();
        for bytes in sources {
            let Ok(Value::Array(rows)) = serde_json::from_slice::<Value>(&bytes) else { continue };
            let Some(Value::Object(first)) = rows.first() else { continue };
            if !is_history(first) { continue; }                     // some other file in the download
            used += 1;
            for row in &rows {
                let Value::Object(row) = row else { continue };
                read += 1;
                match add(&mut d, row, &mut fixes) {
                    Outcome::Added => added += 1,
                    Outcome::AddedSkip => skips += 1,
                    Outcome::Duplicate => duplicates += 1,
                    Outcome::Skipped => short += 1,
                }
            }
        }
        // Plays already here from an older import (without flags, or with fewer): bring their flags up to date.
        let mut fixed = 0;
        if !fixes.is_empty() {
            for i in 0..d.plays.len() {
                let t = &d.tracks[d.plays[i][1] as usize];
                let Some(&f) = fixes.get(&key(d.plays[i][0], &track_id(&t[1], &t[2]))) else { continue };
                let p = &mut d.plays[i];
                if p.len() == 3 { p.push(f); fixed += 1; } else if p[3] != f { p[3] = f; fixed += 1; }
            }
        }
        if d.plays.len() != before || fixed > 0 {
            d.plays.sort_by_key(|p| p[0]);
            Self::save(&d);
        }
        json!({
            "files": used, "read": read, "added": added, "skips": skips, "duplicates": duplicates, "skipped": short,
            "updated": fixed, "total": d.plays.len(),
            "first": d.plays.first().map(|p| p[0] * 1000).unwrap_or(0), "last": d.plays.last().map(|p| p[0] * 1000).unwrap_or(0),
        })
    }
}

fn is_history(row: &Map<String, Value>) -> bool {
    (row.contains_key("ts") && row.contains_key("ms_played")) || (row.contains_key("endTime") && row.contains_key("msPlayed"))
}

fn add(d: &mut Data, row: &Map<String, Value>, fixes: &mut HashMap<String, i64>) -> Outcome {
    let s = |k: &str| row.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let mut flags = 0i64;
    let (name, artist, album, uri, ms, end);
    if let Some(ts) = row.get("ts").and_then(Value::as_str) {
        // Extended history. Podcasts and audiobooks have no song name: Stats is about music.
        name = s("master_metadata_track_name");
        artist = s("master_metadata_album_artist_name");
        album = s("master_metadata_album_album_name");
        let link = s("spotify_track_uri");
        uri = if link.starts_with("spotify:track:") { link } else { String::new() };
        ms = int(row.get("ms_played"));
        end = chrono::DateTime::parse_from_rfc3339(ts).ok().map(|t| t.timestamp());
        let (end_reason, start_reason) = (s("reason_end"), s("reason_start"));
        if row.get("skipped").and_then(Value::as_bool) == Some(true) || end_reason == "fwdbtn" { flags |= 1; }
        if end_reason == "trackdone" { flags |= 2; }
        if start_reason == "clickrow" { flags |= 4; }
        if end_reason == "endplay" || end_reason == "remote" { flags |= 8; }
        if ["backbtn", "trackerror", "logout", "unexpected-exit", "unexpected-exit-while-paused", "unknown"].contains(&end_reason.as_str()) { flags |= 16; }
    } else {
        name = s("trackName");
        artist = s("artistName");
        album = String::new();
        uri = String::new();
        ms = int(row.get("msPlayed"));
        end = chrono::NaiveDateTime::parse_from_str(&s("endTime"), "%Y-%m-%d %H:%M").ok().map(|t| t.and_utc().timestamp());
        if ms < MINIMUM_MS { flags |= 1; }                          // no reasons in these files: short means skipped
    }
    // Under a second counts only when you pressed next: otherwise it's a flicker, not a choice either way.
    let Some(end) = end else { return Outcome::Skipped };
    if name.is_empty() || artist.is_empty() || ms <= 0 || (ms < 1000 && flags & 1 == 0) { return Outcome::Skipped; }

    let id = track_id(&name, &artist);
    let k = key(end, &id);
    if d.seen.contains(&k) { fixes.insert(k, flags); return Outcome::Duplicate; }
    d.seen.insert(k);

    let index = match d.index.get(&id) {
        Some(&i) => {
            // A song first seen in the "account data" files has no link or album yet: fill them in.
            if d.tracks[i][0].is_empty() && !uri.is_empty() { d.tracks[i][0] = uri; }
            if d.tracks[i][3].is_empty() && !album.is_empty() { d.tracks[i][3] = album; }
            i
        }
        None => {
            d.tracks.push([uri, name, artist, album]);
            d.index.insert(id, d.tracks.len() - 1);
            d.tracks.len() - 1
        }
    };
    d.plays.push(vec![end, index as i64, ms, flags]);
    if ms >= MINIMUM_MS { Outcome::Added } else { Outcome::AddedSkip }
}

fn read_capped(p: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(p).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES { return None; }
    std::fs::read(p).ok()
}

/// Every .json file under `dir`, not following links out of it.
fn json_files_in(dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    let mut stack = vec![dir.to_path_buf()];
    let mut seen = 0;
    while let Some(d) = stack.pop() {
        let Ok(list) = std::fs::read_dir(&d) else { continue };
        for e in list.flatten() {
            seen += 1;
            if seen > 20_000 { return out; }
            let Ok(t) = e.file_type() else { continue };
            if t.is_symlink() { continue; }
            let p = e.path();
            let hidden = p.file_name().and_then(|n| n.to_str()).map_or(true, |n| n.starts_with('.'));
            if hidden { continue; }
            if t.is_dir() { stack.push(p); }
            else if t.is_file() && p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("json")).unwrap_or(false) { out.push(p); }
        }
    }
    out.sort();
    out
}

/// The .json files inside a .zip, read in memory: nothing is unpacked to disk, so a file name in the zip
/// can't land anywhere. Zips with more than 5,000 entries or more than 2 GB inside are refused, and each
/// file must stay under the size limit as it's actually read.
fn read_zip(p: &Path) -> Vec<Vec<u8>> {
    let Ok(f) = std::fs::File::open(p) else { return vec![] };
    let Ok(mut zip) = zip::ZipArchive::new(f) else { return vec![] };
    if zip.len() > MAX_ZIP_ENTRIES { return vec![]; }
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        if let Ok(e) = zip.by_index_raw(i) { total = total.saturating_add(e.size()); }
    }
    if total > MAX_ZIP_BYTES { return vec![]; }
    let mut out = vec![];
    for i in 0..zip.len() {
        let Ok(e) = zip.by_index(i) else { continue };
        if !e.is_file() || !e.name().to_ascii_lowercase().ends_with(".json") { continue; }
        let base = e.name().rsplit('/').next().unwrap_or("");
        if base.starts_with('.') || e.name().contains("__MACOSX") { continue; }
        // The size a zip claims can be wrong: stop reading at the limit whatever it says.
        let mut buf = vec![];
        if e.take(MAX_FILE_BYTES + 1).read_to_end(&mut buf).is_err() || buf.len() as u64 > MAX_FILE_BYTES { continue; }
        out.push(buf);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cadenza-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn imports_both_kinds_without_counting_twice() {
        crate::files::use_test_dir();
        let h = SpotifyHistory::default();
        h.clear();
        let dir = tmp("hist");
        let extended = json!([
            {"ts": "2024-03-01T10:00:00Z", "ms_played": 200000, "master_metadata_track_name": "Song A", "master_metadata_album_artist_name": "Artist", "master_metadata_album_album_name": "Album", "spotify_track_uri": "spotify:track:aaa", "reason_start": "clickrow", "reason_end": "trackdone", "skipped": false, "ip_addr": "1.2.3.4", "conn_country": "US"},
            {"ts": "2024-03-01T10:05:00Z", "ms_played": 5000, "master_metadata_track_name": "Song B", "master_metadata_album_artist_name": "Artist", "master_metadata_album_album_name": "Album", "spotify_track_uri": "spotify:track:bbb", "reason_start": "trackdone", "reason_end": "fwdbtn", "skipped": true},
            {"ts": "2024-03-01T10:06:00Z", "ms_played": 400000, "master_metadata_track_name": null, "episode_name": "A podcast"},
            {"ts": "2024-03-01T10:07:00Z", "ms_played": 500, "master_metadata_track_name": "Song C", "master_metadata_album_artist_name": "Artist", "reason_end": "trackdone"}
        ]);
        let a = dir.join("Streaming_History_Audio_2024.json");
        std::fs::write(&a, extended.to_string()).unwrap();
        let r = h.import(&[a.clone()]);
        assert_eq!(r["files"], 1);
        assert_eq!(r["added"], 1, "{r}");        // Song A
        assert_eq!(r["skips"], 1, "{r}");        // Song B, a 5 s skip
        assert_eq!(r["skipped"], 2, "{r}");      // the podcast and a half-second flicker
        let snap = h.snapshot();
        assert_eq!(snap["plays"][0][3], 2 | 4);  // finished, picked by you
        assert_eq!(snap["plays"][1][3], 1);      // skipped
        // Nothing but what Stats needs is kept.
        let saved = std::fs::read_to_string(crate::files::path("spotify-history.json")).unwrap();
        assert!(!saved.contains("1.2.3.4") && !saved.contains("US"));

        // The same file again, inside a zip this time: all duplicates.
        let zpath = dir.join("my_spotify_data.zip");
        {
            let f = std::fs::File::create(&zpath).unwrap();
            let mut z = zip::ZipWriter::new(f);
            let o: zip::write::SimpleFileOptions = Default::default();
            z.start_file("Spotify Extended Streaming History/Streaming_History_Audio_2024.json", o).unwrap();
            z.write_all(extended.to_string().as_bytes()).unwrap();
            z.start_file("Spotify Extended Streaming History/ReadMeFirst.pdf", o).unwrap();
            z.write_all(b"%PDF").unwrap();
            z.finish().unwrap();
        }
        let r = h.import(&[zpath]);
        assert_eq!(r["added"], 0, "{r}");
        assert_eq!(r["duplicates"], 2, "{r}");

        // The shorter "account data" download overlapping Song A (same minute it ended), plus one new play.
        let account = json!([
            {"endTime": "2024-03-01 10:00", "artistName": "Artist", "trackName": "Song A", "msPlayed": 200000},
            {"endTime": "2024-03-02 09:00", "artistName": "Other", "trackName": "Song D", "msPlayed": 120000}
        ]);
        let b = dir.join("StreamingHistory_music_0.json");
        std::fs::write(&b, account.to_string()).unwrap();
        let r = h.import(&[dir.clone()]);   // the whole folder: picks up all three .json files
        assert_eq!(r["added"], 1, "{r}");
        assert_eq!(r["total"], 3, "{r}");

        // A fresh reader loads what was saved (the Mac app's format) the same way.
        let again = SpotifyHistory::default();
        assert_eq!(again.snapshot()["plays"].as_array().unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(dir);
    }
}
