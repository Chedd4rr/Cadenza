//! Cadenza's own sound engine. librespot (built in, see embedded.rs) hands over its decoded sound (16-bit
//! stereo at 44.1 kHz, through memory: MemPipe), and Cadenza plays it through a 10-band EQ, a preamp and a peak
//! limiter, with:
//! - a crossfade between songs, by reading the end of a song ahead of time and playing the next song's
//!   start over it on a second voice (equal-power curves, so the loudness stays even);
//! - pause, play, skip and seek that respond at once, before Spotify confirms (a short fade, no click);
//! - the sleep timer's fade and smooth song transitions;
//! - live levels for the visualizer and the EQ meters.
//!
//! Every fade is worked out sample by sample, not by timers changing volumes. The output is opened with cpal (CoreAudio, WASAPI, PipeWire/ALSA),
//! reopened if it stops working, and given a bigger buffer if it can't keep up.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::dsp::{self, Channels, Curve, Eq, Filter, Kind, Limiter, Ramp, Tone};
use crate::librespot::Emit;
use crate::settings::Settings;

pub const RATE: u32 = 44_100;
/// The output's own buffer, in frames: about 45 ms to start with. If the output keeps falling behind (a
/// slow computer or a virtual machine), it's doubled, up to about 190 ms.
const BUFFER_FRAMES: u32 = 2048;
const BUFFER_FRAMES_MAX: u32 = 8192;
/// How much of librespot's sound waits in the engine, in frames (about 93 ms): short,
/// so pause and skip feel instant, and because librespot only writes as fast as this is used, it keeps
/// librespot playing in real time.
const QUEUE_FRAMES: usize = 4096;
/// After this long with no music, the output rests (see output_thread). CADENZA_REST_SECS changes it, for testing.
const REST_AFTER_MS: u64 = 3 * 60 * 1000;
fn rest_after_ms() -> u64 {
    static MS: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *MS.get_or_init(|| std::env::var("CADENZA_REST_SECS").ok().and_then(|v| v.parse::<u64>().ok()).map_or(REST_AFTER_MS, |s| s * 1000))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
fn secs(frames: i64) -> String { format!("{:.1} s", frames as f64 / RATE as f64) }

// MARK: the engine's state (shared by the reader, the output and the controls; held only briefly)

struct State {
    /// Two voices, so the end of one song can overlap the start of the next. `cur` plays the current song.
    voices: [VecDeque<(f32, f32)>; 2],
    cur: usize,
    /// A crossfade in progress: 0 → 1 over its length. The new song (`cur`) comes in on a sine curve while
    /// the old one goes out on a cosine.
    blend: Option<Ramp>,

    // Where songs begin and end in librespot's stream, to know when to start the crossfade.
    stream_frames: i64,
    track_start: i64,
    track_length: i64,
    xf_frames: i64,
    in_tail: bool,
    xf_boundary: i64,
    last_boundary: i64,
    last_boundary_at: Option<Instant>,
    tail_started_at: Instant,
    next_length: i64,
    last_plan_line: String,
    /// Sound still in the pipe from before a skip or seek: dropped as it arrives.
    discard_frames: i64,

    // Pause, skip, seek and transitions: separate volume stages so they never fight.
    fader: Ramp,
    pause_pending: bool,
    holding: bool,
    locally_paused_at: Option<Instant>,
    mute: Ramp,
    skip_until: Option<Instant>,
    unmute_at: Option<Instant>,
    xfade: Ramp,
    sleep_fading: bool,

    eq: Eq,
    limiter: Limiter,
    /// Balance, mono, swap and polarity (System → Sound & EQ → Channels).
    chan: Channels,
    /// A test tone playing instead of the music (the music carries on underneath, unheard).
    tone: Option<Tone>,
    /// The last frame played, so running dry eases out over a couple of milliseconds instead of clicking.
    last: (f32, f32),
    /// The sound's energy just before and just after the EQ, for the sound report (how much the EQ changes it).
    energy_in: f64,
    energy_out: f64,
    logs: Vec<String>,
}

impl State {
    fn new() -> Self {
        State {
            voices: [VecDeque::with_capacity(16384), VecDeque::with_capacity(16384)], cur: 0, blend: None,
            stream_frames: 0, track_start: -1, track_length: 0, xf_frames: 6 * RATE as i64, in_tail: false, xf_boundary: -1,
            last_boundary: -1, last_boundary_at: None, tail_started_at: Instant::now(), next_length: 0, last_plan_line: String::new(),
            discard_frames: 0,
            fader: Ramp::at(1.0), pause_pending: false, holding: false, locally_paused_at: None,
            mute: Ramp::at(1.0), skip_until: None, unmute_at: None, xfade: Ramp::at(1.0), sleep_fading: false,
            eq: Eq::default(), limiter: Limiter::default(), chan: Channels::default(), tone: None, last: (0.0, 0.0), energy_in: 0.0, energy_out: 0.0, logs: vec![],
        }
    }

    fn xlog(&mut self, line: String) { self.logs.push(format!("Crossfade: {line}")); }
    fn other(&self) -> usize { 1 - self.cur }

    /// How much to read next, and whether it's part of an old song's tail (read at once, without waiting).
    /// Reads never run past the start of a crossfade or the end of a song, so a song's end always falls
    /// exactly between two reads.
    fn plan(&mut self) -> (i64, bool) {
        let xf = self.xf_frames;
        if self.in_tail {
            let left = self.xf_boundary - self.stream_frames;
            return (if left > 0 { left.min(1024) } else { 1024 }, true);
        }
        if self.track_start < 0 || self.track_length <= 0 { return (1024, false); }
        let end = self.track_start + self.track_length;
        if self.stream_frames >= end {
            // This song ended without a crossfade (off, or too short): the next one starts here.
            let line = if xf == 0 { "off: next song follows straight on.".to_string() }
                       else { format!("song too short to blend (under {}): next song follows straight on.", secs(xf * 3)) };
            self.xlog(line);
            self.last_boundary = end;
            self.last_boundary_at = Some(Instant::now());
            self.track_start = end;
            self.track_length = 0;
            return (1024, false);
        }
        if xf > 0 && self.track_length > xf * 3 {
            let window = end - xf;
            if self.stream_frames >= window {
                self.in_tail = true;
                self.xf_boundary = end;
                self.tail_started_at = Instant::now();
                self.next_length = 0;
                let left = end - self.stream_frames;
                self.xlog(format!("reading the last {} of the song ahead, for the blend.", secs(left)));
                return (left.min(1024), true);
            }
            return ((window - self.stream_frames).min(1024), false);
        }
        ((end - self.stream_frames).min(1024), false)
    }

    /// Stop a crossfade halfway (a skip, a seek, a new output): only the current song carries on.
    fn abort_blend(&mut self) {
        self.blend = None;
        self.in_tail = false;
        self.xf_boundary = -1;
        let o = self.other();
        self.voices[o].clear();
    }

    /// Throw away the sound already on its way (what's in the pipe and queued here), so a skip or a seek
    /// is heard at once instead of after it.
    fn drop_queued(&mut self, waiting_frames: i64) {
        self.discard_frames = waiting_frames;
        self.abort_blend();
        self.track_start = -1;
        self.track_length = 0;
        self.last_boundary = -1;
        let c = self.cur;
        self.voices[c].clear();
    }

    /// One frame of finished sound, and whether it came from librespot (rather than running dry).
    #[inline]
    fn next_frame(&mut self) -> ((f32, f32), bool) {
        if let Some(t) = self.tone.as_mut() {
            // The tone goes straight to the speakers it names (no balance or swap), so it tells you which is which.
            let v = t.next();
            if t.done() { self.tone = None; }
            let has = if self.holding { false } else { self.music_frame().1 };
            return (v, has);
        }
        let ((l, r), has) = self.music_frame();
        (if self.chan.neutral() { (l, r) } else { self.chan.run(l, r) }, has)
    }

    #[inline]
    fn music_frame(&mut self) -> ((f32, f32), bool) {
        if self.holding { return ((0.0, 0.0), false); }            // paused here: nothing is used up
        let (c, o) = (self.cur, self.other());
        let a = self.voices[c].pop_front();
        // Ran dry (a network hiccup, or the music simply stopped): fade what was playing out over ~2 ms.
        let mut out = a.unwrap_or((self.last.0 * 0.99, self.last.1 * 0.99));
        let mut has = a.is_some();
        if let Some(blend) = &mut self.blend {
            let b = self.voices[o].pop_front();
            has |= b.is_some();
            let (bl, br) = b.unwrap_or((0.0, 0.0));
            let p = blend.step() * std::f32::consts::FRAC_PI_2;
            let (gin, gout) = (p.sin(), p.cos());
            out = (out.0 * gin + bl * gout, out.1 * gin + br * gout);
            if !blend.moving() { self.blend = None; self.voices[o].clear(); }   // the old song's last moments, now silent
        }
        self.last = out;
        let (l, r) = self.eq.run(out.0, out.1);
        if has {
            self.energy_in += (out.0 * out.0 + out.1 * out.1) as f64;
            self.energy_out += (l * l + r * r) as f64;
        }
        let (l, r) = self.limiter.run(l, r);
        let g = self.fader.step() * self.xfade.step() * self.mute.step();
        if self.pause_pending && !self.fader.moving() && self.fader.target() == 0.0 {
            self.pause_pending = false;
            self.holding = true;
        }
        ((l * g, r * g), has)
    }

    /// Timers that end a skip or a seek's silence (checked once per output callback).
    fn tick(&mut self) {
        let now = Instant::now();
        if self.skip_until.map_or(false, |t| now >= t) { self.skip_until = None; self.mute.go(1.0, 0.01, Curve::Smooth); }
        if self.unmute_at.map_or(false, |t| now >= t) && self.skip_until.is_none() { self.unmute_at = None; self.mute.go(1.0, 0.01, Curve::Smooth); }
    }
}

// MARK: the shared parts

struct Shared {
    st: Mutex<State>,
    settings: Arc<Settings>,
    emit: Emit,
    /// When sound last arrived from librespot (ms since 1970).
    last_audio: AtomicU64,
    resting: AtomicBool,                // the output is paused because nothing has played for a while
    /// The output stopped working (unplugged, the sound server restarted): open it again.
    broken: AtomicBool,
    output: Mutex<String>,
    log: Mutex<Vec<String>>,
    // The sound report's counters (frames, reset every 5 s).
    received: AtomicU64,
    called: AtomicU64,
    played: AtomicU64,
    peak: AtomicU64,
    last_callback: AtomicU64,
    buffer_frames: AtomicU32,
    /// The buffer was set by hand for this output (System → Sound & EQ), so it isn't the automatic one.
    buffer_fixed: AtomicBool,
    rate: AtomicU32,
    /// macOS: an output whose rate Cadenza changed (and the rate it had), and one Cadenza has to itself.
    mac_rate: Mutex<Option<(u32, f64)>>,
    /// (device id, its unique id)
    mac_hog: Mutex<Option<(u32, String)>>,
    /// When exclusive mode was taken, and times the output failed while it was on (see output_thread).
    hog_breaks: Mutex<Vec<Instant>>,
    /// How the output was opened, for the signal path: sample format and number of channels.
    out_format: Mutex<(String, u16)>,
    too_slow: AtomicBool,
    /// Bumped for each librespot process, so an old reader knows to stop.
    generation: AtomicU64,
    /// The engine's sound on its way here (see MemPipe), for asking how much is still waiting.
    mem: Mutex<Option<Arc<MemPipe>>>,
    // The visualizer.
    meter_on: AtomicBool,
    tap: Mutex<VecDeque<f32>>,
    // Output devices.
    chosen: Mutex<Option<String>>,
    device: Mutex<(String, String)>,       // what's playing the sound now: (id, name), for the EQ per device
}

/// What the signal path needs to know about the output side (see signalpath.rs).
pub struct PathInfo {
    pub device: String,
    pub rate: u32,
    pub format: String,
    pub channels: u16,
    pub eq_on: bool,
    pub eq_active: bool,
    pub eq_preamp: f64,
    pub eq_preset: String,
    pub eq_parametric: bool,
    pub crossfade_secs: i64,
    pub chan: Channels,
    /// macOS: Cadenza has the output to itself, and it set the output to 44.1 kHz.
    pub exclusive: bool,
    pub rate_matched: bool,
}

pub struct Sound { s: Arc<Shared> }

impl Sound {
    pub fn start(settings: Arc<Settings>, emit: Emit) -> Arc<Self> {
        let s = Arc::new(Shared {
            st: Mutex::new(State::new()), settings, emit,
            last_audio: AtomicU64::new(0), resting: AtomicBool::new(false), broken: AtomicBool::new(false),
            output: Mutex::new("none yet".into()), log: Mutex::new(vec![]),
            received: AtomicU64::new(0), called: AtomicU64::new(0), played: AtomicU64::new(0), peak: AtomicU64::new(0),
            last_callback: AtomicU64::new(0), buffer_frames: AtomicU32::new(BUFFER_FRAMES), buffer_fixed: AtomicBool::new(false), mac_rate: Mutex::new(None), mac_hog: Mutex::new(None), hog_breaks: Mutex::new(vec![]), rate: AtomicU32::new(RATE), out_format: Mutex::new((String::new(), 2)),
            too_slow: AtomicBool::new(false), generation: AtomicU64::new(0), mem: Mutex::new(None),
            meter_on: AtomicBool::new(false), tap: Mutex::new(VecDeque::with_capacity(dsp::FFT_SIZE * 2)),
            chosen: Mutex::new(None), device: Mutex::new((String::new(), String::new())),
        });
        let me = Arc::new(Sound { s: s.clone() });
        me.apply_eq();
        me.apply_channels();
        let chosen = me.s.settings.string("outputDevice");
        if !chosen.is_empty() && cfg!(windows) { *s.chosen.lock().unwrap() = Some(chosen); }
        for (name, f) in [("cadenza-sound-report", report as fn(Arc<Shared>)), ("cadenza-output", output_thread), ("cadenza-levels", levels_thread)] {
            let c = s.clone();
            std::thread::Builder::new().name(name.into()).spawn(move || f(c)).ok();
        }
        let w = me.clone();
        std::thread::Builder::new().name("cadenza-devices".into()).spawn(move || w.watch_devices()).ok();
        me
    }

    pub fn seconds_since_audio(&self) -> f64 {
        let at = self.s.last_audio.load(Ordering::Relaxed);
        if at == 0 { return f64::INFINITY; }
        now_ms().saturating_sub(at) as f64 / 1000.0
    }
    pub fn output_name(&self) -> String { self.s.output.lock().unwrap().clone() }

    /// For the signal path: the output's name, the rate and format Cadenza opened it at, and whether the EQ
    /// really changes anything (on, with a band or the boost away from zero).
    pub fn path_info(&self) -> PathInfo {
        let c = self.eq_values();
        let (format, channels) = self.s.out_format.lock().unwrap().clone();
        let active = c.on && (c.preamp != 0.0 || if c.parametric { c.filters.iter().any(|f| f.kind != Kind::Off && f.gain != 0.0) } else { c.gains.iter().any(|g| *g != 0.0) });
        PathInfo {
            device: self.s.device.lock().unwrap().1.clone(),
            rate: self.s.rate.load(Ordering::Relaxed),
            format, channels,
            eq_on: c.on, eq_active: active, eq_preamp: c.preamp, eq_preset: c.preset, eq_parametric: c.parametric,
            crossfade_secs: self.s.settings.int("crossfade"),
            chan: self.with(|st| st.chan),
            exclusive: self.s.mac_hog.lock().unwrap().is_some(),
            rate_matched: self.s.mac_rate.lock().unwrap().is_some(),
        }
    }

    pub fn log(&self) -> Vec<String> { self.s.log.lock().unwrap().clone() }

    fn with<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        let (out, logs) = {
            let mut st = self.s.st.lock().unwrap();
            let out = f(&mut st);
            (out, std::mem::take(&mut st.logs))
        };
        for l in logs { note(&self.s, l); }
        out
    }

    /// Frames librespot has written that haven't been read yet (still in the pipe).
    fn waiting_frames(&self) -> i64 { self.s.mem.lock().unwrap().as_ref().map_or(0, |m| m.waiting() as i64 / 4) }

    // MARK: reading librespot's sound

    /// Reads a new librespot process's sound until it closes its output (it quit or was restarted).
    /// Reads the engine's sound (it writes into `pipe`) until the engine closes it.
    pub fn attach_memory(&self, pipe: Arc<MemPipe>) {
        *self.s.mem.lock().unwrap() = Some(pipe.clone());
        self.read_from(MemReader(pipe));
    }

    fn read_from(&self, mut pipe: impl Read + Send + 'static) {
        let gen = self.s.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.with(|st| { st.stream_frames = 0; st.track_start = -1; st.track_length = 0; st.last_boundary = -1; st.in_tail = false; });
        let s = self.s.clone();
        std::thread::Builder::new().name("cadenza-pipe".into()).spawn(move || {
            let mut bytes = vec![0u8; 1024 * 4];
            loop {
                if s.generation.load(Ordering::SeqCst) != gen { break; }
                let ((want, tail), logs) = { let mut st = s.st.lock().unwrap(); let p = st.plan(); (p, std::mem::take(&mut st.logs)) };
                for l in logs { note(&s, l); }
                // Normally wait for room; an old song's tail is read straight away instead, so the next song
                // can start playing alongside it.
                if !tail {
                    loop {
                        if s.generation.load(Ordering::SeqCst) != gen { return; }
                        let full = { let st = s.st.lock().unwrap(); st.voices[st.cur].len() >= QUEUE_FRAMES };
                        if !full { break; }
                        std::thread::sleep(Duration::from_millis(2));
                    }
                }
                let need = (want.clamp(1, 1024) as usize) * 4;
                let mut got = 0;
                while got < need {
                    match pipe.read(&mut bytes[got..need]) { Ok(0) | Err(_) => break, Ok(n) => got += n }
                }
                if got < 4 { break; }                                 // librespot stopped
                let n = got / 4;
                s.last_audio.store(now_ms(), Ordering::Relaxed);
                s.received.fetch_add(n as u64, Ordering::Relaxed);
                let logs = {
                    let mut st = s.st.lock().unwrap();
                    let at = st.stream_frames;
                    st.stream_frames += n as i64;
                    if st.discard_frames > 0 {
                        st.discard_frames -= n as i64;                    // the end of the previous song (or spot): drop it
                    } else {
                        let frames = bytes[..n * 4].chunks_exact(4).map(|b| (
                            i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0,
                            i16::from_le_bytes([b[2], b[3]]) as f32 / 32768.0,
                        ));
                        if st.in_tail && at >= st.xf_boundary {
                            // The next song begins: it goes to the other voice, which fades in while the old
                            // song's tail (already queued) fades out.
                            st.last_boundary = st.xf_boundary;
                            st.last_boundary_at = Some(Instant::now());
                            st.track_start = st.xf_boundary;
                            st.track_length = st.next_length;               // 0 until librespot reports it
                            st.next_length = 0;
                            st.in_tail = false;
                            st.cur = 1 - st.cur;
                            let c = st.cur;
                            st.voices[c].clear();
                            st.voices[c].extend(frames);
                            let xf_secs = st.xf_frames as f64 / RATE as f64;
                            // Only blend if the old song is still playing out. If the next song came much later
                            // (the queue ran out and something new was started), it just begins.
                            let took = st.tail_started_at.elapsed().as_secs_f64();
                            if took < xf_secs + 2.0 {
                                let mut r = Ramp::at(0.0);
                                r.go(1.0, xf_secs.max(0.3), Curve::Linear);
                                st.blend = Some(r);
                                st.xlog(format!("next song started; blending over {xf_secs:.0} s (tail read in {took:.2} s)."));
                            } else {
                                let o = st.other();
                                st.voices[o].clear();
                                st.xlog(format!("next song came {took:.1} s after the old one ended: starting it normally."));
                            }
                        } else {
                            let c = st.cur;
                            st.voices[c].extend(frames);
                        }
                    }
                    std::mem::take(&mut st.logs)
                };
                for l in logs { note(&s, l); }
            }
        }).ok();
    }

    // MARK: what librespot reports

    /// librespot said where it is in the song (`ms`), how long the song is, or that a new song began.
    /// From that, Cadenza works out where in the stream the song will end, to start the crossfade on time.
    pub fn song_position(&self, ms: Option<f64>, duration: Option<i64>, new_song: bool) {
        let waiting = self.waiting_frames();
        let xf = self.s.settings.int("crossfade").clamp(0, 12);
        self.with(|st| {
            st.xf_frames = xf * RATE as i64;
            let written = st.stream_frames + waiting;
            let length = duration.map(|d| (d as f64 * 44.1) as i64).unwrap_or(0);
            if new_song {
                if st.in_tail { st.next_length = length; return; }      // picked up when the voices switch
                st.track_start = if st.last_boundary >= 0 && st.last_boundary_at.map_or(false, |t| t.elapsed() < Duration::from_secs(20)) {
                    st.last_boundary                                        // it began where the last song ended
                } else { written };                                         // it starts now (a skip, a fresh start)
                st.track_length = length;
                report_plan(st, written);
                return;
            }
            if st.in_tail { return; }
            if length > 0 { st.track_length = length; }
            let Some(ms) = ms else { return };
            // Right after a crossfade the reader has just raced ahead, so a position from then would be off;
            // the start found from the song boundary is more exact.
            if st.track_start == st.last_boundary && st.last_boundary_at.map_or(false, |t| t.elapsed() < Duration::from_secs(15)) { return; }
            st.track_start = written - (ms * 44.1) as i64;
            report_plan(st, written);
        });
    }

    /// librespot started a different song: if a skip was waiting for it, throw away the old song's leftovers.
    pub fn track_changed(&self) {
        let waiting = self.waiting_frames();
        self.with(|st| {
            if st.skip_until.take().is_some() {
                st.drop_queued(waiting);
                st.mute.go(1.0, 0.01, Curve::Smooth);
            }
        });
    }

    /// librespot jumped to a new spot: drop the old spot's sound still on its way, behind a tiny fade.
    pub fn seeked(&self) {
        let waiting = self.waiting_frames();
        self.with(|st| {
            if st.holding || st.skip_until.is_some() { return; }
            st.mute.go(0.0, 0.005, Curve::Linear);
            st.drop_queued(waiting);
            st.unmute_at = Some(Instant::now() + Duration::from_millis(50));
        });
    }

    // MARK: instant controls

    /// `audio.local` from the page: pause, play, toggle, skip, sleepfade.
    pub fn local(&self, action: &str, playing_here: bool) {
        match action {
            "pause" => self.local_pause(),
            "play" => self.local_resume(),
            "toggle" => if playing_here && !self.holding() { self.local_pause() } else { self.local_resume() },
            "skip" => self.with(|st| { st.mute.go(0.0, 0.008, Curve::Linear); st.skip_until = Some(Instant::now() + Duration::from_millis(2500)); }),
            "sleepfade" => self.with(|st| { st.sleep_fading = true; st.xfade.go(0.0, 10.0, Curve::Smooth); }),
            _ => {}
        }
    }

    /// Stops the sound right away with a very short fade. What's queued stays queued, so playing again
    /// continues exactly where it stopped.
    pub fn local_pause(&self) {
        self.with(|st| {
            if st.holding || st.pause_pending { return; }
            st.locally_paused_at = Some(Instant::now());
            st.pause_pending = true;
            st.fader.go(0.0, 0.12, Curve::Smooth);
        });
    }

    pub fn local_resume(&self) {
        self.with(|st| {
            if st.sleep_fading { st.sleep_fading = false; st.xfade.go(1.0, 0.5, Curve::Smooth); }   // the sleep timer was cancelled
            st.locally_paused_at = None;
            st.pause_pending = false;
            if st.holding { st.holding = false; st.fader.set(0.0); }
            st.fader.go(1.0, 0.18, Curve::Smooth);
        });
    }

    /// True while Cadenza is holding the sound (paused here), whatever Spotify thinks.
    pub fn holding(&self) -> bool { self.with(|st| st.holding || st.pause_pending) }
    pub fn locally_paused_at(&self) -> Option<Instant> { self.with(|st| st.locally_paused_at) }
    pub fn sleep_fading(&self) -> bool { self.with(|st| st.sleep_fading) }
    pub fn transition_volume(&self) -> f32 { self.with(|st| st.xfade.value()) }

    /// Ease the transition volume to `target` (the start of a new song after a sleep fade was cut short).
    pub fn ramp_transition(&self, target: f32, seconds: f64) {
        self.with(|st| if seconds <= 0.0 || (st.xfade.value() - target).abs() < 0.001 { st.xfade.set(target) } else { st.xfade.go(target, seconds, Curve::Smooth) });
    }
    /// Back to full volume at once (anything that isn't the song running out).
    pub fn reset_transition(&self) { self.with(|st| st.xfade.set(1.0)); }

    /// Safety net when playback (re)starts: nothing left turned down by an interrupted fade or skip.
    pub fn ensure_audible(&self) {
        self.with(|st| {
            if st.skip_until.is_none() { st.mute.set(1.0); st.unmute_at = None; }
            if !st.fader.moving() && !st.pause_pending { st.fader.set(1.0); }
            if !st.xfade.moving() && !st.sleep_fading { st.xfade.set(1.0); }
            if st.holding { st.holding = false; st.locally_paused_at = None; st.fader.set(1.0); }
        });
    }

    // MARK: EQ

    fn eq_values(&self) -> EqConf {
        let set = &self.s.settings;
        let gains: Vec<f64> = set.get("eqGains").as_array().map(|a| a.iter().map(|v| v.as_f64().unwrap_or(0.0)).collect()).unwrap_or_default();
        EqConf {
            on: set.get("eqEnabled").as_bool().unwrap_or(true),
            preamp: set.get("eqPreamp").as_f64().unwrap_or(0.0),
            gains: if gains.len() == 10 { gains } else { vec![0.0; 10] },
            preset: set.get("eqPreset").as_str().unwrap_or("Flat").to_string(),
            parametric: set.get("eqMode").as_str() == Some("parametric"),
            filters: filters_from(&set.get("eqFilters")),
        }
    }

    fn apply_eq(&self) {
        let c = self.eq_values();
        if c.parametric { self.with(|st| st.eq.set_filters(c.on, c.preamp, &c.filters)); }
        else { self.with(|st| st.eq.set(c.on, c.preamp, &c.gains)); }
        note(&self.s, if !c.on { "EQ off".into() } else if c.parametric {
            let f: Vec<String> = c.filters.iter().filter(|f| f.kind != Kind::Off).map(|f| format!("{} {:.0} Hz {:+.1} dB Q {:.2}", f.code(), f.freq, f.gain, f.q)).collect();
            format!("EQ on (parametric): {}, preamp {:+.1} dB, {}", c.preset, c.preamp, if f.is_empty() { "no filters".into() } else { f.join(" · ") })
        } else {
            let g: Vec<String> = c.gains.iter().map(|v| format!("{v:+.0}")).collect();
            format!("EQ on: {}, preamp {:+.1} dB, bands {}", c.preset, c.preamp, g.join(" "))
        });
    }

    fn per_device(&self) -> bool { self.s.settings.get("eqPerDevice").as_bool().unwrap_or(true) }

    pub fn eq_state(&self) -> Value {
        let c = self.eq_values();
        json!({"enabled": c.on, "preamp": c.preamp, "gains": c.gains, "preset": c.preset, "freqs": dsp::FREQS,
               "mode": if c.parametric { "parametric" } else { "graphic" }, "filters": filters_json(&c.filters),
               "running": true, "device": self.s.device.lock().unwrap().1, "perDevice": self.per_device(), "engine": true})
    }

    fn profile(&self) -> Value {
        let c = self.eq_values();
        json!({"enabled": c.on, "preamp": c.preamp, "gains": c.gains, "preset": c.preset,
               "mode": if c.parametric { "parametric" } else { "graphic" }, "filters": filters_json(&c.filters)})
    }

    pub fn eq_update(&self, args: &Value) -> Value {
        let set = &self.s.settings;
        if let Some(v) = args.get("enabled").and_then(Value::as_bool) { set.put("eqEnabled", json!(v)); }
        if let Some(v) = args.get("preamp").and_then(Value::as_f64) { set.put("eqPreamp", json!(v.clamp(-12.0, 12.0))); }
        if let Some(g) = args.get("gains").and_then(Value::as_array) {
            if g.len() == 10 { set.put("eqGains", json!(g.iter().map(|v| v.as_f64().unwrap_or(0.0).clamp(-12.0, 12.0)).collect::<Vec<_>>())); }
        }
        if let Some(v) = args.get("preset").and_then(Value::as_str) { set.put("eqPreset", json!(v)); }
        if let Some(v) = args.get("perDevice").and_then(Value::as_bool) { set.put("eqPerDevice", json!(v)); }
        if let Some(v) = args.get("mode").and_then(Value::as_str) { set.put("eqMode", json!(if v == "parametric" { "parametric" } else { "graphic" })); }
        if let Some(f) = args.get("filters").filter(|f| f.is_array()) { set.put("eqFilters", filters_json(&filters_from(f))); }
        self.apply_eq();
        // Remember these settings for this output device.
        let id = self.s.device.lock().unwrap().0.clone();
        if self.per_device() && !id.is_empty() {
            let mut profiles = set.get("eqProfiles");
            if !profiles.is_object() { profiles = json!({}); }
            profiles[id] = self.profile();
            set.put("eqProfiles", profiles);
        }
        self.eq_state()
    }

    /// The sound now plays through a different device: load its EQ (the first time, it starts from the
    /// current one). True when a different EQ was loaded.
    fn use_device(&self, id: &str, name: &str) -> bool {
        *self.s.device.lock().unwrap() = (id.to_string(), name.to_string());
        if !self.per_device() || id.is_empty() { return false; }
        let set = &self.s.settings;
        let mut profiles = set.get("eqProfiles");
        if !profiles.is_object() { profiles = json!({}); }
        let Some(p) = profiles.get(id).cloned() else {
            profiles[id] = self.profile();
            set.put("eqProfiles", profiles);
            return false;
        };
        if let Some(v) = p.get("enabled").and_then(Value::as_bool) { set.put("eqEnabled", json!(v)); }
        if let Some(v) = p.get("preamp").and_then(Value::as_f64) { set.put("eqPreamp", json!(v)); }
        if let Some(v) = p.get("gains").filter(|g| g.as_array().map_or(false, |a| a.len() == 10)) { set.put("eqGains", v.clone()); }
        if let Some(v) = p.get("preset").and_then(Value::as_str) { set.put("eqPreset", json!(v)); }
        set.put("eqMode", json!(if p.get("mode").and_then(Value::as_str) == Some("parametric") { "parametric" } else { "graphic" }));
        if let Some(f) = p.get("filters").filter(|f| f.is_array()) { set.put("eqFilters", filters_json(&filters_from(f))); }
        self.apply_eq();
        true
    }

    // MARK: channels, test tones, the buffer and the Mac's output

    /// Balance, mono, swap and polarity from the settings.
    pub fn apply_channels(&self) {
        let set = &self.s.settings;
        let c = Channels {
            balance: (set.get("balance").as_f64().unwrap_or(0.0).clamp(-100.0, 100.0) / 100.0) as f32,
            mono: set.bool("mono"), swap: set.bool("swapChannels"), invert: set.bool("invertPolarity"),
        };
        self.with(|st| st.chan = c);
        if !c.neutral() { note(&self.s, format!("Channels: balance {:+.0}, mono {}, swapped {}, polarity {}", c.balance * 100.0, c.mono, c.swap, if c.invert { "flipped" } else { "normal" })); }
    }

    /// A test tone on "left", "right" or "both" speakers.
    pub fn test_tone(&self, which: &str) {
        let (l, r) = match which { "left" => (true, false), "right" => (false, true), _ => (true, true) };
        self.with(|st| st.tone = Some(Tone::new(l, r)));
        // Wake a resting output.
        self.s.last_audio.store(now_ms(), Ordering::Relaxed);
    }

    /// Open the output again (a setting about how it's opened changed).
    pub fn reopen(&self) { self.s.broken.store(true, Ordering::SeqCst); }

    /// The buffer for the output in use: set it (frames; 0 for automatic) and reopen. Returns what it is now.
    pub fn buffer(&self, frames: Option<u64>) -> Value {
        let id = self.s.device.lock().unwrap().0.clone();
        if let Some(f) = frames {
            let mut p = self.s.settings.get("bufferProfiles");
            if !p.is_object() { p = json!({}); }
            if id.is_empty() { return json!({"ok": false}); }
            if f == 0 { if let Some(m) = p.as_object_mut() { m.remove(&id); } } else { p[&id] = json!(f.clamp(256, BUFFER_FRAMES_MAX as u64)); }
            self.s.settings.put("bufferProfiles", p);
            self.reopen();
        }
        let choice = self.s.settings.get("bufferProfiles").get(&id).and_then(Value::as_u64).unwrap_or(0);
        json!({"ok": true, "device": self.s.device.lock().unwrap().1, "choice": choice,
               "frames": self.s.buffer_frames.load(Ordering::Relaxed), "rate": self.s.rate.load(Ordering::Relaxed)})
    }

    /// Before Cadenza quits: give the Mac's output back as it was.
    pub fn shutdown(&self) { mac_release(&self.s); }

    pub fn set_meter(&self, on: bool) {
        self.s.meter_on.store(on, Ordering::Relaxed);
        if !on { self.s.tap.lock().unwrap().clear(); }
    }

    // MARK: output devices

    /// The outputs to pick from: [{uid, name, transport, isDefault}].
    /// - macOS: Core Audio's outputs; picking one makes it the Mac's output.
    /// - Linux: the sound server's outputs (PipeWire or PulseAudio, through `pactl`); the same.
    /// - Windows: the system's outputs; picking one plays Cadenza through it.
    pub fn outputs(&self) -> Value { Value::Array(list_outputs(&self.s)) }

    pub fn set_output(&self, uid: &str) -> bool {
        if cfg!(target_os = "linux") {
            let ok = std::process::Command::new("pactl").args(["set-default-sink", uid]).status().map(|s| s.success()).unwrap_or(false);
            if ok { self.check_device(); }
            return ok;
        }
        #[cfg(target_os = "macos")]
        {
            // You picked another output: give back the one held in exclusive mode first, so the move is yours.
            if self.s.mac_hog.lock().unwrap().as_ref().map_or(false, |(_, u)| u != uid) { mac_release(&self.s); self.s.broken.store(true, Ordering::SeqCst); }
            let ok = crate::macaudio::set_default(uid);
            if ok { self.check_device(); }
            return ok;
        }
        #[allow(unreachable_code)]
        let known = list_outputs(&self.s).iter().any(|o| o["uid"] == uid);
        if !known { return false; }
        *self.s.chosen.lock().unwrap() = Some(uid.to_string());
        self.s.settings.put("outputDevice", json!(uid));
        self.s.broken.store(true, Ordering::SeqCst);                  // reopen on the new device
        true
    }

    /// Every 3 s: has the output (or the list of outputs) changed? Tell the page, load that device's EQ,
    /// and on Windows and macOS follow a new system output unless you picked one yourself.
    fn watch_devices(self: Arc<Self>) {
        let mut last_list = String::new();
        loop {
            let list = list_outputs(&self.s);
            let sig = list.iter().map(|o| format!("{}{}", o["uid"], o["isDefault"])).collect::<Vec<_>>().join("|");
            if sig != last_list {
                if !last_list.is_empty() { (self.s.emit)("outputs", Value::Null); }
                last_list = sig;
            }
            // The output in use is the one the list marks, so the system isn't asked a second time (on
            // Linux each question starts a `pactl`).
            let current = list.iter().find(|o| o["isDefault"] == true)
                .map(|o| (o["uid"].as_str().unwrap_or("").to_string(), o["name"].as_str().unwrap_or("").to_string()));
            self.check_device_now(current);
            std::thread::sleep(Duration::from_secs(3));
        }
    }

    fn check_device(&self) { self.check_device_now(None); }

    /// `known`: the output in use, if the caller already knows it.
    fn check_device_now(&self, known: Option<(String, String)>) {
        let (id, name) = known.unwrap_or_else(|| current_device(&self.s));
        // While Cadenza has an output to itself, macOS may report another one as the system's (other apps
        // can't use this one): keep playing where it is.
        if let Some((_, uid)) = self.s.mac_hog.lock().unwrap().as_ref() { if !uid.is_empty() && *uid != id && self.s.settings.bool("exclusive") { return; } }
        let changed = self.s.device.lock().unwrap().0 != id;
        if !changed { return; }
        let first = self.s.device.lock().unwrap().0.is_empty();
        if !first && !cfg!(target_os = "linux") && self.s.chosen.lock().unwrap().is_none() {
            note(&self.s, format!("The system's sound output changed to {name}: moving the sound there."));
            self.s.broken.store(true, Ordering::SeqCst);
        }
        if self.use_device(&id, &name) && !first {
            (self.s.emit)("eq.changed", self.eq_state());
        }
        if !first { (self.s.emit)("outputs", Value::Null); }
    }
}

