//! Where Cadenza keeps its files, and how it writes them so only you can read them.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Test mode (`./build.sh --test`, or CADENZA_TEST=1): the app runs beside your normal Cadenza with its own
/// folder and its own speaker name, so it can't touch your real data or the other app's engine.
pub fn test_mode() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("CADENZA_TEST").map_or(false, |v| !v.is_empty() && v != "0"))
}

/// Your normal Cadenza folder (where test mode copies its starting data from).
/// - macOS: ~/Library/Application Support/Cadenza (the same folder the Swift app uses, so nothing moves)
/// - Windows: %APPDATA%\Cadenza
/// - Linux: ~/.local/share/cadenza
pub fn real_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    if cfg!(target_os = "linux") { base.join("cadenza") } else { base.join("Cadenza") }
}

/// The folder for settings, logins, history and the taste profile: your normal one, or in test mode a
/// separate "Cadenza Test" folder beside it.
pub fn support_dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let real = real_dir();
        let dir = if !test_mode() { real }
                  else if cfg!(target_os = "linux") { real.with_file_name("cadenza-test") }
                  else { real.with_file_name("Cadenza Test") };
        let _ = fs::create_dir_all(&dir);
        // Only your account can open the folder at all, whatever the files inside were saved with.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        }
        dir
    })
}

/// Tests keep their files in a throwaway folder, never in your real one.
#[cfg(test)]
pub fn use_test_dir() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let d = std::env::temp_dir().join(format!("cadenza-test-data-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::env::set_var("XDG_DATA_HOME", &d);
        std::env::set_var("HOME", &d);
    });
}

pub fn path(name: &str) -> PathBuf {
    support_dir().join(name)
}

/// Writes a file that only you can read (0600 on macOS and Linux) from the moment it exists, then moves
/// it into place. Writing first and tightening the permissions afterwards would leave it readable for a
/// moment, and writing in place would leave half a file if Cadenza quit in the middle.
pub fn write_privately(data: &[u8], to: &Path) -> bool {
    let Some(dir) = to.parent() else { return false };
    let name = to.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{name}-{:016x}", rand::random::<u64>()));
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let ok = opts.open(&tmp).and_then(|mut f| f.write_all(data).and_then(|_| f.sync_all())).is_ok();
    if !ok || fs::rename(&tmp, to).is_err() {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    true
}

/// A JSON file, or None if it's missing or broken.
pub fn read_json(name: &str) -> Option<serde_json::Value> {
    let data = fs::read(path(name)).ok()?;
    serde_json::from_slice(&data).ok()
}

pub fn write_json(name: &str, value: &serde_json::Value) -> bool {
    match serde_json::to_vec(value) {
        Ok(data) => write_privately(&data, &path(name)),
        Err(_) => false,
    }
}

/// Your home folder written as ~, for logs and diagnostics.
pub fn tidy(p: &Path) -> String {
    let s = p.display().to_string();
    match dirs::home_dir() {
        Some(home) => s.replacen(&home.display().to_string(), "~", 1),
        None => s,
    }
}
