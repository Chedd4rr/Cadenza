//! Cadenza's sound output. librespot sends its audio here (16-bit stereo at 44.1 kHz on its standard
//! output, `--backend pipe`), and this plays it on the system's output with cpal (CoreAudio, WASAPI,
//! PipeWire/ALSA).
//!
//! Between the two sits a short buffer (a quarter of a second). librespot can only write as fast as the
//! output takes the sound, which is what keeps it playing in real time. The EQ, limiter, crossfade and
//! visualizer from the Swift engine come in phase 3; for now the sound goes straight through.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const RATE: u32 = 44_100;
/// The output's own buffer, in frames (about 45 ms at 44.1 kHz).
const BUFFER_FRAMES: u32 = 2048;
const BUFFER_SAMPLES: usize = (RATE as usize / 4) * 2;       // a quarter of a second, two channels

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

struct Shared {
    /// When sound last arrived from librespot (ms since 1970), for the "is anything coming through" checks.
    last_audio: AtomicU64,
    /// The output stopped working (unplugged, the sound server restarted): open it again.
    broken: AtomicBool,
    /// What's playing the sound, for diagnostics.
    output: Mutex<String>,
    log: Mutex<Vec<String>>,
}

pub struct Sound {
    shared: Arc<Shared>,
    producer: Arc<Mutex<HeapProd<f32>>>,
}

impl Sound {
    /// Starts the output thread. It keeps the output open for as long as Cadenza runs, and opens it again
    /// if it stops working.
    pub fn start() -> Arc<Self> {
        let (prod, cons) = HeapRb::<f32>::new(BUFFER_SAMPLES).split();
        let shared = Arc::new(Shared {
            last_audio: AtomicU64::new(0),
            broken: AtomicBool::new(false),
            output: Mutex::new("none yet".into()),
            log: Mutex::new(vec![]),
        });
        let consumer = Arc::new(Mutex::new(cons));
        let s = shared.clone();
        std::thread::Builder::new().name("cadenza-output".into()).spawn(move || output_thread(s, consumer)).ok();
        Arc::new(Sound { shared, producer: Arc::new(Mutex::new(prod)) })
    }

    pub fn seconds_since_audio(&self) -> f64 {
        let at = self.shared.last_audio.load(Ordering::Relaxed);
        if at == 0 { return f64::INFINITY; }
        now_ms().saturating_sub(at) as f64 / 1000.0
    }

    pub fn output_name(&self) -> String { self.shared.output.lock().unwrap().clone() }

    pub fn take_log(&self) -> Vec<String> { std::mem::take(&mut *self.shared.log.lock().unwrap()) }

    /// Reads librespot's audio until it closes its output (it quit or was restarted).
    pub fn attach<R: Read + Send + 'static>(&self, mut pipe: R) {
        let producer = self.producer.clone();
        let shared = self.shared.clone();
        std::thread::Builder::new().name("cadenza-pipe".into()).spawn(move || {
            let mut bytes = [0u8; 8192];
            let mut carry: Option<u8> = None;                 // half a sample left over from the last read
            let mut samples: Vec<f32> = Vec::with_capacity(4100);
            loop {
                let mut n = match pipe.read(&mut bytes) { Ok(0) | Err(_) => break, Ok(n) => n };
                // librespot prints its sign-in link on standard output, which is the sound in pipe mode.
                // Leave those lines out instead of playing them as a burst of noise (it opens the link
                // in your browser itself).
                if carry.is_none() && (bytes[..n].starts_with(b"Browse to: ") || bytes[..n].starts_with(b"If prompted") || bytes[..n].starts_with(b"Provide redirect")) {
                    let end = bytes[..n].iter().position(|b| *b == b'\n').map(|i| i + 1).unwrap_or(n);
                    bytes.copy_within(end..n, 0);
                    n -= end;
                    if n == 0 { continue; }
                }
                samples.clear();
                let mut i = 0;
                if let Some(lo) = carry.take() {
                    samples.push(i16::from_le_bytes([lo, bytes[0]]) as f32 / 32768.0);
                    i = 1;
                }
                while i + 1 < n {
                    samples.push(i16::from_le_bytes([bytes[i], bytes[i + 1]]) as f32 / 32768.0);
                    i += 2;
                }
                if i < n { carry = Some(bytes[i]); }
                shared.last_audio.store(now_ms(), Ordering::Relaxed);
                // Hand it over as room frees up. Waiting here is what paces librespot.
                let mut done = 0;
                while done < samples.len() {
                    let pushed = producer.lock().unwrap().push_slice(&samples[done..]);
                    done += pushed;
                    if pushed == 0 { std::thread::sleep(Duration::from_millis(3)); }
                }
            }
        }).ok();
    }
}