struct EqConf { on: bool, preamp: f64, gains: Vec<f64>, preset: String, parametric: bool, filters: Vec<Filter> }

/// The parametric filters from the settings: [{t: "PK" | "LSC" | "HSC" | "OFF", f, g, q}], at most 10.
fn filters_from(v: &Value) -> Vec<Filter> {
    v.as_array().map(|a| a.iter().take(dsp::MAX_FILTERS).filter_map(|x| {
        let kind = Filter::kind_from(x.get("t").and_then(Value::as_str).unwrap_or(""))?;
        let n = |k: &str, d: f64| x.get(k).and_then(Value::as_f64).filter(|v| v.is_finite()).unwrap_or(d);
        Some(Filter { kind, freq: n("f", 1000.0), gain: n("g", 0.0), q: n("q", 1.0) }.clamped())
    }).collect()).unwrap_or_default()
}

pub fn filters_json(f: &[Filter]) -> Value {
    Value::Array(f.iter().map(|x| json!({"t": x.code(), "f": (x.freq * 10.0).round() / 10.0, "g": (x.gain * 100.0).round() / 100.0, "q": (x.q * 100.0).round() / 100.0})).collect())
}

/// macOS, when the output is opened: set it to 44.1 kHz (so macOS doesn't convert Spotify's sound) and/or
/// keep it to Cadenza alone, as the settings say. Whatever was changed for a previous output is undone first.
#[cfg(target_os = "macos")]
fn mac_apply(s: &Shared) {
    // The output Cadenza holds stays the target: once it's taken, macOS makes another output the system's.
    let held = s.mac_hog.lock().unwrap().as_ref().map(|(d, _)| *d);
    let dev = match held { Some(d) if s.settings.bool("exclusive") => d, _ => crate::macaudio::default_output() };
    // Exclusive mode stays taken while it's the same output: taking it again makes macOS reset the device.
    let keep_hog = s.settings.bool("exclusive") && s.mac_hog.lock().unwrap().as_ref().map_or(false, |(d, _)| *d == dev);
    if keep_hog { if let Some((dev, r)) = s.mac_rate.lock().unwrap().take() { crate::macaudio::set_rate(dev, r); } }
    else { mac_release(s); }
    if dev == 0 { return; }
    if s.settings.bool("matchRate") {
        match crate::macaudio::device_rate(dev) {
            Some(r) if (r - RATE as f64).abs() > 1.0 => {
                if crate::macaudio::supports_rate(dev, RATE as f64) && crate::macaudio::set_rate(dev, RATE as f64) {
                    *s.mac_rate.lock().unwrap() = Some((dev, r));
                    note(s, format!("Set the output to 44.1 kHz (it was {:.1} kHz), so macOS doesn't convert the sound.", r / 1000.0));
                } else {
                    note(s, "This output can't run at 44.1 kHz, so macOS converts the sound to its rate.".into());
                }
            }
            _ => {}
        }
    }
    if s.settings.bool("exclusive") && !keep_hog {
        if crate::macaudio::hog(dev, true) {
            let uid = crate::macaudio::outputs().into_iter().find(|o| o.id == dev).map(|o| o.uid).unwrap_or_default();
            *s.mac_hog.lock().unwrap() = Some((dev, uid));
            note(s, "Exclusive mode: the output plays only Cadenza.".into());
            // macOS resets a device when an app takes it: give it a moment before opening the sound.
            std::thread::sleep(Duration::from_millis(400));
        } else {
            note(s, "Exclusive mode: the output wouldn't let Cadenza have it to itself (another app may have it).".into());
        }
    }
}
#[cfg(not(target_os = "macos"))]
fn mac_apply(_s: &Shared) {}

