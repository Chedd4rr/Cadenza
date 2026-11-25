//! The signal path: what happens to the sound on its way from Spotify's file to your speakers, one line per
//! step, and a plain verdict on whether anything changes it. The page shows it (EQ page, key P, and System →
//! Sound & EQ). It only reports; nothing here changes how the music plays.

use serde_json::{json, Value};

use crate::librespot::SongPath;
use crate::settings::Settings;
use crate::sound::{PathInfo, RATE};

pub struct Input<'a> {
    /// The song playing in the built-in engine (None before the first song).
    pub song: Option<SongPath>,
    /// Cadenza is the device playing right now (not your phone, say).
    pub here: bool,
    pub settings: &'a Settings,
    pub out: PathInfo,
    /// The rate the Mac's output device itself runs at (macOS only).
    pub device_rate: Option<f64>,
}

struct Stage { id: &'static str, label: &'static str, value: String, note: String, changes: bool }

fn stage(id: &'static str, label: &'static str, value: impl Into<String>, note: impl Into<String>, changes: bool) -> Stage {
    Stage { id, label, value: value.into(), note: note.into(), changes }
}

/// "OGG_VORBIS_320" → "Ogg Vorbis 320 kbps".
pub fn file_name(format: &str) -> String {
    let (family, rate) = match format.rsplit_once('_') {
        Some((f, r)) if r.chars().all(|c| c.is_ascii_digit()) && !r.is_empty() => (f, Some(r)),
        _ => (format, None),
    };
    let name = match family {
        "OGG_VORBIS" => "Ogg Vorbis".to_string(),
        "MP3" => "MP3".to_string(),
        "AAC" => "AAC".to_string(),
        "MP4" => "MP4".to_string(),
        "FLAC" | "FLAC_FLAC" => return "FLAC (lossless)".to_string(),
        other => other.replace('_', " "),
    };
    match rate { Some(r) => format!("{name} {r} kbps"), None => name }
}

fn bits(format: &str) -> &'static str {
    match format { "F32" => "32-bit float", "I16" | "U16" => "16-bit", "I32" => "32-bit", _ => "" }
}

fn khz(hz: f64) -> String {
    let k = hz / 1000.0;
    if (k - k.round()).abs() < 0.001 { format!("{} kHz", k as i64) } else { format!("{k:.1} kHz") }
}

