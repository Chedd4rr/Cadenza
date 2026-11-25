//! The built-in engine: librespot running inside Cadenza instead of as a separate program.
//!
//! It's the same librespot (same version, same patches, built from librespot-src/ by librespot.sh), set up
//! the way Cadenza used to start the program: the same device name and ID, so Spotify sees the same
//! "Cadenza" speaker; the same login (credentials.json in the same folder); the same volume curve and
//! loudness settings. Spotify Connect stays on, so your phone still sees Cadenza and can control it.
//!
//! What's different is how the sound and the news get out. The sound goes straight into Cadenza's engine
//! through memory (MemPipe) instead of an operating-system pipe, and librespot's events and messages are
//! handed over directly instead of through a script and a file. librespot.rs reads them exactly as it read
//! the program's, so everything built on them (recovery, crossfade timing, history) works the same.
//!
//! Cadenza also plays, pauses, skips, seeks and queues through it directly (`Direct`), instead of asking
//! Spotify's web interface to tell the engine. That takes effect at once, and Spotify's rules for its web
//! interface (like refusing plain lists of songs) don't apply.

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use librespot_connect::{ConnectConfig, LoadContextOptions, LoadRequest, LoadRequestOptions, Options, PlayingTrack, Spirc};
use librespot_core::{authentication::Credentials, cache::Cache, config::DeviceType, session::Session, SessionConfig, SpotifyUri};
use librespot_playback::audio_backend::{Sink, SinkError, SinkResult};
use librespot_playback::config::{Bitrate, PlayerConfig, VolumeCtrl};
use librespot_playback::convert::Converter;
use librespot_playback::decoder::AudioPacket;
use librespot_playback::mixer::{softmixer::SoftMixer, Mixer, MixerConfig};
use librespot_playback::player::{Player, PlayerEvent};
use librespot_metadata::audio::UniqueFields;

use crate::sound::MemPipe;

/// How much space downloaded songs may take (librespot/files).
const AUDIO_CACHE_LIMIT: u64 = 1024 * 1024 * 1024;

/// The scopes the librespot program asks for when you sign in (its OAUTH_SCOPES), so a login made by
/// either works for both.
const SCOPES: &[&str] = &[
    "app-remote-control", "playlist-modify", "playlist-modify-private", "playlist-modify-public", "playlist-read",
    "playlist-read-collaborative", "playlist-read-private", "streaming", "ugc-image-upload", "user-follow-modify",
    "user-follow-read", "user-library-modify", "user-library-read", "user-modify", "user-modify-playback-state",
    "user-modify-private", "user-personalized", "user-read-birthdate", "user-read-currently-playing",
    "user-read-email", "user-read-play-history", "user-read-playback-position", "user-read-playback-state",
    "user-read-private", "user-read-recently-played", "user-top-read",
];

/// How Cadenza wants the engine set up (the same things it used to pass the program on its command line).
pub struct Config {
    pub name: String,
    pub cache: PathBuf,
    pub bitrate: String,
    /// 0-100.
    pub volume: i64,
    pub normalize: bool,
    pub autoplay: bool,
}

/// What the engine tells librespot.rs: its messages (the lines the program printed), its player events
/// (the same tab-separated lines the event script wrote), and that it stopped.
pub struct Hooks {
    pub message: Box<dyn Fn(String) + Send + Sync>,
    pub event: Box<dyn Fn(String) + Send + Sync>,
    pub ended: Box<dyn Fn(String) + Send + Sync>,
}

/// Something to do with the music, straight in the engine.
#[derive(Debug)]
pub enum Direct {
    /// Play a list of songs, or a playlist or album (`context`), from one of its songs (`from`: a URI, or
    /// a place in the list) and a spot in it (`position` ms). Takes playback over from another device.
    /// `take_over`: another device is playing, so become the one playing first.
    Load { tracks: Vec<String>, context: Option<String>, from_uri: Option<String>, from_index: Option<u32>, position: u32, play: bool, shuffle: bool, repeat: String, take_over: bool },
    Play,
    Pause,
    /// Skip this many songs ahead.
    Next(u32),
    Previous,
    Seek(u32),
    /// 0-100.
    Volume(u32),
    Shuffle(bool),
    /// "off", "context" or "track".
    Repeat(String),
    Queue(String),
    /// Take every song Cadenza queued back out (a new list starts; or the line-up changed).
    ClearQueue,
}