/// Gives the output back: its old rate, and other apps' sound.
fn mac_release(s: &Shared) {
    let rate = s.mac_rate.lock().unwrap().take();
    let hog = s.mac_hog.lock().unwrap().take();
    #[cfg(target_os = "macos")]
    {
        if let Some((dev, _)) = hog { crate::macaudio::hog(dev, false); }
        if let Some((dev, r)) = rate { crate::macaudio::set_rate(dev, r); }
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (rate, hog); }
}

/// The output failed (stopped, or reported an error). If that keeps happening while exclusive mode is on,
/// the output doesn't work with it: give the output back and turn exclusive mode off, and say so.
fn exclusive_failed(s: &Shared) {
    if s.mac_hog.lock().unwrap().is_none() { return; }
    let mut b = s.hog_breaks.lock().unwrap();
    b.retain(|t| t.elapsed() < Duration::from_secs(60));
    b.push(Instant::now());
    if b.len() < 2 { return; }
    b.clear();
    drop(b);
    mac_release(s);
    s.settings.put("exclusive", json!(false));
    let text = "Exclusive mode stopped the sound on this output, so Cadenza turned it off.";
    note(s, text.into());
    (s.emit)("sound.notice", json!({"text": text, "settings": {"exclusive": false}}));
}

fn report_plan(st: &mut State, written: i64) {
    if st.track_start < 0 { return; }
    if st.track_length <= 0 { return st.xlog("song length not known yet: no blend planned.".into()); }
    if st.xf_frames == 0 { return st.xlog("off.".into()); }
    if st.track_length <= st.xf_frames * 3 { return st.xlog("song too short to blend.".into()); }
    let left = st.track_start + st.track_length - written;
    let line = format!("this song ends in {}; the {} blend starts {} from now.", secs(left), secs(st.xf_frames), secs((left - st.xf_frames).max(0)));
    if line == st.last_plan_line { return; }                      // the same plan, worked out again a moment later
    st.last_plan_line = line.clone();
    st.xlog(line);
}