fn note(shared: &Shared, line: String) {
    log::info!("{line}");
    let mut l = shared.log.lock().unwrap();
    l.push(line);
    if l.len() > 50 { l.remove(0); }
}

/// Keeps an output open. With no output at all (a server, a test machine) the sound is taken at real-time
/// speed anyway, so librespot keeps playing and the position keeps moving.
fn output_thread(shared: Arc<Shared>, consumer: Arc<Mutex<HeapCons<f32>>>) {
    loop {
        shared.broken.store(false, Ordering::SeqCst);
        match open_output(&shared, consumer.clone()) {
            Ok(stream) => {
                while !shared.broken.load(Ordering::SeqCst) { std::thread::sleep(Duration::from_millis(250)); }
                drop(stream);
                note(&shared, "The sound output stopped working: opening it again.".into());
                std::thread::sleep(Duration::from_millis(500));
            }
            Err(e) => {
                note(&shared, format!("No sound output ({e}). Playing silently and trying again in 5 s."));
                *shared.output.lock().unwrap() = "none (silent)".into();
                // Take the sound at real-time speed for 5 s, then try the output again.
                let started = std::time::Instant::now();
                let mut taken: u64 = 0;
                let mut sink = vec![0f32; 882];
                while started.elapsed() < Duration::from_secs(5) {
                    std::thread::sleep(Duration::from_millis(10));
                    let due = (started.elapsed().as_secs_f64() * RATE as f64) as u64 * 2;
                    while taken < due {
                        let want = ((due - taken) as usize).min(sink.len());
                        let got = consumer.lock().unwrap().pop_slice(&mut sink[..want]);
                        if got == 0 { taken = due; break; }
                        taken += got as u64;
                    }
                }
            }
        }
    }
}

fn open_output(shared: &Arc<Shared>, consumer: Arc<Mutex<HeapCons<f32>>>) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("no output device")?;
    let name = device.name().unwrap_or_else(|_| "unknown".into());

    // 44.1 kHz if the output can do it, so nothing needs converting; otherwise its own rate.
    let default = device.default_output_config().map_err(|e| e.to_string())?;
    let config = device.supported_output_configs().ok()
        .and_then(|mut list| list.find(|c| c.channels() >= 2 && c.sample_format() == cpal::SampleFormat::F32
            && c.min_sample_rate().0 <= RATE && c.max_sample_rate().0 >= RATE))
        .map(|c| c.with_sample_rate(cpal::SampleRate(RATE)))
        .unwrap_or(default);
    let format = config.sample_format();
    // A fixed buffer of about 45 ms. Left to choose, ALSA can pick one so small that a busy computer
    // (or a virtual machine) doesn't refill it in time, which is heard as crackles and gaps.
    let frames = match config.buffer_size() {
        cpal::SupportedBufferSize::Range { min, max } => Some(BUFFER_FRAMES.clamp(*min, *max)),
        cpal::SupportedBufferSize::Unknown => None,
    };
    let mut config: cpal::StreamConfig = config.into();
    if let Some(f) = frames { config.buffer_size = cpal::BufferSize::Fixed(f); }
    *shared.output.lock().unwrap() = format!("{name} ({} Hz, {} channels, {format:?}, buffer {})", config.sample_rate.0, config.channels,
        frames.map(|f| format!("{f} frames")).unwrap_or_else(|| "chosen by the system".into()));
    note(shared, format!("Playing through {}", shared.output.lock().unwrap()));

    let stream = match build_any(&device, &config, format, shared, consumer.clone()) {
        Ok(s) => s,
        Err(e) if frames.is_some() => {
            note(shared, format!("The output refused a {BUFFER_FRAMES}-frame buffer ({e}); letting it choose."));
            config.buffer_size = cpal::BufferSize::Default;
            build_any(&device, &config, format, shared, consumer)?
        }
        Err(e) => return Err(e),
    };
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

