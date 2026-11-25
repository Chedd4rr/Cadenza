//! Updates. Cadenza looks for a newer release on GitHub, tells the page, and installs it when you say so.
//!
//! The release has a small file, `latest.json`, listing the newest version and where each system's
//! installer is. Nothing is installed unless the download is signed with Cadenza's own key: the public half
//! of that key is in tauri.conf.json (plugins → updater → pubkey), the private half stays with whoever makes
//! the release. So someone who gets into the GitHub repository (or points the "GitHub repository" setting at
//! another one) still can't get Cadenza to run their code without that key.
//!
//! Until a key has been put in tauri.conf.json this does nothing and says so. See docs/releasing.md.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::librespot::Emit;
use crate::{files, settings::Settings};

/// At most one automatic look every six hours, however often Cadenza is opened.
const AUTO_EVERY_SECS: u64 = 6 * 3600;

struct Status {
    /// "idle", "available" or "error" (what the page's Updates row understands).
    state: &'static str,
    message: String,
    found: Option<Value>,
}

pub struct Updater {
    app: AppHandle,
    settings: Arc<Settings>,
    emit: Emit,
    status: Mutex<Status>,
    /// The update that was found, kept so installing it doesn't have to look again.
    pending: tokio::sync::Mutex<Option<Update>>,
}

impl Updater {
    pub fn new(app: AppHandle, settings: Arc<Settings>, emit: Emit) -> Arc<Self> {
        Arc::new(Updater {
            app, settings, emit,
            status: Mutex::new(Status { state: "idle", message: String::new(), found: None }),
            pending: tokio::sync::Mutex::new(None),
        })
    }

    /// What the page shows in System → Updates.
    pub fn status(&self) -> Value {
        let s = self.status.lock().unwrap();
        let mut v = json!({
            "repo": self.settings.string("updateRepo"),
            "current": env!("CARGO_PKG_VERSION"),
            "state": s.state,
            "message": s.message,
            "auto": self.settings.bool("autoUpdate"),
        });
        if let Some(f) = &s.found { v["found"] = f.clone(); }
        v
    }

    fn set(&self, state: &'static str, message: impl Into<String>, found: Option<Value>) {
        *self.status.lock().unwrap() = Status { state, message: message.into(), found };
    }

    /// Whether this copy of Cadenza has a key to check updates against.
    fn has_key(&self) -> bool {
        self.app.config().plugins.0.get("updater")
            .and_then(|c| c.get("pubkey")).and_then(|k| k.as_str())
            .map(|k| !k.trim().is_empty()).unwrap_or(false)
    }

    /// Where the list of releases is for the repository in the settings.
    fn endpoint(&self) -> Option<url::Url> {
        let repo = self.settings.string("updateRepo");
        let ok = regex::Regex::new(r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$").unwrap().is_match(&repo);
        if !ok { return None; }
        url::Url::parse(&format!("https://github.com/{repo}/releases/latest/download/latest.json")).ok()
    }

    /// Looks for a newer version. Returns the status for the page, which is also pushed as an "update" event.
    pub async fn check(&self) -> Value {
        if !self.has_key() {
            self.set("idle", "Updates aren't set up in this copy of Cadenza. Get a release from GitHub, or build again", None);
            return self.status();
        }
        let Some(url) = self.endpoint() else {
            self.set("idle", "", None);
            return self.status();
        };
        let result = async {
            let updater = self.app.updater_builder().endpoints(vec![url])?.timeout(Duration::from_secs(20)).build()?;
            updater.check().await
        }.await;
        match result {
            Ok(Some(u)) => {
                let found = json!({"version": u.version, "notes": u.body.clone().unwrap_or_default(), "page": "", "asset": ""});
                self.set("available", format!("Version {} is ready", u.version), Some(found));
                *self.pending.lock().await = Some(u);
            }
            Ok(None) => {
                *self.pending.lock().await = None;
                self.set("idle", format!("You have the newest version ({})", env!("CARGO_PKG_VERSION")), None);
            }
            Err(e) => {
                log::warn!("update check failed: {e}");
                self.set("error", friendly(&e.to_string()), None);
            }
        }
        let v = self.status();
        (self.emit)("update", v.clone());
        v
    }

    /// Downloads the update found by the last check, checks its signature, installs it and restarts.
    pub async fn install(&self) -> Value {
        let update = self.pending.lock().await.take();
        let update = match update {
            Some(u) => u,
            None => {
                // Looked for a while ago and forgotten (or never): look again.
                self.check().await;
                match self.pending.lock().await.take() {
                    Some(u) => u,
                    None => return json!({"ok": false, "message": "There's no newer version"}),
                }
            }
        };
        log::info!("installing update {}", update.version);
        match update.download_and_install(|_, _| {}, || {}).await {
            Ok(()) => {
                // Windows runs the installer, which closes Cadenza itself; elsewhere Cadenza starts again here.
                let app = self.app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    app.restart();
                });
                json!({"ok": true, "message": "Installing"})
            }
            Err(e) => {
                log::warn!("update failed: {e}");
                json!({"ok": false, "message": friendly(&e.to_string())})
            }
        }
    }

    /// Looks for an update when Cadenza opens (and every six hours while it stays open), if that's on.
    pub fn start_auto(self: &Arc<Self>) {
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            // Let Cadenza finish opening and the music start first.
            tokio::time::sleep(Duration::from_secs(25)).await;
            loop {
                if me.settings.bool("autoUpdate") && due() && me.has_key() {
                    note_checked();
                    let v = me.check().await;
                    if v["state"] == "available" {
                        if let Some(f) = v.get("found") { log::info!("update available: {}", f["version"]); }
                    }
                }
                tokio::time::sleep(Duration::from_secs(30 * 60)).await;
            }
        });
    }
}

/// A short, plain reason instead of the library's wording.
fn friendly(e: &str) -> String {
    let l = e.to_ascii_lowercase();
    if l.contains("404") || l.contains("not found") || l.contains("could not fetch") && l.contains("status") {
        "No release with an update file was found on GitHub (a private repository can't be read)".into()
    } else if l.contains("signature") || l.contains("minisign") || l.contains("pubkey") {
        "The update isn't signed with Cadenza's key, so it wasn't installed".into()
    } else if l.contains("error sending request") || l.contains("dns") || l.contains("connect") || l.contains("timed out") {
        "Couldn't reach GitHub".into()
    } else {
        "Couldn't check for updates".into()
    }
}

fn stamp_path() -> std::path::PathBuf { files::path("update-check") }

fn now() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }

/// It's been six hours or more since the last automatic look.
fn due() -> bool {
    let last = std::fs::read_to_string(stamp_path()).ok().and_then(|t| t.trim().parse::<u64>().ok()).unwrap_or(0);
    now().saturating_sub(last) >= AUTO_EVERY_SECS
}

fn note_checked() { let _ = files::write_privately(now().to_string().as_bytes(), &stamp_path()); }

#[cfg(test)]
mod tests {
    use super::friendly;

    #[test]
    fn errors_are_put_in_plain_words() {
        assert!(friendly("the server responded with 404 Not Found").contains("No release"));
        assert!(friendly("signature verification failed").contains("isn't signed"));
        assert!(friendly("error sending request for url (https://github.com/...)").contains("reach GitHub"));
        assert_eq!(friendly("something odd"), "Couldn't check for updates");
    }
}