/// The built-in engine's sound on its way to the output: librespot writes 16-bit stereo samples in, the
/// reader takes them out. It works like the pipe from the separate librespot program, including making
/// librespot wait while it's full, so the crossfade and skipping work the same way.
pub struct MemPipe { buf: Mutex<VecDeque<u8>>, cv: Condvar, closed: AtomicBool }

impl MemPipe {
    /// About the size of a pipe's buffer (macOS and Linux both use 64 KB): 0.37 s of sound.
    const CAP: usize = 64 * 1024;
    pub fn new() -> Arc<Self> { Arc::new(MemPipe { buf: Mutex::new(VecDeque::with_capacity(Self::CAP)), cv: Condvar::new(), closed: AtomicBool::new(false) }) }
    pub fn waiting(&self) -> usize { self.buf.lock().unwrap().len() }
    /// Waits for room, then adds `data`. False once closed.
    pub fn write(&self, mut data: &[u8]) -> bool {
        while !data.is_empty() {
            let mut b = self.buf.lock().unwrap();
            while b.len() >= Self::CAP && !self.closed.load(Ordering::Relaxed) {
                b = self.cv.wait_timeout(b, Duration::from_millis(100)).unwrap().0;
            }
            if self.closed.load(Ordering::Relaxed) { return false; }
            let n = (Self::CAP - b.len()).min(data.len());
            b.extend(&data[..n]);
            data = &data[n..];
            self.cv.notify_all();
        }
        true
    }
    /// The engine stopped: the reader finishes, and a writer still waiting gives up.
    pub fn close(&self) { self.closed.store(true, Ordering::Relaxed); self.cv.notify_all(); }
}

