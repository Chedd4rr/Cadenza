//! Headphone EQ profiles from AutoEq (github.com/jaakkopasanen/AutoEq): measured corrections for thousands
//! of headphones, as parametric EQ. Cadenza downloads AutoEq's list of headphones once a week (and keeps
//! it), searches it, and downloads the one profile you pick. Only AutoEq's own files on GitHub are read.

use serde_json::{json, Value};
use std::time::{Duration, SystemTime};

use crate::{dsp, files, sound};

const BASE: &str = "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results";
const INDEX_FILE: &str = "autoeq-index.md";
const WEEK: Duration = Duration::from_secs(7 * 86400);

/// One headphone in AutoEq's list: its name, where its files are (as AutoEq writes it, already
/// URL-encoded, like "oratory1990/over-ear/Sennheiser%20HD%20650") and who measured it.
#[derive(Debug, PartialEq)]
pub struct Entry { pub name: String, pub path: String, pub by: String }

/// AutoEq's INDEX.md: lines like "- [Sennheiser HD 650](./oratory1990/over-ear/Sennheiser%20HD%20650) by oratory1990".
pub fn parse_index(text: &str) -> Vec<Entry> {
    text.lines().filter_map(|l| {
        let l = l.trim().strip_prefix("- [")?;
        let (name, rest) = l.split_once("](./")?;
        let (path, rest) = rest.split_once(')')?;
        let by = rest.trim().strip_prefix("by ").unwrap_or("").trim().to_string();
        if !safe_path(path) { return None; }
        Some(Entry { name: name.to_string(), path: path.to_string(), by })
    }).collect()
}

/// Only plain paths inside AutoEq's results: no "..", no other sites.
fn safe_path(p: &str) -> bool {
    !p.is_empty() && p.len() < 300 && !p.contains("..") && !p.contains("//") && !p.starts_with('/')
        && p.chars().all(|c| c.is_ascii_alphanumeric() || " %()_-.,+&'/!".contains(c))
}

/// The best matches for a search: every word has to appear in the name; names starting with the search
/// come first. At most 40.
pub fn search<'a>(list: &'a [Entry], q: &str) -> Vec<&'a Entry> {
    let q = q.trim().to_lowercase();
    let words: Vec<&str> = q.split_whitespace().collect();
    if words.is_empty() { return vec![]; }
    let mut hits: Vec<&Entry> = list.iter().filter(|e| { let n = e.name.to_lowercase(); words.iter().all(|w| n.contains(w)) }).collect();
    hits.sort_by_key(|e| (!e.name.to_lowercase().starts_with(&q), e.name.len()));
    hits.truncate(40);
    hits
}

async fn index(http: &reqwest::Client) -> Result<String, String> {
    let path = files::path(INDEX_FILE);
    let fresh = std::fs::metadata(&path).ok().and_then(|m| m.modified().ok())
        .map_or(false, |t| SystemTime::now().duration_since(t).unwrap_or(WEEK) < WEEK);
    let saved = std::fs::read_to_string(&path).ok();
    if fresh { if let Some(t) = saved.clone() { return Ok(t); } }
    match get(http, &format!("{BASE}/INDEX.md")).await {
        Ok(t) if t.contains("](./") => { let _ = files::write_privately(t.as_bytes(), &path); Ok(t) }
        // Offline (or GitHub is down): last week's list is still good.
        r => saved.ok_or_else(|| r.err().unwrap_or_else(|| "AutoEq's list looked wrong".into())),
    }
}

async fn get(http: &reqwest::Client, url: &str) -> Result<String, String> {
    let r = http.get(url).timeout(Duration::from_secs(20)).send().await.map_err(|_| "Couldn't reach AutoEq on GitHub".to_string())?;
    if !r.status().is_success() { return Err(format!("AutoEq answered {}", r.status().as_u16())); }
    let t = r.text().await.map_err(|e| e.to_string())?;
    if t.len() > 4 << 20 { return Err("That file is too large".into()); }
    Ok(t)
}

/// {ok, results: [{name, path, by}]}
pub async fn find(http: &reqwest::Client, q: &str) -> Value {
    match index(http).await {
        Ok(text) => {
            let list = parse_index(&text);
            let hits: Vec<Value> = search(&list, q).into_iter().map(|e| json!({"name": e.name, "path": e.path, "by": e.by})).collect();
            json!({"ok": true, "results": hits, "count": list.len()})
        }
        Err(m) => json!({"ok": false, "message": m}),
    }
}

/// Downloads one headphone's parametric EQ: {ok, name, preamp, filters}.
pub async fn load(http: &reqwest::Client, path: &str) -> Value {
    if !safe_path(path) { return json!({"ok": false, "message": "Not an AutoEq profile"}); }
    let file = path.rsplit('/').next().unwrap_or("");
    match get(http, &format!("{BASE}/{path}/{file}%20ParametricEQ.txt")).await {
        Ok(text) => parsed(&text, &url_decode(file)),
        Err(m) => json!({"ok": false, "message": m}),
    }
}

/// An Equalizer APO / AutoEq text, as the page wants it.
pub fn parsed(text: &str, name: &str) -> Value {
    let (preamp, filters, skipped) = dsp::parse_apo(text);
    if filters.is_empty() { return json!({"ok": false, "message": "No EQ filters in that file (it needs Equalizer APO's format, like AutoEq's ParametricEQ.txt)"}); }
    json!({"ok": true, "name": name, "preamp": preamp.clamp(-12.0, 12.0), "filters": sound::filters_json(&filters), "skipped": skipped})
}

fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) { out.push(v); i += 3; continue; }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_autoeqs_list_and_finds_headphones() {
        let text = "# Index\nSome words.\n\n- [Sennheiser HD 650](./oratory1990/over-ear/Sennheiser%20HD%20650) by oratory1990\n\
                    - [Sennheiser HD 650](./crinacle/GRAS%2043AG-7%20over-ear/Sennheiser%20HD%20650) by crinacle on GRAS 43AG-7\n\
                    - [Apple AirPods Pro 2](./Rtings/in-ear/Apple%20AirPods%20Pro%202) by Rtings\n\
                    - [Evil](./../../etc/passwd) by nobody\n";
        let list = parse_index(text);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0], Entry { name: "Sennheiser HD 650".into(), path: "oratory1990/over-ear/Sennheiser%20HD%20650".into(), by: "oratory1990".into() });
        assert_eq!(search(&list, "hd650").len(), 0);
        assert_eq!(search(&list, "hd 650").len(), 2);
        assert_eq!(search(&list, "airpods pro")[0].name, "Apple AirPods Pro 2");
        assert!(search(&list, "  ").is_empty());
        assert_eq!(url_decode("Sennheiser%20HD%20650"), "Sennheiser HD 650");
        assert_eq!(url_decode("100%"), "100%");
        assert!(!safe_path("https://evil.com/x") || !safe_path("a//b"));
        assert!(!safe_path("../x"));
    }
}