pub struct Engine {
    spirc: Mutex<Option<Spirc>>,
    /// The player, to tell it whether to level loudness per album (see `loudness`).
    player: Mutex<Option<Arc<Player>>>,
    /// What's playing: an album, in order (not shuffled). Album loudness on "auto" follows it.
    album_in_order: Mutex<bool>,
    stop: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    pipe: Arc<MemPipe>,
}

// MARK: librespot's messages

/// librespot writes its messages through the `log` crate; Cadenza's logger (main.rs) hands the ones from
/// librespot here, and this passes them on to whichever engine is running.
static MESSAGES: OnceLock<Mutex<Option<mpsc::Sender<String>>>> = OnceLock::new();

/// The loudness setting ("auto", "track" or "album"), set by librespot.rs from Cadenza's settings.
static NORMALIZE_TYPE: Mutex<String> = Mutex::new(String::new());
pub fn set_normalize_type(t: &str) { *NORMALIZE_TYPE.lock().unwrap() = t.to_string(); }
fn normalize_type() -> String { NORMALIZE_TYPE.lock().unwrap().clone() }

pub fn is_librespot(target: &str) -> bool { target.starts_with("librespot") }

/// Called by the logger for each of librespot's messages. Formatted like the program printed them.
pub fn message(r: &log::Record) {
    let Some(m) = MESSAGES.get() else { return };
    let Some(tx) = m.lock().unwrap().clone() else { return };
    let at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ");
    let _ = tx.send(format!("[{at} {:<5} {}] {}", r.level(), r.target(), r.args()));
}

// MARK: starting and stopping