struct MemReader(Arc<MemPipe>);
impl Read for MemReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let p = &self.0;
        let mut b = p.buf.lock().unwrap();
        while b.is_empty() {
            if p.closed.load(Ordering::Relaxed) { return Ok(0); }
            b = p.cv.wait_timeout(b, Duration::from_millis(100)).unwrap().0;
        }
        let n = out.len().min(b.len());
        for (o, v) in out.iter_mut().zip(b.drain(..n)) { *o = v; }
        p.cv.notify_all();
        Ok(n)
    }
}

fn note(s: &Shared, line: String) {
    log::info!("{line}");
    let mut l = s.log.lock().unwrap();
    l.push(line);
    if l.len() > 80 { l.remove(0); }
}

// MARK: devices

fn transport_from_name(name: &str) -> &'static str {
    let n = name.to_lowercase();
    if ["bluez", "bluetooth", "airpods", "buds", "headset"].iter().any(|k| n.contains(k)) { "bluetooth" }
    else if n.contains("usb") { "usb" }
    else if ["hdmi", "displayport", "display"].iter().any(|k| n.contains(k)) { "display" }
    else if ["speaker", "analog", "built-in", "builtin", "realtek", "pci"].iter().any(|k| n.contains(k)) { "builtin" }
    else { "other" }
}

