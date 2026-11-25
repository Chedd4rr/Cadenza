
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

const SCOPES: &[&str] = &[
    "app-remote-control", "playlist-modify", "playlist-modify-private", "playlist-modify-public", "playlist-read",
    "playlist-read-collaborative", "playlist-read-private", "streaming", "ugc-image-upload", "user-follow-modify",
    "user-follow-read", "user-library-modify", "user-library-read", "user-modify", "user-modify-playback-state",
    "user-modify-private", "user-personalized", "user-read-birthdate", "user-read-currently-playing",
    "user-read-email", "user-read-play-history", "user-read-playback-position", "user-read-playback-state",
    "user-read-private", "user-read-recently-played", "user-top-read",
];

pub struct Config {
    pub name: String,
    pub cache: PathBuf,
    pub bitrate: String,
    /// 0-100.
    pub volume: i64,
    pub normalize: bool,
    pub autoplay: bool,
}

pub struct Hooks {
    pub message: Box<dyn Fn(String) + Send + Sync>,
    pub event: Box<dyn Fn(String) + Send + Sync>,
    pub ended: Box<dyn Fn(String) + Send + Sync>,
}

/// Something to do with the music, straight in the engine.
#[derive(Debug)]
pub enum Direct {
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
    ClearQueue,
}

pub struct Engine {
    spirc: Mutex<Option<Spirc>>,
    player: Mutex<Option<Arc<Player>>>,
    album_in_order: Mutex<bool>,
    stop: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    pipe: Arc<MemPipe>,
}

// MARK: librespot's messages

static MESSAGES: OnceLock<Mutex<Option<mpsc::Sender<String>>>> = OnceLock::new();

static NORMALIZE_TYPE: Mutex<String> = Mutex::new(String::new());
pub fn set_normalize_type(t: &str) { *NORMALIZE_TYPE.lock().unwrap() = t.to_string(); }
fn normalize_type() -> String { NORMALIZE_TYPE.lock().unwrap().clone() }

pub fn is_librespot(target: &str) -> bool { target.starts_with("librespot") }

pub fn message(r: &log::Record) {
    let Some(m) = MESSAGES.get() else { return };
    let Some(tx) = m.lock().unwrap().clone() else { return };
    let at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ");
    let _ = tx.send(format!("[{at} {:<5} {}] {}", r.level(), r.target(), r.args()));
}

// MARK: starting and stopping

impl Engine {
    pub fn start(cfg: Config, pipe: Arc<MemPipe>, hooks: Hooks) -> Arc<Engine> {
        let hooks = Arc::new(hooks);
        librespot_connect::HOLD_ON_UNAVAILABLE.store(true, std::sync::atomic::Ordering::Relaxed);
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let me = Arc::new(Engine { spirc: Mutex::new(None), player: Mutex::new(None), album_in_order: Mutex::new(false), stop: Mutex::new(Some(stop_tx)), pipe: pipe.clone() });

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
            rt.shutdown_timeout(Duration::from_secs(2));
            (hooks.ended)(why);
        }).ok();
        me
    }

    pub fn stop(&self) {
        if let Some(tx) = self.stop.lock().unwrap().take() { let _ = tx.send(()); }
        self.pipe.close();
    }

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

    pub fn loudness(&self) {
        let album = match normalize_type().as_str() { "album" => true, "track" => false, _ => *self.album_in_order.lock().unwrap() };
        if let Some(p) = self.player.lock().unwrap().as_ref() { p.set_auto_normalise_as_album(album); }
    }

    async fn run(self: &Arc<Self>, cfg: Config, hooks: Arc<Hooks>, stop: tokio::sync::oneshot::Receiver<()>) -> String {
        let say = |s: String| (hooks.message)(s);
        let _ = std::fs::create_dir_all(&cfg.cache);
        let cache = match Cache::new(Some(cfg.cache.clone()), Some(cfg.cache.clone()), Some(cfg.cache.join("files")), Some(AUDIO_CACHE_LIMIT)) {
            Ok(c) => c,
            Err(e) => return format!("couldn't open its folder: {e}"),
        };
        let _ = cfg.autoplay;
        let session_config = SessionConfig { device_id: device_id(&cfg.name), autoplay: Some(false), ..SessionConfig::default() };

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

pub fn device_id(name: &str) -> String {
    use sha1::Digest;
    sha1::Sha1::digest(name.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

// MARK: the sound

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