impl Engine {
    /// Starts the engine on its own thread. The sound comes out of `pipe`.
    pub fn start(cfg: Config, pipe: Arc<MemPipe>, hooks: Hooks) -> Arc<Engine> {
        let hooks = Arc::new(hooks);
        // A song Spotify won't play pauses the music instead of librespot skipping on (and on): Cadenza
        // waits a moment and moves on itself (see librespot.rs). Cadenza's patch to librespot.
        librespot_connect::HOLD_ON_UNAVAILABLE.store(true, std::sync::atomic::Ordering::Relaxed);
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let me = Arc::new(Engine { spirc: Mutex::new(None), player: Mutex::new(None), album_in_order: Mutex::new(false), stop: Mutex::new(Some(stop_tx)), pipe: pipe.clone() });

        // Messages and events are passed on from threads of their own, so whatever librespot.rs does
        // with them (even restarting this engine) never runs inside librespot.
        let (msg_tx, msg_rx) = mpsc::channel::<String>();
        *MESSAGES.get_or_init(|| Mutex::new(None)).lock().unwrap() = Some(msg_tx);
        let h = hooks.clone();
        std::thread::Builder::new().name("cadenza-engine-messages".into()).spawn(move || {
            for line in msg_rx { (h.message)(line); }
        }).ok();

        let me2 = me.clone();
        std::thread::Builder::new().name("cadenza-engine".into()).spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_name("cadenza-engine-rt").enable_all().build() {
                Ok(rt) => rt,
                Err(e) => return (hooks.ended)(format!("couldn't start: {e}")),
            };
            let why = rt.block_on(me2.run(cfg, hooks.clone(), stop_rx));
            *me2.spirc.lock().unwrap() = None;
            me2.pipe.close();
            // Give librespot's own tasks a moment to finish, then let them go.
            rt.shutdown_timeout(Duration::from_secs(2));
            (hooks.ended)(why);
        }).ok();
        me
    }

    /// Stops the engine. Returns straight away; `ended` is called once it has stopped.
    pub fn stop(&self) {
        if let Some(tx) = self.stop.lock().unwrap().take() { let _ = tx.send(()); }
        self.pipe.close();
    }

    /// Does `d` in the engine. Err when the engine isn't connected yet or librespot turns it down. (Most
    /// things only work while Cadenza is the device playing; librespot.rs checks that first.)
    pub fn direct(&self, d: Direct) -> Result<(), String> {
        let guard = self.spirc.lock().unwrap();
        let Some(spirc) = guard.as_ref() else { return Err("the engine isn't connected yet".into()) };
        let r = match d {
            Direct::Load { tracks, context, from_uri, from_index, position, play, shuffle, repeat, take_over } => {
                let options = LoadRequestOptions {
                    start_playing: play,
                    seek_to: position,
                    context_options: Some(LoadContextOptions::Options(Options { shuffle, repeat: repeat == "context", repeat_track: repeat == "track" })),
                    playing_track: from_uri.map(PlayingTrack::Uri).or(from_index.map(PlayingTrack::Index)),
                };
                *self.album_in_order.lock().unwrap() = !shuffle && context.as_deref().map_or(false, |c| c.starts_with("spotify:album:"));
                self.loudness();
                let req = match context { Some(c) => LoadRequest::from_context_uri(c, options), None => LoadRequest::from_tracks(tracks, options) };
                // Taking over from another device first (librespot ignores a load while it isn't the one playing).
                if take_over { let _ = spirc.activate(); }
                spirc.load(req)
            }
            Direct::Play => spirc.play(),
            Direct::Pause => spirc.pause(),
            Direct::Next(n) => (0..n.max(1)).try_for_each(|_| spirc.next()),
            Direct::Previous => spirc.prev(),
            Direct::Seek(ms) => spirc.set_position_ms(ms),
            Direct::Volume(v) => spirc.set_volume((v.min(100) as f32 / 100.0 * VolumeCtrl::MAX_VOLUME as f32) as u16),
            Direct::Shuffle(on) => {
                if on { *self.album_in_order.lock().unwrap() = false; self.loudness(); }
                spirc.shuffle(on)
            }
            Direct::Repeat(r) => spirc.repeat(r == "context").and_then(|_| spirc.repeat_track(r == "track")),
            Direct::ClearQueue => spirc.clear_queue(),
            Direct::Queue(uri) => match SpotifyUri::from_uri(&uri) {
                Ok(u) => spirc.add_to_queue(u),
                Err(e) => return Err(format!("not a song: {e}")),
            },
        };
        r.map_err(|e| e.to_string())
    }

    /// Loudness levelling per song or per album (an album's own quiet and loud songs stay as mastered):
    /// "track", "album", or "auto" (per album while an album plays in order). Takes effect from the next song.
    pub fn loudness(&self) {
        let album = match normalize_type().as_str() { "album" => true, "track" => false, _ => *self.album_in_order.lock().unwrap() };
        if let Some(p) = self.player.lock().unwrap().as_ref() { p.set_auto_normalise_as_album(album); }
    }

    async fn run(self: &Arc<Self>, cfg: Config, hooks: Arc<Hooks>, stop: tokio::sync::oneshot::Receiver<()>) -> String {
        let say = |s: String| (hooks.message)(s);
        let _ = std::fs::create_dir_all(&cfg.cache);
        // Songs librespot has downloaded are kept in files/ so replays don't download again. Without a limit
        // that folder only grows; 1 GB holds a hundred or so songs, and the oldest-used go first (also when
        // it starts, so a folder that grew before this limit shrinks once).
        let cache = match Cache::new(Some(cfg.cache.clone()), Some(cfg.cache.clone()), Some(cfg.cache.join("files")), Some(AUDIO_CACHE_LIMIT)) {
            Ok(c) => c,
            Err(e) => return format!("couldn't open its folder: {e}"),
        };
        // Spotify's own autoplay stays off: Cadenza's autoplay takes over when anything runs out (Radio in
        // app.js), and librespot's attempts at it after a list of songs only got "400 Bad Request" back.
        let _ = cfg.autoplay;
        let session_config = SessionConfig { device_id: device_id(&cfg.name), autoplay: Some(false), ..SessionConfig::default() };

        // Your login from before (made by either engine), or sign in now in the browser.
        let credentials = match cache.credentials() {
            Some(c) => c,
            None => {
                say("No login yet: opening Spotify's sign-in page in your browser.".into());
                let client = librespot_oauth::OAuthClientBuilder::new(&session_config.client_id, "http://127.0.0.1:5588/login", SCOPES.to_vec())
                    .open_in_browser()
                    .build();
                let token = match client { Ok(c) => c.get_access_token_async().await, Err(e) => Err(e) };
                match token {
                    Ok(t) => Credentials::with_access_token(t.access_token),
                    Err(e) => return format!("authentication failed: {e}"),
                }
            }
        };

        let mixer: Arc<dyn Mixer> = match SoftMixer::open(MixerConfig { volume_ctrl: VolumeCtrl::Log(30.0), ..MixerConfig::default() }) {
            Ok(m) => Arc::new(m),
            Err(e) => return format!("couldn't set up the volume: {e}"),
        };
        let player_config = PlayerConfig {
            bitrate: cfg.bitrate.parse::<Bitrate>().unwrap_or_default(),
            normalisation: cfg.normalize,
            normalisation_pregain_db: if cfg.normalize { 3.0 } else { 0.0 },
            ..PlayerConfig::default()
        };
        let session = Session::new(session_config, Some(cache));
        let pipe = self.pipe.clone();
        let player = Player::new(player_config, session.clone(), mixer.get_soft_volume(), move || {
            Box::new(PipeSink { pipe }) as Box<dyn Sink>
        });
        *self.player.lock().unwrap() = Some(player.clone());
        self.loudness();

        // Player events, as the lines the event script used to write.
        let mut events = player.get_player_event_channel();
        let h = hooks.clone();
        std::thread::Builder::new().name("cadenza-engine-events".into()).spawn(move || {
            while let Some(e) = events.blocking_recv() {
                if let Some(line) = event_line(e) { (h.event)(line); }
            }
        }).ok();

        let connect_config = ConnectConfig {
            name: cfg.name.clone(),
            device_type: DeviceType::Speaker,
            initial_volume: (cfg.volume.clamp(0, 100) as f32 / 100.0 * VolumeCtrl::MAX_VOLUME as f32) as u16,
            ..ConnectConfig::default()
        };
        let (spirc, task) = match Spirc::new(connect_config, session.clone(), credentials, player, mixer).await {
            Ok(x) => x,
            Err(e) => return format!("could not initialize spirc: {e}"),
        };
        *self.spirc.lock().unwrap() = Some(spirc);
        say("The built-in engine is ready.".into());

        tokio::pin!(task);
        tokio::select! {
            _ = &mut task => "Spirc shut down unexpectedly".into(),
            _ = stop => {
                if let Some(s) = self.spirc.lock().unwrap().as_ref() { let _ = s.shutdown(); }
                let _ = tokio::time::timeout(Duration::from_secs(3), task).await;
                if !session.is_invalid() { session.shutdown(); }
                String::new()
            }
        }
    }
}