/// Linux: the sound server's outputs through `pactl` (PipeWire and PulseAudio both answer it).
fn pactl_sinks() -> Option<(String, Vec<(String, String)>)> {
    let default = std::process::Command::new("pactl").arg("get-default-sink").output().ok()
        .filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())?;
    let json = std::process::Command::new("pactl").args(["--format=json", "list", "sinks"]).output().ok()
        .filter(|o| o.status.success()).and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok());
    let sinks = json.and_then(|v| v.as_array().cloned()).unwrap_or_default().iter().filter_map(|s| {
        let id = s.get("name")?.as_str()?.to_string();
        let name = s.get("description").and_then(Value::as_str).unwrap_or(&id).to_string();
        Some((id, name))
    }).collect::<Vec<_>>();
    Some((default, sinks))
}

fn list_outputs(s: &Shared) -> Vec<Value> {
    if cfg!(target_os = "linux") {
        return match pactl_sinks() {
            Some((default, sinks)) if !sinks.is_empty() => sinks.iter().map(|(id, name)| json!({
                "uid": id, "name": name, "transport": transport_from_name(&format!("{id} {name}")), "isDefault": *id == default,
            })).collect(),
            _ => vec![json!({"uid": "default", "name": "System output", "transport": "builtin", "isDefault": true})],
        };
    }
    #[cfg(target_os = "macos")]
    {
        let _ = s;                                            // (the Mac follows the system output, never a chosen one)
        let current = crate::macaudio::default_output();
        return crate::macaudio::outputs().into_iter().map(|o| json!({
            "uid": o.uid, "name": o.name, "transport": o.transport, "isDefault": o.id == current,
        })).collect();
    }
    #[allow(unreachable_code)]
    let host = cpal::default_host();
    let default = host.default_output_device().and_then(|d| d.name().ok()).unwrap_or_default();
    let using = s.chosen.lock().unwrap().clone().unwrap_or(default);
    host.output_devices().map(|list| list.filter_map(|d| d.name().ok()).map(|name| json!({
        "uid": name, "name": name, "transport": transport_from_name(&name), "isDefault": name == using,
    })).collect()).unwrap_or_default()
}

/// What's playing the sound now: (id, name).
fn current_device(s: &Shared) -> (String, String) {
    if cfg!(target_os = "linux") {
        if let Some((default, sinks)) = pactl_sinks() {
            let name = sinks.iter().find(|(id, _)| *id == default).map(|(_, n)| n.clone()).unwrap_or_else(|| default.clone());
            return (default, name);
        }
        return ("default".into(), "System output".into());
    }
    #[cfg(target_os = "macos")]
    {
        let current = crate::macaudio::default_output();
        if let Some(o) = crate::macaudio::outputs().into_iter().find(|o| o.id == current) { return (o.uid, o.name); }
    }
    let name = s.chosen.lock().unwrap().clone()
        .or_else(|| cpal::default_host().default_output_device().and_then(|d| d.name().ok()))
        .unwrap_or_default();
    (name.clone(), name)
}

