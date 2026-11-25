
use serde_json::Value;

use crate::settings::Settings;

const DEFAULTS: &[(&str, &str)] = &[
    ("toggle", "Space"), ("next", "Meta+ArrowRight"), ("previous", "Meta+ArrowLeft"), ("like", "L"),
    ("shuffle", "Meta+S"), ("repeat", "Meta+R"), ("stage", "Meta+Shift+F"), ("mini", "Meta+Shift+M"),
    ("palette", "Meta+K"), ("search", "Meta+F"), ("theme", "Meta+T"), ("system", "Meta+,"), ("commands", "Meta+/"),
    ("showHide", "Meta+Alt+P"),
];

/// Your shortcut for this action ("" for none).
pub fn get(settings: &Settings, id: &str) -> String {
    let saved = settings.get("shortcuts");
    if let Some(v) = saved.get(id).and_then(Value::as_str) { return v.to_string(); }
    DEFAULTS.iter().find(|(k, _)| *k == id).map(|(_, v)| v.to_string()).unwrap_or_default()
}

pub fn has_command_key(combo: &str) -> bool {
    combo.split('+').rev().skip(1).any(|m| m == "Meta" || m == "Ctrl")
}

pub fn accelerator(combo: &str) -> Option<String> {
    let parts: Vec<&str> = combo.split('+').collect();
    let (key, mods) = parts.split_last()?;
    if key.is_empty() { return None; }
    let mut out: Vec<String> = mods.iter().map(|m| match *m {
        "Meta" => "CmdOrCtrl",
        "Ctrl" => if cfg!(target_os = "macos") { "Ctrl" } else { "Super" },
        "Alt" => "Alt",
        "Shift" => "Shift",
        other => other,
    }.to_string()).collect();
    out.push(key.to_string());
    Some(out.join("+"))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn label(combo: &str) -> String {
    if combo.is_empty() { return String::new(); }
    let parts: Vec<&str> = combo.split('+').collect();
    let Some((key, mods)) = parts.split_last() else { return String::new() };
    let mut out = String::new();
    // In the order macOS shows them.
    for (m, sym) in [("Ctrl", "⌃"), ("Alt", "⌥"), ("Shift", "⇧"), ("Meta", "⌘")] { if mods.contains(&m) { out.push_str(sym); } }
    out.push_str(match *key { "ArrowRight" => "→", "ArrowLeft" => "←", "ArrowUp" => "↑", "ArrowDown" => "↓", k => k });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn forms() {
        assert_eq!(accelerator("Meta+Shift+F").as_deref(), Some("CmdOrCtrl+Shift+F"));
        assert_eq!(accelerator("Meta+,").as_deref(), Some("CmdOrCtrl+,"));
        assert_eq!(accelerator("Space").as_deref(), Some("Space"));
        assert_eq!(label("Meta+Shift+F"), "⇧⌘F");
        assert_eq!(label("Meta+ArrowRight"), "⌘→");
        assert!(has_command_key("Meta+K") && !has_command_key("L") && !has_command_key("Shift+L"));
    }
}
