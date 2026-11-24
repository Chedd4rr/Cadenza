//! Lyrics translation runs Firefox's offline translator (Bergamot) inside the page, so nothing you
//! translate leaves your computer. It needs a language model for each direction (about 15 to 60 MB). This
//! finds the right ones in Mozilla's public list (the same one Firefox uses), downloads them the first
//! time, checks each file against the hash Mozilla publishes, and keeps them in translation-models/.
//! The page reads the files through cadenza-files:// (main.rs).

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::files;

const RECORDS_URL: &str = "https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records";
const ATTACHMENTS: &str = "https://firefox-settings-attachments.cdn.mozilla.net/";
const MAX_FILE_BYTES: u64 = 150 * 1024 * 1024;

#[derive(Clone)]
struct Part { kind: String, name: String, location: String, hash: String, size: u64, ext: &'static str }

pub fn dir() -> PathBuf { files::path("translation-models") }

static BUSY: AtomicBool = AtomicBool::new(false);

/// "2.1" → 2.001 (for sorting); None for anything else, like "2.0a1".
fn number(v: &str) -> Option<f64> {
    let bits: Vec<&str> = v.split('.').collect();
    if bits.is_empty() || bits.len() > 3 || !bits.iter().all(|b| !b.is_empty() && b.chars().all(|c| c.is_ascii_digit())) { return None; }
    Some(bits.iter().enumerate().map(|(i, b)| b.parse::<f64>().unwrap_or(0.0) / 1000f64.powi(i as i32)).sum())
}

/// Files are named by their hash, so a changed model never mixes with an old one.
fn path_for(p: &Part) -> PathBuf { dir().join(format!("{}.{}", p.hash, p.ext)) }

/// Mozilla's list, kept for a week (or used as it is when there's no connection).
async fn records(http: &reqwest::Client) -> Option<Vec<Value>> {
    let _ = std::fs::create_dir_all(dir());
    let list = dir().join("records.json");
    let age = std::fs::metadata(&list).and_then(|m| m.modified()).ok()
        .and_then(|t| t.elapsed().ok()).unwrap_or(Duration::MAX);
    if age > Duration::from_secs(7 * 86400) {
        if let Ok(r) = http.get(RECORDS_URL).header("Accept", "application/json").timeout(Duration::from_secs(20)).send().await {
            if r.status().as_u16() == 200 {
                if let Ok(bytes) = r.bytes().await {
                    if bytes.len() < 20_000_000 && serde_json::from_slice::<Value>(&bytes).map(|v| v.is_object()).unwrap_or(false) {
                        files::write_privately(&bytes, &list);
                    }
                }
            }
        }
    }
    let v: Value = serde_json::from_slice(&std::fs::read(&list).ok()?).ok()?;
    v.get("data")?.as_array().cloned()
}

/// The newest complete model for a direction (below `below`, if given). Records meant only for Firefox on
/// Android or for test builds are left out, and so are alpha versions.
fn choose(records: &[Value], from: &str, to: &str, below: Option<&str>) -> Option<(String, Vec<Part>)> {
    let mut by_version: HashMap<String, Vec<Part>> = HashMap::new();
    for r in records {
        let s = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or("");
        if s("fromLang") != from || s("toLang") != to { continue; }
        let version = s("version");
        let kind = s("fileType");
        if number(version).is_none() || !["model", "lex", "vocab", "srcvocab", "trgvocab"].contains(&kind) { continue; }
        let Some(a) = r.get("attachment") else { continue };
        let location = a.get("location").and_then(Value::as_str).unwrap_or("");
        let hash = a.get("hash").and_then(Value::as_str).unwrap_or("");
        let size = a.get("size").and_then(Value::as_u64).unwrap_or(0);
        if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) || size == 0 || size > MAX_FILE_BYTES
            || location.is_empty() || location.contains("..") || location.starts_with('/') { continue; }
        let filter = s("filter_expression");
        if filter.contains("== 'Android'") || filter.contains("channel ==") { continue; }
        let ext = if location.to_ascii_lowercase().ends_with(".spm") { "spm" } else { "bin" };
        by_version.entry(version.to_string()).or_default().push(Part {
            kind: kind.into(), name: s("name").into(), location: location.into(), hash: hash.to_ascii_lowercase(), size, ext,
        });
    }
    let limit = below.and_then(number);
    let mut versions: Vec<&String> = by_version.keys().filter(|v| limit.map_or(true, |l| number(v).unwrap() < l)).collect();
    versions.sort_by(|a, b| number(b).unwrap().total_cmp(&number(a).unwrap()));
    for v in versions {
        let mut parts: HashMap<&str, Part> = HashMap::new();
        for p in &by_version[v] { parts.entry(p.kind.as_str()).or_insert_with(|| p.clone()); }
        let vocabs = parts.contains_key("vocab") || (parts.contains_key("srcvocab") && parts.contains_key("trgvocab"));
        if parts.contains_key("model") && parts.contains_key("lex") && vocabs {
            return Some((v.clone(), parts.into_values().collect()));
        }
    }
    None
}