/// Spotify knows a speaker by this ID. The librespot program makes it from the name the same way, so the
/// built-in engine is the same "Cadenza" to Spotify (and to your phone).
pub fn device_id(name: &str) -> String {
    use sha1::Digest;
    sha1::Sha1::digest(name.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

// MARK: the sound

/// librespot's sound goes into the MemPipe as 16-bit stereo, exactly what the program wrote to its pipe.
struct PipeSink { pipe: Arc<MemPipe> }

impl Sink for PipeSink {
    fn write(&mut self, packet: AudioPacket, converter: &mut Converter) -> SinkResult<()> {
        let bytes: Vec<u8> = match packet {
            AudioPacket::Samples(s) => converter.f64_to_s16(&s).iter().flat_map(|v| v.to_le_bytes()).collect(),
            AudioPacket::Raw(b) => b,
        };
        if self.pipe.write(&bytes) { Ok(()) } else { Err(SinkError::OnWrite("the engine is stopping".into())) }
    }
}

// MARK: events

/// One player event as the line the old event script wrote: event, uri, track id, name, artists, album,
/// covers, duration, position, volume, shuffle/repeat, time.
fn event_line(e: PlayerEvent) -> Option<String> {
    let clean = |s: &str| s.replace(['\t', '\n'], " ");
    let mut f: [String; 12] = Default::default();
    match e {
        PlayerEvent::PlayRequestIdChanged { .. } => f[0] = "play_request_id_changed".into(),
        PlayerEvent::TrackChanged { audio_item } => {
            f[0] = "track_changed".into();
            f[1] = audio_item.uri.clone();
            f[2] = audio_item.track_id.to_id();
            f[3] = clean(&audio_item.name);
            f[6] = audio_item.covers.iter().map(|c| c.url.clone()).collect::<Vec<_>>().join("|");
            f[7] = audio_item.duration_ms.to_string();
            match &audio_item.unique_fields {
                UniqueFields::Track { artists, album, .. } => {
                    f[4] = artists.0.iter().map(|a| clean(&a.name)).collect::<Vec<_>>().join("|");
                    f[5] = clean(album);
                }
                UniqueFields::Local { artists, album, .. } => {
                    f[4] = clean(artists.as_deref().unwrap_or(""));
                    f[5] = clean(album.as_deref().unwrap_or(""));
                }
                UniqueFields::Episode { show_name, .. } => { f[4] = clean(show_name); f[5] = clean(show_name); }
            }
        }
        PlayerEvent::Stopped { track_id, .. } => { f[0] = "stopped".into(); f[2] = track_id.to_id(); }
        PlayerEvent::Playing { track_id, position_ms, .. } => { f[0] = "playing".into(); f[2] = track_id.to_id(); f[8] = position_ms.to_string(); }
        PlayerEvent::Paused { track_id, position_ms, .. } => { f[0] = "paused".into(); f[2] = track_id.to_id(); f[8] = position_ms.to_string(); }
        PlayerEvent::Loading { track_id, .. } => { f[0] = "loading".into(); f[2] = track_id.to_id(); }
        PlayerEvent::Preloading { track_id } => { f[0] = "preloading".into(); f[2] = track_id.to_id(); }
        PlayerEvent::TimeToPreloadNextTrack { track_id, .. } => { f[0] = "preload_next".into(); f[2] = track_id.to_id(); }
        PlayerEvent::EndOfTrack { track_id, .. } => { f[0] = "end_of_track".into(); f[2] = track_id.to_id(); }
        PlayerEvent::Unavailable { track_id, .. } => {
            f[0] = "unavailable".into(); f[2] = track_id.to_id();
            f[1] = track_id.to_uri();
        }
        PlayerEvent::VolumeChanged { volume } => { f[0] = "volume_changed".into(); f[9] = volume.to_string(); }
        PlayerEvent::Seeked { track_id, position_ms, .. } => { f[0] = "seeked".into(); f[2] = track_id.to_id(); f[8] = position_ms.to_string(); }
        PlayerEvent::PositionCorrection { track_id, position_ms, .. } => { f[0] = "position_correction".into(); f[2] = track_id.to_id(); f[8] = position_ms.to_string(); }
        PlayerEvent::SessionConnected { .. } => f[0] = "session_connected".into(),
        PlayerEvent::SessionDisconnected { .. } => f[0] = "session_disconnected".into(),
        PlayerEvent::SessionClientChanged { .. } => f[0] = "session_client_changed".into(),
        PlayerEvent::ShuffleChanged { .. } => f[0] = "shuffle_changed".into(),
        PlayerEvent::RepeatChanged { .. } => f[0] = "repeat_changed".into(),
        PlayerEvent::AutoPlayChanged { .. } => f[0] = "auto_play_changed".into(),
        PlayerEvent::FilterExplicitContentChanged { .. } => f[0] = "filter_explicit_content_changed".into(),
        PlayerEvent::PositionChanged { .. } | PlayerEvent::SetQueue { .. } => return None,
    }
    f[11] = chrono::Local::now().format("%H:%M:%S").to_string();
    Some(f.join("\t"))
}