pub fn build(i: Input) -> Value {
    let mut stages: Vec<Stage> = vec![];
    let want = i.settings.bitrate();

    // 1. The file
    stages.push(match i.song.as_ref().filter(|s| !s.format.is_empty()) {
        Some(s) => stage("source", "Source", file_name(&s.format),
            "The file Spotify sends. Spotify doesn't give lossless to apps like Cadenza.", false),
        None => stage("source", "Source", format!("Up to {want} kbps Ogg Vorbis"),
            "The exact file shows once a song has started.", false),
    });

    // 2. Loudness
    if i.settings.bool("normalize") {
        match i.song.as_ref().and_then(|s| s.loudness_db) {
            Some(db) => stages.push(stage("loudness", "Loudness",
                format!("{db:+.1} dB {}", if i.song.as_ref().map_or(false, |s| s.album) { "for this album (its songs keep their own levels)" } else { "for this song" }),
                "Evens out loud and quiet songs. Off in System → Sound & EQ.", db.abs() >= 0.05)),
            None => stages.push(stage("loudness", "Loudness", "On", "Evens out loud and quiet songs. Off in System → Sound & EQ.", true)),
        }
    } else {
        stages.push(stage("loudness", "Loudness", "Off", "Every song plays at the level it was mastered at.", false));
    }

    // 3. Volume
    let vol = i.settings.volume();
    stages.push(stage("volume", "Volume", format!("{vol}%"),
        "Cadenza's own volume, applied digitally before the output. At 100% it changes nothing.", vol < 100));

    // 4. EQ
    stages.push(if i.out.eq_active {
        stage("eq", "EQ", format!("On{}: {}, boost {:+.1} dB", if i.out.eq_parametric { " (parametric)" } else { "" }, i.out.eq_preset, i.out.eq_preamp), "Changes the tone, per output device.", true)
    } else if i.out.eq_on {
        stage("eq", "EQ", "On, set flat", "Nothing is raised or lowered, so the sound passes through.", false)
    } else {
        stage("eq", "EQ", "Off", "", false)
    });

    // 5. Limiter
    stages.push(stage("limiter", "Limiter", "Standing by", "Only steps in if the sound would clip, which the EQ's boost can cause.", false));

    // 6. Crossfade
    stages.push(if i.out.crossfade_secs > 0 {
        stage("crossfade", "Crossfade", format!("{} s between songs", i.out.crossfade_secs), "Blends the end of one song into the start of the next.", true)
    } else {
        stage("crossfade", "Crossfade", "Off", "", false)
    });

    // 6b. Channels
    let c = i.out.chan;
    if !c.neutral() {
        let mut parts = vec![];
        if c.balance != 0.0 { parts.push(format!("balance {} {:.0}%", if c.balance < 0.0 { "left" } else { "right" }, c.balance.abs() * 100.0)); }
        if c.mono { parts.push("mono".to_string()); }
        if c.swap { parts.push("left and right swapped".to_string()); }
        if c.invert { parts.push("polarity flipped".to_string()); }
        stages.push(stage("channels", "Channels", parts.join(", "), "System → Sound & EQ → Channels.", c.balance != 0.0 || c.mono || c.swap));
    }

    // 7. Rate conversion by Cadenza
    stages.push(if i.out.rate != 0 && i.out.rate != RATE {
        stage("rate", "Rate conversion", format!("{} → {}", khz(RATE as f64), khz(i.out.rate as f64)),
            "Cadenza converts the sound because this output didn't accept 44.1 kHz. It's a simple conversion.", true)
    } else {
        stage("rate", "Rate conversion", "None needed", "Spotify's 44.1 kHz goes to the output as it is.", false)
    });

    // 8. The output
    let fmt = bits(&i.out.format);
    let mut out_parts = vec![if i.out.device.is_empty() { "Default output".to_string() } else { i.out.device.clone() }];
    if i.out.rate != 0 { out_parts.push(khz(i.out.rate as f64)); }
    if !fmt.is_empty() { out_parts.push(fmt.to_string()); }
    if i.out.exclusive { out_parts.push("exclusive".to_string()); }
    stages.push(stage("output", "Output", out_parts.join(" · "),
        if i.out.exclusive { "Cadenza has this output to itself: no other app's sound is mixed in." } else { "What Cadenza sends to the system." }, false));

    // 9. The device itself (Mac)
    if let Some(r) = i.device_rate {
        let differs = i.out.rate != 0 && (r - i.out.rate as f64).abs() > 1.0;
        stages.push(if differs {
            stage("device", "Device", format!("Runs at {}", khz(r)),
                "macOS converts the sound to this. Turn on \"Match output rate\" in System → Sound & EQ (or set 44.1 kHz in Audio MIDI Setup).", true)
        } else {
            stage("device", "Device", format!("Runs at {}", khz(r)),
                if i.out.rate_matched { "Cadenza set it to 44.1 kHz, so macOS has nothing to convert. It goes back when Cadenza quits." } else { "Matches, so macOS has nothing to convert." }, false)
        });
    }

    let changed: Vec<&str> = stages.iter().filter(|s| s.changes).map(|s| match s.id {
        "loudness" => "loudness", "volume" => "volume", "eq" => "EQ", "crossfade" => "crossfade", "channels" => "channels",
        "rate" => "rate conversion", "device" => "the device's rate", _ => "",
    }).filter(|n| !n.is_empty()).collect();
    let (verdict, summary) = if changed.is_empty() {
        ("unchanged", "Nothing changes the sound: it reaches the output as Spotify sent it.".to_string())
    } else {
        ("changed", format!("Changed by: {}.", changed.join(", ")))
    };

    json!({
        "here": i.here,
        "verdict": verdict,
        "summary": summary,
        "stages": stages.iter().map(|s| json!({"id": s.id, "label": s.label, "value": s.value, "note": s.note, "changes": s.changes})).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_get_plain_names() {
        assert_eq!(file_name("OGG_VORBIS_320"), "Ogg Vorbis 320 kbps");
        assert_eq!(file_name("OGG_VORBIS_96"), "Ogg Vorbis 96 kbps");
        assert_eq!(file_name("MP3_256"), "MP3 256 kbps");
        assert_eq!(file_name("AAC_160"), "AAC 160 kbps");
        assert_eq!(file_name("FLAC_FLAC"), "FLAC (lossless)");
        assert_eq!(file_name("SOMETHING_NEW"), "SOMETHING NEW");
    }

    #[test]
    fn rates_read_naturally() {
        assert_eq!(khz(44100.0), "44.1 kHz");
        assert_eq!(khz(48000.0), "48 kHz");
        assert_eq!(khz(96000.0), "96 kHz");
    }
}