/// Downloads one file, checks its size and hash, and only then keeps it. Err(reason) otherwise.
async fn download(http: &reqwest::Client, p: &Part, mut on_bytes: impl FnMut(u64)) -> Result<(), String> {
    let url = format!("{ATTACHMENTS}{}", p.location);
    let parsed = url::Url::parse(&url).map_err(|_| "bad-url")?;
    if parsed.host_str() != Some("firefox-settings-attachments.cdn.mozilla.net") { return Err("bad-url".into()); }
    let mut r = http.get(parsed).timeout(Duration::from_secs(300)).send().await.map_err(|_| "download-failed")?;
    if r.status().as_u16() != 200 { return Err("download-failed".into()); }
    let mut data: Vec<u8> = Vec::with_capacity(p.size as usize);
    while let Some(chunk) = r.chunk().await.map_err(|_| "download-failed")? {
        data.extend_from_slice(&chunk);
        if data.len() as u64 > p.size { return Err("size-mismatch".into()); }
        on_bytes(data.len() as u64);
    }
    if data.len() as u64 != p.size { return Err("size-mismatch".into()); }
    if format!("{:x}", Sha256::digest(&data)) != p.hash { return Err("hash-mismatch".into()); }
    if files::write_privately(&data, &path_for(p)) { Ok(()) } else { Err("write-failed".into()) }
}

/// Finds (and if needed downloads) the models to translate `from` → `to`: the direct pair, or through
/// English when there isn't one. Replies {models: [{from, to, version, files, int8}], error}.
pub async fn prepare(http: &reqwest::Client, from: &str, to: &str, below: Option<&str>, files_base: &str,
                     progress: impl Fn(u64, u64)) -> Value {
    let ok = |c: &str| (2..=8).contains(&c.len()) && c.chars().all(|ch| ch.is_alphabetic() || ch == '-');
    if !ok(from) || !ok(to) || from == to { return json!({"models": null, "error": "bad-language"}); }
    if BUSY.swap(true, Ordering::SeqCst) { return json!({"models": null, "error": "busy"}); }
    let out = prepare_inner(http, from, to, below, files_base, progress).await;
    BUSY.store(false, Ordering::SeqCst);
    match out {
        Ok(m) => json!({"models": m, "error": null}),
        Err(e) => json!({"models": null, "error": e}),
    }
}