fn find_device(s: &Shared) -> Option<cpal::Device> {
    let host = cpal::default_host();
    // Exclusive mode: the output Cadenza holds (macOS no longer calls it the default once it's taken).
    #[cfg(target_os = "macos")]
    if let Some((dev, _)) = s.mac_hog.lock().unwrap().clone() {
        if let Some(name) = crate::macaudio::outputs().into_iter().find(|o| o.id == dev).map(|o| o.name) {
            if let Some(d) = host.output_devices().ok().and_then(|mut l| l.find(|d| d.name().ok().as_deref() == Some(name.as_str()))) { return Some(d); }
        }
    }
    if let Some(want) = s.chosen.lock().unwrap().clone() {
        if let Some(d) = host.output_devices().ok()?.find(|d| d.name().ok().as_deref() == Some(want.as_str())) { return Some(d); }
    }
    host.default_output_device()
}

// MARK: the output

/// Keeps an output open. With no output at all, the sound is taken at real-time speed anyway, so
/// librespot keeps playing and the position keeps moving.
fn output_thread(s: Arc<Shared>) {
    let mut reopens: Vec<Instant> = vec![];
    loop {
        s.broken.store(false, Ordering::SeqCst);
        match open_output(&s) {
            Ok(stream) => {
                // Watchdog: an output that stops asking for sound without an error (after waking up, or a
                // sound server hiccup) is opened again, so the music doesn't just stop.
                let opened = Instant::now();
                s.last_callback.store(now_ms(), Ordering::Relaxed);
                let (mut stalled, mut resize) = (false, false);
                s.too_slow.store(false, Ordering::SeqCst);
                let mut resting = false;
                while !s.broken.load(Ordering::SeqCst) {
                    if s.too_slow.swap(false, Ordering::SeqCst) { resize = true; break; }
                    std::thread::sleep(Duration::from_millis(if resting { 100 } else { 250 }));
                    // Resting: after a few minutes with no music, the output is paused (it otherwise keeps the
                    // sound hardware, or your Bluetooth headphones, busy playing silence), and it comes back
                    // as soon as music does. While paused locally, what's queued waits for the resume.
                    let idle = now_ms().saturating_sub(s.last_audio.load(Ordering::Relaxed)) > rest_after_ms();
                    let (holding, queued) = { let st = s.st.lock().unwrap(); (st.holding, st.voices.iter().any(|v| !v.is_empty())) };
                    if !resting && idle && (holding || !queued) {
                        if stream.pause().is_ok() {
                            mac_release(&s);
                            resting = true;
                            s.resting.store(true, Ordering::Relaxed);
                            note(&s, "Nothing has played for a few minutes: resting the sound output until music comes back.".into());
                        }
                        continue;
                    }
                    if resting {
                        if !idle || (!holding && queued) {
                            // The Mac's output was given back while resting: open it afresh, so it's taken again
                            // (and set to 44.1 kHz) before any sound plays. (Changing it under an open stream stops it.)
                            if cfg!(target_os = "macos") && (s.settings.bool("exclusive") || s.settings.bool("matchRate")) {
                                s.resting.store(false, Ordering::Relaxed);
                                note(&s, "Music again: opening the sound output afresh.".into());
                                resize = true;
                                break;
                            }
                            let _ = stream.play();
                            resting = false;
                            s.resting.store(false, Ordering::Relaxed);
                            s.last_callback.store(now_ms(), Ordering::Relaxed);     // (so the watchdog gives it a moment)
                            note(&s, "Music again: the sound output is back on.".into());
                        }
                        continue;
                    }
                    let since = now_ms().saturating_sub(s.last_callback.load(Ordering::Relaxed));
                    if opened.elapsed() > Duration::from_secs(3) && since > 2000 { stalled = true; break; }
                }
                drop(stream);
                s.resting.store(false, Ordering::Relaxed);
                if resize { continue; }
                exclusive_failed(&s);
                if stalled {
                    reopens.retain(|t| t.elapsed() < Duration::from_secs(60));
                    reopens.push(Instant::now());
                    let wait = (1u64 << (reopens.len() - 1).min(5)).min(30);
                    note(&s, format!("The sound output stopped asking for sound: opening it again in {wait} s."));
                    std::thread::sleep(Duration::from_secs(wait));
                } else {
                    note(&s, "Opening the sound output again.".into());
                    std::thread::sleep(Duration::from_millis(300));
                }
            }
            Err(e) => {
                note(&s, format!("No sound output ({e}). Playing silently and trying again in 5 s."));
                *s.output.lock().unwrap() = "none (silent)".into();
                let started = Instant::now();
                let mut taken: u64 = 0;
                while started.elapsed() < Duration::from_secs(5) {
                    std::thread::sleep(Duration::from_millis(10));
                    let due = (started.elapsed().as_secs_f64() * RATE as f64) as u64;
                    let mut st = s.st.lock().unwrap();
                    while taken < due { st.tick(); let _ = st.next_frame(); taken += 1; }
                }
            }
        }
    }
}

