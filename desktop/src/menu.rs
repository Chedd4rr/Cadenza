
use serde_json::json;
use std::sync::Arc;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};

const CONTROLS: &[(&str, &str, &str)] = &[
    ("Play / Pause", "toggle", "toggle"),
    ("Next Song", "next", "next"),
    ("Previous Song", "previous", "previous"),
    ("Shuffle", "shuffle", "shuffle"),
    ("Repeat", "repeat", "repeat"),
    ("Like Song", "like", "like"),
    ("-", "", ""),
    ("Stage Mode", "stage", "stage"),
    ("Floating Mini Player", "mini", "mini"),
    ("Command Palette…", "palette", "palette"),
    ("Search", "search", "search"),
    ("Switch Theme", "theme", "theme"),
    ("-", "", ""),
    ("Home", "go:home", ""),
    ("Library", "go:library", ""),
    ("Queue", "go:queue", ""),
    ("History", "go:history", ""),
    ("Listening Stats", "go:stats", ""),
    ("Friends", "go:friends", ""),
    ("EQ", "go:eq", ""),
    ("DJ", "go:dj", ""),
    ("System", "go:system", "system"),
    ("Keyboard Shortcuts", "go:commands", "commands"),
    ("-", "", ""),
    ("Check for Updates…", "update", ""),
];

pub fn build(app: &AppHandle, plain: bool) -> tauri::Result<Menu<Wry>> {
    let settings = app.try_state::<Arc<crate::Core>>().map(|c| c.settings.clone());
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
    for (title, cmd, id) in CONTROLS {
        if *title == "-" { controls.append(&PredefinedMenuItem::separator(app)?)?; continue; }
        let combo = match (&settings, id.is_empty()) { (Some(s), false) => crate::shortcuts::get(s, id), _ => String::new() };
        let in_menu = !plain && !matches!(*cmd, "next" | "previous") && crate::shortcuts::has_command_key(&combo);
        let accel = if in_menu { crate::shortcuts::accelerator(&combo) } else { None };
        let title = if accel.is_none() && !combo.is_empty() { format!("{title}    ({})", crate::shortcuts::label(&combo)) } else { title.to_string() };
        controls.append(&MenuItem::with_id(app, format!("cmd:{cmd}"), title, true, accel.as_deref())?)?;
    }
    let window = Submenu::with_items(app, "Window", true, &[
        &PredefinedMenuItem::minimize(app, None)?,
        &PredefinedMenuItem::close_window(app, None)?,
        &PredefinedMenuItem::fullscreen(app, None)?,
    ])?;
    Menu::with_items(app, &[&cadenza, &edit, &controls, &window])
}

pub fn picked(app: &AppHandle, id: &str) {
    let Some(cmd) = id.strip_prefix("cmd:") else { return };
    let Some(sys) = app.try_state::<Arc<crate::system::System>>() else { return };
    if cmd == "mini" { sys.toggle_mini(); return; }
    let visible = app.get_webview_window("main").and_then(|w| w.is_visible().ok()).unwrap_or(false);
    if !visible { sys.show_main(); }
    if let Some(core) = app.try_state::<Arc<crate::Core>>() { (core.emit)("command", json!({ "cmd": cmd })); }
}
