//! The Mac's menu bar, the same as the Swift app's: Cadenza, Edit (so ⌘C, ⌘V and ⌘A work in text
//! boxes), Controls (the main commands with their shortcuts; each one runs in the page, as if you had
//! pressed its keys) and Window. Windows and Linux have no menu bar: everything is on the page.

use serde_json::json;
use std::sync::Arc;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};

/// (title, command, shortcut). "-" is a separator. Space, L and ⌘←/→ can't be menu shortcuts without
/// taking them away from text boxes, so their titles list them instead.
const CONTROLS: &[(&str, &str, &str)] = &[
    ("Play / Pause    (Space)", "toggle", ""),
    ("Next Song    (⌘→)", "next", ""),
    ("Previous Song    (⌘←)", "previous", ""),
    ("Shuffle", "shuffle", "Cmd+S"),
    ("Repeat", "repeat", "Cmd+R"),
    ("Like Song    (L)", "like", ""),
    ("-", "", ""),
    ("Stage Mode", "stage", "Cmd+Shift+F"),
    ("Floating Mini Player", "mini", "Cmd+Shift+M"),
    ("Command Palette…", "palette", "Cmd+K"),
    ("Search", "search", "Cmd+F"),
    ("Switch Theme", "theme", "Cmd+T"),
    ("-", "", ""),
    ("Home", "go:home", ""),
    ("Library", "go:library", ""),
    ("Queue", "go:queue", ""),
    ("History", "go:history", ""),
    ("Listening Stats", "go:stats", ""),
    ("Friends", "go:friends", ""),
    ("EQ", "go:eq", ""),
    ("DJ", "go:dj", ""),
    ("System", "go:system", "Cmd+Comma"),
    ("Keyboard Shortcuts", "go:commands", "Cmd+Slash"),
    ("-", "", ""),
    ("Check for Updates…", "update", ""),
];

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let about = AboutMetadata { name: Some("Cadenza".into()), version: Some(env!("CARGO_PKG_VERSION").into()), ..Default::default() };
    let cadenza = Submenu::with_items(app, "Cadenza", true, &[
        &PredefinedMenuItem::about(app, Some("About Cadenza"), Some(about))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::hide(app, Some("Hide Cadenza"))?,
        &PredefinedMenuItem::hide_others(app, None)?,
        &PredefinedMenuItem::show_all(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::quit(app, Some("Quit Cadenza"))?,
    ])?;
    let edit = Submenu::with_items(app, "Edit", true, &[
        &PredefinedMenuItem::undo(app, None)?,
        &PredefinedMenuItem::redo(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::cut(app, None)?,
        &PredefinedMenuItem::copy(app, None)?,
        &PredefinedMenuItem::paste(app, None)?,
        &PredefinedMenuItem::select_all(app, None)?,
    ])?;
    let controls = Submenu::new(app, "Controls", true)?;
    for (title, cmd, keys) in CONTROLS {
        if *title == "-" { controls.append(&PredefinedMenuItem::separator(app)?)?; continue; }
        let keys = if keys.is_empty() { None } else { Some(*keys) };
        controls.append(&MenuItem::with_id(app, format!("cmd:{cmd}"), *title, true, keys)?)?;
    }
    let window = Submenu::with_items(app, "Window", true, &[
        &PredefinedMenuItem::minimize(app, None)?,
        &PredefinedMenuItem::close_window(app, None)?,
        &PredefinedMenuItem::fullscreen(app, None)?,
    ])?;
    Menu::with_items(app, &[&cadenza, &edit, &controls, &window])
}

/// A Controls item was picked: the mini player opens here; everything else runs in the page, which
/// comes back first if it was closed.
pub fn picked(app: &AppHandle, id: &str) {
    let Some(cmd) = id.strip_prefix("cmd:") else { return };
    let Some(sys) = app.try_state::<Arc<crate::system::System>>() else { return };
    if cmd == "mini" { sys.toggle_mini(); return; }
    let visible = app.get_webview_window("main").and_then(|w| w.is_visible().ok()).unwrap_or(false);
    if !visible { sys.show_main(); }
    if let Some(core) = app.try_state::<Arc<crate::Core>>() { (core.emit)("command", json!({ "cmd": cmd })); }
}