fn open_output(s: &Arc<Shared>) -> Result<cpal::Stream, String> {
    mac_apply(s);
    // A buffer you set for this output, or the automatic one (which grows if the output can't keep up).
    let id = current_device(s).0;
    match s.settings.get("bufferProfiles").get(&id).and_then(Value::as_u64) {
        Some(f) if f > 0 => { s.buffer_frames.store((f as u32).clamp(256, BUFFER_FRAMES_MAX), Ordering::Relaxed); s.buffer_fixed.store(true, Ordering::Relaxed); }
        _ => if s.buffer_fixed.swap(false, Ordering::Relaxed) { s.buffer_frames.store(BUFFER_FRAMES, Ordering::Relaxed); },
    }
    let device = find_device(s).ok_or("no output device")?;
    let name = device.name().unwrap_or_else(|_| "unknown".into());
    // 44.1 kHz if the output can do it, so nothing needs converting; otherwise its own rate.
    let default = device.default_output_config().map_err(|e| e.to_string())?;
    let config = device.supported_output_configs().ok()
        .and_then(|mut list| list.find(|c| c.channels() >= 2 && c.sample_format() == cpal::SampleFormat::F32
            && c.min_sample_rate().0 <= RATE && c.max_sample_rate().0 >= RATE))
        .map(|c| c.with_sample_rate(cpal::SampleRate(RATE)))
        .unwrap_or(default);
    let format = config.sample_format();
    // A fixed buffer. Left to choose, ALSA can pick one so small that a busy computer (or a virtual
    // machine) doesn't refill it in time, which is heard as crackles and gaps.
    let frames = match config.buffer_size() {
        cpal::SupportedBufferSize::Range { min, max } => Some(s.buffer_frames.load(Ordering::Relaxed).clamp(*min, *max)),
        cpal::SupportedBufferSize::Unknown => None,
    };
    let mut config: cpal::StreamConfig = config.into();
    s.rate.store(config.sample_rate.0, Ordering::Relaxed);
    *s.out_format.lock().unwrap() = (format!("{format:?}"), config.channels);
    if let Some(f) = frames { config.buffer_size = cpal::BufferSize::Fixed(f); }
    *s.output.lock().unwrap() = format!("{name} ({} Hz, {} channels, {format:?}, buffer {})", config.sample_rate.0, config.channels,
        frames.map(|f| format!("{f} frames")).unwrap_or_else(|| "chosen by the system".into()));
    note(s, format!("Playing through {}", s.output.lock().unwrap()));
    let stream = match build_any(&device, &config, format, s) {
        Ok(st) => st,
        Err(e) if frames.is_some() => {
            note(s, format!("The output refused a {}-frame buffer ({e}); letting it choose.", frames.unwrap_or(0)));
            config.buffer_size = cpal::BufferSize::Default;
            build_any(&device, &config, format, s)?
        }
        Err(e) => return Err(e),
    };
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

fn build_any(device: &cpal::Device, config: &cpal::StreamConfig, format: cpal::SampleFormat, s: &Arc<Shared>) -> Result<cpal::Stream, String> {
    match format {
        cpal::SampleFormat::F32 => build::<f32>(device, config, s.clone()),
        cpal::SampleFormat::I16 => build::<i16>(device, config, s.clone()),
        cpal::SampleFormat::U16 => build::<u16>(device, config, s.clone()),
        cpal::SampleFormat::I32 => build::<i32>(device, config, s.clone()),
        other => Err(format!("unsupported sample format {other:?}")),
    }
}

fn build<T>(device: &cpal::Device, config: &cpal::StreamConfig, s: Arc<Shared>) -> Result<cpal::Stream, String>
where T: cpal::SizedSample + cpal::FromSample<f32> {
    let channels = config.channels as usize;
    // How far through librespot's sound one output frame moves (1.0 when the rates match).
    let step = RATE as f64 / config.sample_rate.0 as f64;
    let mut frac = 1.0f64;
    let (mut prev, mut cur) = ((0f32, 0f32), (0f32, 0f32));
    let mut mono: Vec<f32> = Vec::with_capacity(16384);
    let broken = s.clone();
    device.build_output_stream(
        config,
        move |data: &mut [T], _| {
            let frames = data.len() / channels;
            let meter = s.meter_on.load(Ordering::Relaxed);
            let (mut played, mut peak) = (0u64, 0f32);
            mono.clear();
            {
                let mut st = s.st.lock().unwrap();
                st.tick();
                for frame in data.chunks_mut(channels) {
                    while frac >= 1.0 {
                        prev = cur;
                        let (f, has) = st.next_frame();
                        cur = f;
                        if has { played += 1; peak = peak.max(f.0.abs()).max(f.1.abs()); }
                        if meter { mono.push((f.0 + f.1) * 0.5); }
                        frac -= 1.0;
                    }
                    let t = frac as f32;
                    let l = prev.0 + (cur.0 - prev.0) * t;
                    let r = prev.1 + (cur.1 - prev.1) * t;
                    for (c, out) in frame.iter_mut().enumerate() {
                        *out = T::from_sample(match c { 0 => l, 1 => r, _ => 0.0 });
                    }
                    frac += step;
                }
            }
            if meter && !mono.is_empty() {
                if let Ok(mut tap) = s.tap.try_lock() {
                    tap.extend(mono.iter().copied());
                    let extra = tap.len().saturating_sub(dsp::FFT_SIZE);
                    tap.drain(..extra);
                }
            }
            s.called.fetch_add(frames as u64, Ordering::Relaxed);
            s.last_callback.store(now_ms(), Ordering::Relaxed);
            s.played.fetch_add(played, Ordering::Relaxed);
            let was = f32::from_bits(s.peak.load(Ordering::Relaxed) as u32);
            if peak > was { s.peak.store(peak.to_bits() as u64, Ordering::Relaxed); }
        },
        move |err| {
            log::warn!("sound output error: {err}");
            broken.broken.store(true, Ordering::SeqCst);
        },
        None,
    ).map_err(|e| e.to_string())
}

/// Levels for the visualizer and the EQ meters, about 30 times a second while a page shows them. When
/// it's quiet, one all-zero frame is sent so the meters settle, then nothing until sound comes back.
fn levels_thread(s: Arc<Shared>) {
    let mut spectrum = dsp::Spectrum::default();
    let mut was_silent = false;
    let mut samples = vec![0f32; dsp::FFT_SIZE];
    loop {
        // About 30 times a second while a page shows meters; otherwise just a look a few times a second.
        if !s.meter_on.load(Ordering::Relaxed) { std::thread::sleep(Duration::from_millis(250)); continue; }
        std::thread::sleep(Duration::from_millis(33));
        {
            let tap = s.tap.lock().unwrap();
            if tap.is_empty() { continue; }
            let skip = dsp::FFT_SIZE.saturating_sub(tap.len());
            for v in samples.iter_mut().take(skip) { *v = 0.0; }
            for (i, v) in tap.iter().enumerate().take(dsp::FFT_SIZE) { samples[skip + i] = *v; }
        }
        let quiet = samples.iter().all(|v| v.abs() < 1e-5);
        if quiet && was_silent { continue; }
        let (spec, eq) = spectrum.levels(&samples);
        let silent = spec.iter().all(|&v| v == 0.0);
        if silent && was_silent { continue; }
        was_silent = silent;
        // Three decimals is far finer than any meter can show, and a third of the text to send 30 times a second.
        let short = |v: Vec<f64>| v.into_iter().map(|x| (x * 1000.0).round() / 1000.0).collect::<Vec<_>>();
        (s.emit)("eq.levels", json!({"spec": short(spec), "eq": short(eq)}));
    }
}

/// Every 5 s while anything is happening, a line in the log: how much sound came from librespot, how
/// much the output played and how loud. If the output can't keep up, its buffer is made bigger.
fn report(s: Arc<Shared>) {
    let mut quiet_reported = false;
    let mut slow: i32 = -1;          // the first window after start-up is a partial one
    loop {
        std::thread::sleep(Duration::from_secs(5));
        let received = s.received.swap(0, Ordering::Relaxed);
        let called = s.called.swap(0, Ordering::Relaxed);
        let played = s.played.swap(0, Ordering::Relaxed);
        let peak = f32::from_bits(s.peak.swap(0, Ordering::Relaxed) as u32);
        if received == 0 && played == 0 {
            if !quiet_reported && !s.resting.load(Ordering::Relaxed) && !s.output.lock().unwrap().starts_with("none") {
                quiet_reported = true;
                note(&s, if called == 0 { "Sound report: the output isn't asking for sound at all.".into() }
                         else { "Sound report: the output is running; nothing from librespot yet.".into() });
            }
            continue;
        }
        quiet_reported = false;
        let rate = s.rate.load(Ordering::Relaxed) as f64;
        if slow < 0 { slow = 0; } else if played > 0 && (called as f64) < rate * 5.0 * 0.85 { slow += 1; } else { slow = 0; }
        let size = s.buffer_frames.load(Ordering::Relaxed);
        if slow >= 2 && size < BUFFER_FRAMES_MAX {
            slow = -1;
            s.buffer_frames.store(size * 2, Ordering::Relaxed);
            note(&s, format!("The output is falling behind (asked for {:.1} s of 5 s): trying a bigger buffer ({} frames).", called as f64 / rate, size * 2));
            s.too_slow.store(true, Ordering::SeqCst);
        }
        let level = if peak > 0.0 { format!("{:.0} dB", 20.0 * peak.log10()) } else { "silent".into() };
        let (ein, eout) = { let mut st = s.st.lock().unwrap(); let e = (st.energy_in, st.energy_out); st.energy_in = 0.0; st.energy_out = 0.0; e };
        let eq = if ein > 0.0 && eout > 0.0 { format!(", the EQ changes the level by {:+.1} dB", 10.0 * (eout / ein).log10()) } else { String::new() };
        note(&s, format!("Sound report (5 s): from librespot {:.1} s, played {:.1} s of {:.1} s asked for, loudest {level}{eq}",
            received as f64 / RATE as f64, played as f64 / RATE as f64, called as f64 / rate));
    }
}

#[cfg(test)]
mod mem_pipe_tests {
    use super::*;
    #[test]
    fn carries_sound_and_waits_when_full() {
        let p = MemPipe::new();
        let w = p.clone();
        // More than fits at once: the writer has to wait for the reader.
        let writer = std::thread::spawn(move || w.write(&vec![7u8; MemPipe::CAP * 3]));
        std::thread::sleep(Duration::from_millis(50));
        assert!(p.waiting() <= MemPipe::CAP);
        let mut r = MemReader(p.clone());
        let mut got = 0;
        let mut buf = vec![0u8; 5000];
        while got < MemPipe::CAP * 3 { let n = r.read(&mut buf).unwrap(); assert!(buf[..n].iter().all(|b| *b == 7)); got += n; }
        assert!(writer.join().unwrap());
        p.close();
        assert_eq!(r.read(&mut buf).unwrap(), 0);
        assert!(!p.write(&[1, 2, 3, 4]));
    }
}
