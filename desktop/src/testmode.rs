
use crate::files;

/// Files copied from the real folder the first time.
const COPY: &[&str] = &[
    "spotify-token", "spotify-scopes", "secrets.json", "taste.json", "store.json", "history.jsonl",
    "spotify-history.json", "lastfm-plays.json", "settings.json", "librespot/credentials.json",
];

pub fn prepare() {
    if !files::test_mode() { return; }
    let marker = files::path(".copied-from-real");
    if marker.exists() { return; }
    let real = files::real_dir();
    let mut copied = vec![];
    for name in COPY {
        let from = real.join(name);
        let Ok(data) = std::fs::read(&from) else { continue };
        let to = files::path(name);
        if let Some(dir) = to.parent() { let _ = std::fs::create_dir_all(dir); }
        if files::write_privately(&data, &to) { copied.push(*name); }
    }
    // The profiles of taste modes (taste-focus.json…).
    if let Ok(dir) = std::fs::read_dir(&real) {
        for e in dir.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with("taste-") && name.ends_with(".json") {
                if let Ok(data) = std::fs::read(e.path()) { if files::write_privately(&data, &files::path(&name)) { copied.push("taste mode"); } }
            }
        }
    }
    files::write_privately(b"", &marker);
    log::info!("test mode: copied {} from {}", copied.join(", "), files::tidy(&real));
}