fn build_any(device: &cpal::Device, config: &cpal::StreamConfig, format: cpal::SampleFormat, shared: &Arc<Shared>,
             consumer: Arc<Mutex<HeapCons<f32>>>) -> Result<cpal::Stream, String> {
    let stream = match format {
        cpal::SampleFormat::F32 => build::<f32>(device, config, shared.clone(), consumer),
        cpal::SampleFormat::I16 => build::<i16>(device, config, shared.clone(), consumer),
        cpal::SampleFormat::U16 => build::<u16>(device, config, shared.clone(), consumer),
        cpal::SampleFormat::I32 => build::<i32>(device, config, shared.clone(), consumer),
        other => return Err(format!("unsupported sample format {other:?}")),
    }?;
    Ok(stream)
}

fn build<T>(device: &cpal::Device, config: &cpal::StreamConfig, shared: Arc<Shared>, consumer: Arc<Mutex<HeapCons<f32>>>)
    -> Result<cpal::Stream, String>
where T: cpal::SizedSample + cpal::FromSample<f32> {
    let channels = config.channels as usize;
    // How far through librespot's sound one output frame moves (1.0 when the rates match).
    let step = RATE as f64 / config.sample_rate.0 as f64;
    let mut frac = 1.0f64;
    let mut prev = [0f32; 2];
    let mut cur = [0f32; 2];
    // Sound taken from the buffer but not played yet (when the rates differ, a callback can need a
    // frame more or less than it took).
    let mut pending: std::collections::VecDeque<f32> = std::collections::VecDeque::with_capacity(16384);
    let mut scratch = vec![0f32; 16384];
    let broken = shared.clone();
    device.build_output_stream(
        config,
        move |data: &mut [T], _| {
            let frames = data.len() / channels;
            let need = ((frames as f64 * step).ceil() as usize + 2) * 2;
            if pending.len() < need {
                let want = (need - pending.len()).min(scratch.len());
                // try_lock: the reader only holds the lock for a moment, and the output must never wait.
                if let Ok(mut c) = consumer.try_lock() {
                    let got = c.pop_slice(&mut scratch[..want]);
                    pending.extend(&scratch[..got]);
                }
            }
            for frame in data.chunks_mut(channels) {
                while frac >= 1.0 {
                    prev = cur;
                    cur = match (pending.pop_front(), pending.pop_front()) {
                        (Some(l), Some(r)) => [l, r],
                        _ => [0.0, 0.0],                  // ran dry: silence until more arrives
                    };
                    frac -= 1.0;
                }
                let t = frac as f32;
                let l = prev[0] + (cur[0] - prev[0]) * t;
                let r = prev[1] + (cur[1] - prev[1]) * t;
                for (c, out) in frame.iter_mut().enumerate() {
                    let v = match c { 0 => l, 1 => r, _ => 0.0 };
                    *out = T::from_sample(v);
                }
                frac += step;
            }
        },
        move |err| {
            log::warn!("sound output error: {err}");
            broken.broken.store(true, Ordering::SeqCst);
        },
        None,
    ).map_err(|e| e.to_string())
}