async fn prepare_inner(http: &reqwest::Client, from: &str, to: &str, below: Option<&str>, files_base: &str,
                       progress: impl Fn(u64, u64)) -> Result<Value, String> {
    let records = records(http).await.ok_or("offline")?;
    let pairs: Vec<(&str, &str)> = if choose(&records, from, to, None).is_some() {
        vec![(from, to)]
    } else if from != "en" && to != "en" && choose(&records, from, "en", None).is_some() && choose(&records, "en", to, None).is_some() {
        vec![(from, "en"), ("en", to)]
    } else {
        return Err("unsupported".into());
    };
    let mut chosen = vec![];
    for (f, t) in pairs {
        let (version, parts) = choose(&records, f, t, below).ok_or("unsupported")?;
        chosen.push((f, t, version, parts));
    }
    // Download what isn't here yet, reporting progress across all the files.
    let missing: Vec<Part> = chosen.iter().flat_map(|c| c.3.iter().cloned()).filter(|p| !path_for(p).exists()).collect();
    let total: u64 = missing.iter().map(|p| p.size).sum();
    if total > 0 { progress(0, total); }
    let mut got = 0;
    for p in &missing {
        let before = got;
        download(http, p, |n| progress(before + n, total)).await?;
        got += p.size;
    }
    Ok(Value::Array(chosen.into_iter().map(|(f, t, version, parts)| {
        let files: serde_json::Map<String, Value> = parts.iter()
            .map(|p| (p.kind.clone(), json!(format!("{files_base}models/{}.{}", p.hash, p.ext)))).collect();
        // A few models (Ukrainian, for one) need a different number format; Firefox tells them apart by name.
        let int8 = parts.iter().any(|p| p.kind == "model" && p.name.ends_with("intgemm8.bin"));
        json!({"from": f, "to": t, "version": version, "files": files, "int8": int8})
    }).collect()))
}

/// How much the downloaded languages take up, in bytes.
pub fn disk_usage() -> u64 {
    std::fs::read_dir(dir()).map(|list| list.flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()).unwrap_or(0)
}

/// Deletes every downloaded language (they're downloaded again when needed).
pub fn clear() { let _ = std::fs::remove_dir_all(dir()); }

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(from: &str, to: &str, version: &str, kind: &str, name: &str, filter: &str) -> Value {
        let hash = format!("{:064x}", (from.len() * 7 + to.len() * 13 + version.len() * 17 + kind.len()) as u64 + name.len() as u64);
        json!({"fromLang": from, "toLang": to, "version": version, "fileType": kind, "name": name, "filter_expression": filter,
               "attachment": {"location": format!("main-workspace/translations-models/{name}"), "hash": hash, "size": 1000}})
    }
    fn full(from: &str, to: &str, version: &str, filter: &str) -> Vec<Value> {
        vec![rec(from, to, version, "model", &format!("model.{from}{to}.intgemm.alphas.bin"), filter),
             rec(from, to, version, "lex", &format!("lex.50.50.{from}{to}.s2t.bin"), filter),
             rec(from, to, version, "vocab", &format!("vocab.{from}{to}.spm"), filter)]
    }

    #[test]
    fn picks_the_newest_complete_model() {
        let mut r = vec![];
        r.extend(full("es", "en", "1.0", ""));
        r.extend(full("es", "en", "2.1", ""));
        r.extend(full("es", "en", "3.0a1", ""));                       // alpha: left out
        r.extend(full("es", "en", "9.0", "env.appinfo.OS == 'Android'"));  // Android only: left out
        r.push(rec("es", "en", "2.5", "model", "model.esen.bin", ""));   // incomplete: no lex or vocab
        let (v, parts) = choose(&r, "es", "en", None).unwrap();
        assert_eq!(v, "2.1");
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().any(|p| p.kind == "vocab" && p.ext == "spm"));
        // "That version didn't load: an older one".
        assert_eq!(choose(&r, "es", "en", Some("2.1")).unwrap().0, "1.0");
        assert!(choose(&r, "en", "es", None).is_none());
    }

    #[test]
    fn version_numbers_sort_properly() {
        assert!(number("2.10").unwrap() > number("2.9").unwrap());
        assert!(number("10.0").unwrap() > number("9.9").unwrap());
        assert_eq!(number("2.0a1"), None);
        assert_eq!(number(""), None);
    }
}
