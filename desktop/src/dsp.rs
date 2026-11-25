//! The sound processing, sample by sample: the 10-band EQ, the peak limiter, volume ramps and the
//! spectrum analysis for the visualizer. Everything runs at librespot's 44.1 kHz, before the sound is
//! converted to the output's own rate.

use std::f64::consts::PI;

pub const RATE: f64 = 44_100.0;
pub const FREQS: [f64; 10] = [32.0, 64.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];

// MARK: EQ

#[derive(Clone, Copy, Default)]
struct Biquad { b0: f64, b1: f64, b2: f64, a1: f64, a2: f64 }

#[derive(Clone, Copy, Default)]
struct BiquadState { x1: f64, x2: f64, y1: f64, y2: f64 }

impl Biquad {
    /// The standard "Audio EQ Cookbook" filters (Robert Bristow-Johnson), which is also what Apple's
    /// AVAudioUnitEQ uses: a peak with a bandwidth in octaves, and shelves with a slope of 1.
    fn peaking(f: f64, gain_db: f64, octaves: f64) -> Self {
        let a = 10f64.powf(gain_db / 40.0);
        let w = 2.0 * PI * f / RATE;
        let alpha = w.sin() * ((2f64.ln() / 2.0) * octaves * w / w.sin()).sinh();
        Self::norm(1.0 + alpha * a, -2.0 * w.cos(), 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * w.cos(), 1.0 - alpha / a)
    }
    /// A peak with its width given as Q (what headphone EQ profiles use).
    fn peaking_q(f: f64, gain_db: f64, q: f64) -> Self {
        let a = 10f64.powf(gain_db / 40.0);
        let w = 2.0 * PI * f / RATE;
        let alpha = w.sin() / (2.0 * q);
        Self::norm(1.0 + alpha * a, -2.0 * w.cos(), 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * w.cos(), 1.0 - alpha / a)
    }
    fn shelf(f: f64, gain_db: f64, high: bool) -> Self { Self::shelf_q(f, gain_db, std::f64::consts::FRAC_1_SQRT_2, high) }
    /// A shelf with its slope given as Q (0.707 is the usual "slope of 1").
    fn shelf_q(f: f64, gain_db: f64, q: f64, high: bool) -> Self {
        let a = 10f64.powf(gain_db / 40.0);
        let w = 2.0 * PI * f / RATE;
        let (c, s) = (w.cos(), w.sin());
        let alpha = s / (2.0 * q);
        let k = 2.0 * a.sqrt() * alpha;
        if high {
            Self::norm(a * ((a + 1.0) + (a - 1.0) * c + k), -2.0 * a * ((a - 1.0) + (a + 1.0) * c), a * ((a + 1.0) + (a - 1.0) * c - k),
                       (a + 1.0) - (a - 1.0) * c + k, 2.0 * ((a - 1.0) - (a + 1.0) * c), (a + 1.0) - (a - 1.0) * c - k)
        } else {
            Self::norm(a * ((a + 1.0) - (a - 1.0) * c + k), 2.0 * a * ((a - 1.0) - (a + 1.0) * c), a * ((a + 1.0) - (a - 1.0) * c - k),
                       (a + 1.0) + (a - 1.0) * c + k, -2.0 * ((a - 1.0) + (a + 1.0) * c), (a + 1.0) + (a - 1.0) * c - k)
        }
    }
    fn norm(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Self {
        Biquad { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
    }
    #[inline]
    fn run(&self, s: &mut BiquadState, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * s.x1 + self.b2 * s.x2 - self.a1 * s.y1 - self.a2 * s.y2;
        s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y;
        y
    }
    /// The filter's gain at a frequency, in dB (for tests and checking against Apple's curves).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn response_db(&self, f: f64) -> f64 {
        let w = 2.0 * PI * f / RATE;
        let (c1, s1, c2, s2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
        let (nr, ni) = (self.b0 + self.b1 * c1 + self.b2 * c2, -(self.b1 * s1 + self.b2 * s2));
        let (dr, di) = (1.0 + self.a1 * c1 + self.a2 * c2, -(self.a1 * s1 + self.a2 * s2));
        10.0 * ((nr * nr + ni * ni) / (dr * dr + di * di)).log10()
    }
}

/// One filter of the parametric EQ: a peak or a shelf at any frequency, with any gain and width.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind { Peak, LowShelf, HighShelf, Off }

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Filter { pub kind: Kind, pub freq: f64, pub gain: f64, pub q: f64 }

/// Up to this many filters (what headphone profiles from AutoEq use).
pub const MAX_FILTERS: usize = 10;

impl Filter {
    /// Kept to what the filters can do well: 20 Hz–20 kHz, ±15 dB, Q 0.1–10.
    pub fn clamped(self) -> Self {
        Filter { kind: self.kind, freq: self.freq.clamp(20.0, 20000.0), gain: self.gain.clamp(-15.0, 15.0), q: self.q.clamp(0.1, 10.0) }
    }
    fn biquad(&self) -> Biquad {
        let f = self.clamped();
        match f.kind {
            Kind::Peak => Biquad::peaking_q(f.freq, f.gain, f.q),
            Kind::LowShelf => Biquad::shelf_q(f.freq, f.gain, f.q, false),
            Kind::HighShelf => Biquad::shelf_q(f.freq, f.gain, f.q, true),
            Kind::Off => Biquad::norm(1.0, 0.0, 0.0, 1.0, 0.0, 0.0),
        }
    }
    pub fn code(&self) -> &'static str { match self.kind { Kind::Peak => "PK", Kind::LowShelf => "LSC", Kind::HighShelf => "HSC", Kind::Off => "OFF" } }
    pub fn kind_from(code: &str) -> Option<Kind> {
        match code.to_ascii_uppercase().as_str() {
            "PK" | "PEQ" | "MODAL" => Some(Kind::Peak),
            "LS" | "LSC" | "LSQ" => Some(Kind::LowShelf),
            "HS" | "HSC" | "HSQ" => Some(Kind::HighShelf),
            "OFF" => Some(Kind::Off),
            _ => None,
        }
    }
}

/// A headphone EQ file in Equalizer APO's format, which AutoEq makes ("…ParametricEQ.txt"):
///   Preamp: -6.1 dB
///   Filter 1: ON PK Fc 105 Hz Gain 6.4 dB Q 0.70
/// Returns the preamp, the filters (at most MAX_FILTERS) and how many lines were left out (other kinds of
/// filter, ones switched off, or too many).
pub fn parse_apo(text: &str) -> (f64, Vec<Filter>, usize) {
    let (mut pre, mut list, mut skipped) = (0.0, vec![], 0usize);
    let num = |w: Option<&&str>| w.and_then(|v| v.replace(',', ".").parse::<f64>().ok());
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Preamp:") {
            if let Some(v) = num(rest.split_whitespace().collect::<Vec<_>>().first()) { pre = v; }
            continue;
        }
        if !line.starts_with("Filter") { continue; }
        let Some((_, rest)) = line.split_once(':') else { continue };
        let w: Vec<&str> = rest.split_whitespace().collect();
        if w.first().map(|x| x.eq_ignore_ascii_case("ON")) != Some(true) { skipped += 1; continue; }
        let Some(kind) = w.get(1).and_then(|c| Filter::kind_from(c)) else { skipped += 1; continue };
        let find = |key: &str| w.iter().position(|x| x.eq_ignore_ascii_case(key)).and_then(|i| num(w.get(i + 1)));
        let (Some(freq), gain) = (find("Fc"), find("Gain").unwrap_or(0.0)) else { skipped += 1; continue };
        // A shelf without a Q ("LS 6dB") means the usual slope.
        let q = find("Q").unwrap_or(if kind == Kind::Peak { 1.41 } else { std::f64::consts::FRAC_1_SQRT_2 });
        if list.len() >= MAX_FILTERS { skipped += 1; continue; }
        list.push(Filter { kind, freq, gain, q }.clamped());
    }
    (pre, list, skipped)
}

/// The EQ: either the 10-band graphic one (a low shelf at 32 Hz, peaks one octave wide from 64 Hz to 8 kHz,
/// a high shelf at 16 kHz) or up to 10 parametric filters; and a preamp.
pub struct Eq {
    bands: [Biquad; 10],
    state: [[BiquadState; 10]; 2],
    preamp: f64,
    on: bool,
}

impl Default for Eq {
    fn default() -> Self { Eq { bands: [Biquad::norm(1.0, 0.0, 0.0, 1.0, 0.0, 0.0); 10], state: Default::default(), preamp: 1.0, on: false } }
}

impl Eq {
    /// The parametric EQ: these filters (unused places pass the sound through).
    pub fn set_filters(&mut self, on: bool, preamp_db: f64, filters: &[Filter]) {
        self.on = on;
        self.preamp = if on { 10f64.powf(preamp_db / 20.0) } else { 1.0 };
        for i in 0..10 {
            self.bands[i] = filters.get(i).map(|f| f.biquad()).unwrap_or(Biquad::norm(1.0, 0.0, 0.0, 1.0, 0.0, 0.0));
        }
    }
    pub fn set(&mut self, on: bool, preamp_db: f64, gains: &[f64]) {
        self.on = on;
        self.preamp = if on { 10f64.powf(preamp_db / 20.0) } else { 1.0 };
        for i in 0..10 {
            let g = gains.get(i).copied().unwrap_or(0.0).clamp(-12.0, 12.0);
            self.bands[i] = match i {
                0 => Biquad::shelf(FREQS[i], g, false),
                9 => Biquad::shelf(FREQS[i], g, true),
                _ => Biquad::peaking(FREQS[i], g, 1.0),
            };
        }
    }
    #[inline]
    pub fn run(&mut self, l: f32, r: f32) -> (f32, f32) {
        if !self.on { return (l, r); }
        let (mut a, mut b) = (l as f64 * self.preamp, r as f64 * self.preamp);
        for i in 0..10 {
            a = self.bands[i].run(&mut self.state[0][i], a);
            b = self.bands[i].run(&mut self.state[1][i], b);
        }
        (a as f32, b as f32)
    }
    /// The whole EQ's gain at a frequency, in dB (preamp included).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn response_db(&self, f: f64) -> f64 {
        if !self.on { return 0.0; }
        20.0 * self.preamp.log10() + self.bands.iter().map(|b| b.response_db(f)).sum::<f64>()
    }
}

// MARK: limiter

/// A look-ahead peak limiter, so boosting never clips: the sound is delayed 5 ms, and the volume comes
/// down just before a peak arrives, then recovers over about 50 ms. Nothing changes while the sound stays under the ceiling.
pub struct Limiter {
    delay: Vec<(f32, f32)>,
    pos: usize,
    need: Vec<f32>,                     // the gain each delayed sample needs
    gain: f32,
    attack: f32,
    release: f32,
}

pub const CEILING: f32 = 0.977;         // about -0.2 dB below full scale
const LOOKAHEAD: usize = 220;           // 5 ms

impl Default for Limiter {
    fn default() -> Self {
        Limiter {
            delay: vec![(0.0, 0.0); LOOKAHEAD], pos: 0, need: vec![1.0; LOOKAHEAD], gain: 1.0,
            attack: 1.0 - (-1.0 / (LOOKAHEAD as f32 / 4.0)).exp(),
            release: 1.0 - (-1.0 / (0.05 * RATE as f32)).exp(),
        }
    }
}

impl Limiter {
    #[inline]
    pub fn run(&mut self, l: f32, r: f32) -> (f32, f32) {
        let peak = l.abs().max(r.abs());
        let need = if peak > CEILING { CEILING / peak } else { 1.0 };
        let (dl, dr) = self.delay[self.pos];
        self.delay[self.pos] = (l, r);
        self.need[self.pos] = need;
        self.pos = (self.pos + 1) % LOOKAHEAD;
        // The lowest gain anything in the next 5 ms will need. (Only scanned while a peak is near: most of
        // the time everything needs 1.0 and this costs nothing.)
        let target = if need < 1.0 || self.gain < 0.9999 { self.need.iter().copied().fold(1.0f32, f32::min) } else { 1.0 };
        self.gain += (target - self.gain) * if target < self.gain { self.attack } else { self.release };
        // A last safety net for the sample right at the front of a sudden peak.
        ((dl * self.gain).clamp(-CEILING, CEILING), (dr * self.gain).clamp(-CEILING, CEILING))
    }
}

// MARK: channels

/// Balance, mono, swapping left and right, and flipping polarity, applied last.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Channels { pub balance: f32, pub mono: bool, pub swap: bool, pub invert: bool }

impl Default for Channels { fn default() -> Self { Channels { balance: 0.0, mono: false, swap: false, invert: false } } }

impl Channels {
    pub fn neutral(&self) -> bool { *self == Channels::default() }
    /// `balance`: −1 (left only) … 0 (centre) … 1 (right only). The other side is turned down; the louder
    /// side stays as it was, so moving the balance never makes anything louder.
    #[inline]
    pub fn run(&self, l: f32, r: f32) -> (f32, f32) {
        let (mut l, mut r) = if self.mono { let m = (l + r) * 0.5; (m, m) } else { (l, r) };
        if self.swap { std::mem::swap(&mut l, &mut r); }
        if self.balance > 0.0 { l *= 1.0 - self.balance.min(1.0); } else if self.balance < 0.0 { r *= 1.0 + self.balance.max(-1.0); }
        if self.invert { (-l, -r) } else { (l, r) }
    }
}

/// A test tone to check which speaker is which: 1 kHz, about −18 dB, 1.5 s, eased in and out (no clicks).
pub struct Tone { left: bool, right: bool, n: u32 }

pub const TONE_FRAMES: u32 = (RATE * 1.5) as u32;

impl Tone {
    pub fn new(left: bool, right: bool) -> Self { Tone { left, right, n: 0 } }
    pub fn done(&self) -> bool { self.n >= TONE_FRAMES }
    #[inline]
    pub fn next(&mut self) -> (f32, f32) {
        if self.done() { return (0.0, 0.0); }
        let t = self.n as f64;
        let ease = (t.min((TONE_FRAMES as f64) - t) / (0.02 * RATE)).min(1.0);
        let v = ((2.0 * PI * 1000.0 * t / RATE).sin() * 0.125 * ease) as f32;
        self.n += 1;
        (if self.left { v } else { 0.0 }, if self.right { v } else { 0.0 })
    }
}

// MARK: ramps

#[derive(Clone, Copy, PartialEq)]
pub enum Curve { Smooth, Linear }

/// A volume that moves from one value to another over a number of samples.
#[derive(Clone, Copy)]
pub struct Ramp { from: f32, to: f32, t: u32, len: u32, curve: Curve }

impl Ramp {
    pub fn at(v: f32) -> Self { Ramp { from: v, to: v, t: 0, len: 0, curve: Curve::Linear } }
    pub fn go(&mut self, to: f32, seconds: f64, curve: Curve) {
        let now = self.value();
        let len = (seconds * RATE).round().max(0.0) as u32;
        *self = if len == 0 { Ramp::at(to) } else { Ramp { from: now, to, t: 0, len, curve } };
    }
    pub fn set(&mut self, v: f32) { *self = Ramp::at(v); }
    pub fn moving(&self) -> bool { self.t < self.len }
    pub fn target(&self) -> f32 { self.to }
    #[inline]
    pub fn value(&self) -> f32 {
        if self.t >= self.len { return self.to; }
        let x = self.t as f32 / self.len as f32;
        let k = match self.curve { Curve::Smooth => x * x * (3.0 - 2.0 * x), Curve::Linear => x };
        self.from + (self.to - self.from) * k
    }
    #[inline]
    pub fn step(&mut self) -> f32 { let v = self.value(); if self.t < self.len { self.t += 1; } v }
}

// MARK: spectrum

pub const FFT_SIZE: usize = 4096;
pub const SPEC_BANDS: usize = 48;

/// The visualizer's levels from the latest 4096 samples (mono, after the EQ): 48 bands spaced evenly in
/// pitch from 35 Hz to 16 kHz, and the 10 EQ bands, each 0–1. Treble is lifted 3 dB per octave so it shows
/// up as clearly as bass.
pub struct Spectrum {
    fft: std::sync::Arc<dyn rustfft::Fft<f32>>,
    window: Vec<f32>,
    buf: Vec<rustfft::num_complex::Complex<f32>>,
    power: Vec<f32>,
}

impl Default for Spectrum {
    fn default() -> Self {
        let mut planner = rustfft::FftPlanner::new();
        Spectrum {
            fft: planner.plan_fft_forward(FFT_SIZE),
            window: (0..FFT_SIZE).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FFT_SIZE as f32).cos()).collect(),
            buf: vec![Default::default(); FFT_SIZE],
            power: vec![0.0; FFT_SIZE / 2],
        }
    }
}

impl Spectrum {
    /// `samples`: the latest FFT_SIZE samples, oldest first.
    pub fn levels(&mut self, samples: &[f32]) -> (Vec<f64>, Vec<f64>) {
        for (i, c) in self.buf.iter_mut().enumerate() {
            *c = rustfft::num_complex::Complex::new(samples.get(i).copied().unwrap_or(0.0) * self.window[i], 0.0);
        }
        self.fft.process(&mut self.buf);
        for i in 0..FFT_SIZE / 2 { self.power[i] = self.buf[i].norm_sqr(); }
        let res = RATE as f32 / FFT_SIZE as f32;
        let full_scale = (FFT_SIZE * FFT_SIZE) as f32 / 16.0;        // a full-volume sine through a Hann window
        let level = |lo: f32, hi: f32| -> f64 {
            let a = ((lo / res).ceil() as usize).max(1);
            let b = ((hi / res).floor() as usize).min(FFT_SIZE / 2 - 1).max(a);
            let sum: f32 = self.power[a..=b].iter().sum();
            let mid = (lo * hi).sqrt();
            let db = 10.0 * (sum / (b - a + 1) as f32 / full_scale).max(1e-12).log10() + 3.0 * (mid / 1000.0).log2();
            ((((db + 72.0) / 62.0).clamp(0.0, 1.0) as f64) * 100.0).round() / 100.0
        };
        let (lo, hi) = (35f32, 16000f32);
        let spec = (0..SPEC_BANDS).map(|k| {
            let a = lo * (hi / lo).powf(k as f32 / SPEC_BANDS as f32);
            let b = lo * (hi / lo).powf((k + 1) as f32 / SPEC_BANDS as f32);
            level(a, b)
        }).collect();
        let eq = FREQS.iter().map(|&f| level(f as f32 / 1.414, f as f32 * 1.414)).collect();
        (spec, eq)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eq_matches_the_cookbook_curves() {
        let mut eq = Eq::default();
        // A +6 dB peak at 1 kHz gives +6 dB at 1 kHz and next to nothing two octaves away.
        let mut g = [0.0; 10]; g[5] = 6.0;
        eq.set(true, 0.0, &g);
        assert!((eq.response_db(1000.0) - 6.0).abs() < 0.05, "{}", eq.response_db(1000.0));
        assert!(eq.response_db(250.0).abs() < 0.6 && eq.response_db(4000.0).abs() < 0.6);
        // One octave wide: about half the boost (in dB) at the band edges, 707 Hz and 1414 Hz.
        assert!((eq.response_db(1414.0) - 3.0).abs() < 0.6, "{}", eq.response_db(1414.0));
        // The shelves: full gain well beyond their corner, half at the corner, nothing far away.
        let mut g = [0.0; 10]; g[0] = 6.0; g[9] = -6.0;
        eq.set(true, 0.0, &g);
        assert!((eq.response_db(10.0) - 6.0).abs() < 0.3, "{}", eq.response_db(10.0));
        assert!((eq.response_db(32.0) - 3.0).abs() < 0.3, "{}", eq.response_db(32.0));
        assert!((eq.response_db(16000.0) + 3.0).abs() < 0.3, "{}", eq.response_db(16000.0));
        assert!(eq.response_db(1000.0).abs() < 0.1);
        // Preamp is added on top; off means flat.
        eq.set(true, -3.0, &[0.0; 10]);
        assert!((eq.response_db(1000.0) + 3.0).abs() < 0.01);
        eq.set(false, -3.0, &[6.0; 10]);
        assert_eq!(eq.response_db(1000.0), 0.0);
    }

    #[test]
    fn eq_processes_a_tone_as_its_curve_says() {
        let mut eq = Eq::default();
        let mut g = [0.0; 10]; g[5] = 6.0;
        eq.set(true, 0.0, &g);
        let mut peak = 0f32;
        for n in 0..44100 {
            let x = (2.0 * std::f32::consts::PI * 1000.0 * n as f32 / 44100.0).sin() * 0.25;
            let (l, _) = eq.run(x, x);
            if n > 4410 { peak = peak.max(l.abs()); }
        }
        let db = 20.0 * (peak / 0.25).log10();
        assert!((db - 6.0).abs() < 0.1, "{db}");
    }

    #[test]
    fn parametric_filters_match_their_settings() {
        let mut eq = Eq::default();
        eq.set_filters(true, 0.0, &[Filter { kind: Kind::Peak, freq: 1000.0, gain: 6.0, q: 1.41 }]);
        assert!((eq.response_db(1000.0) - 6.0).abs() < 0.05);
        assert!(eq.response_db(100.0).abs() < 0.2 && eq.response_db(10000.0).abs() < 0.2);
        // A narrower peak (higher Q) falls away faster.
        eq.set_filters(true, 0.0, &[Filter { kind: Kind::Peak, freq: 1000.0, gain: 6.0, q: 5.0 }]);
        assert!(eq.response_db(1414.0) < 1.5, "{}", eq.response_db(1414.0));
        // A low shelf: full gain far below, half at the corner.
        eq.set_filters(true, -2.0, &[Filter { kind: Kind::LowShelf, freq: 105.0, gain: 6.0, q: 0.7 }]);
        assert!((eq.response_db(10.0) - 4.0).abs() < 0.3, "{}", eq.response_db(10.0));
        assert!((eq.response_db(105.0) - 1.0).abs() < 0.4, "{}", eq.response_db(105.0));
        assert!((eq.response_db(5000.0) + 2.0).abs() < 0.1);
        // Off filters and unused places pass the sound through.
        eq.set_filters(true, 0.0, &[Filter { kind: Kind::Off, freq: 1000.0, gain: 9.0, q: 1.0 }]);
        assert!(eq.response_db(1000.0).abs() < 1e-9);
        // The graphic shelf is the Q = 0.707 shelf.
        let a = Biquad::shelf(500.0, 4.0, true).response_db(2000.0);
        let b = Biquad::shelf_q(500.0, 4.0, std::f64::consts::FRAC_1_SQRT_2, true).response_db(2000.0);
        assert!((a - b).abs() < 1e-9);
    }

    #[test]
    fn reads_equalizer_apo_files() {
        let text = "Preamp: -6.1 dB\nFilter 1: ON LSC Fc 105 Hz Gain 6.4 dB Q 0.70\nFilter 2: ON PK Fc 8800 Hz Gain 5.1 dB Q 1.42\n\
                    Filter 3: OFF PK Fc 118 Hz Gain -3.1 dB Q 0.50\nFilter 4: ON LP Fc 18000 Hz\nFilter 5: ON HSC Fc 10000 Hz Gain -2,1 dB Q 0.70\n# a comment\n";
        let (pre, f, skipped) = parse_apo(text);
        assert_eq!(pre, -6.1);
        assert_eq!(f.len(), 3);
        assert_eq!(skipped, 2);
        assert_eq!(f[0], Filter { kind: Kind::LowShelf, freq: 105.0, gain: 6.4, q: 0.7 });
        assert_eq!(f[2].kind, Kind::HighShelf);
        assert_eq!(f[2].gain, -2.1);
        let many: String = (0..12).map(|i| format!("Filter {i}: ON PK Fc {} Hz Gain 1 dB Q 1\n", 100 + i)).collect();
        let (_, f, skipped) = parse_apo(&many);
        assert_eq!((f.len(), skipped), (10, 2));
    }

    #[test]
    fn channel_tools_do_what_they_say() {
        let c = Channels::default();
        assert_eq!(c.run(0.5, -0.25), (0.5, -0.25));
        assert_eq!(Channels { mono: true, ..c }.run(0.5, -0.25), (0.125, 0.125));
        assert_eq!(Channels { swap: true, ..c }.run(0.5, -0.25), (-0.25, 0.5));
        assert_eq!(Channels { invert: true, ..c }.run(0.5, -0.25), (-0.5, 0.25));
        assert_eq!(Channels { balance: 0.5, ..c }.run(0.5, 0.5), (0.25, 0.5));
        assert_eq!(Channels { balance: -1.0, ..c }.run(0.5, 0.5), (0.5, 0.0));
        let mut t = Tone::new(true, false);
        let mut peak = (0f32, 0f32);
        while !t.done() { let (l, r) = t.next(); peak = (peak.0.max(l.abs()), peak.1.max(r.abs())); }
        assert!(peak.0 > 0.12 && peak.0 <= 0.125 && peak.1 == 0.0);
    }

    #[test]
    fn limiter_never_lets_a_peak_through_and_leaves_quiet_sound_alone() {
        let mut lim = Limiter::default();
        let mut max_out = 0f32;
        for n in 0..44100 {
            // A 2x too loud tone with sudden bursts.
            let burst = if (n / 2000) % 3 == 0 { 2.5 } else { 1.0 };
            let x = (2.0 * std::f32::consts::PI * 440.0 * n as f32 / 44100.0).sin() * 0.9 * burst;
            let (l, _) = lim.run(x, x);
            max_out = max_out.max(l.abs());
        }
        assert!(max_out <= CEILING + 1e-6, "{max_out}");
        // Quiet sound comes out unchanged (5 ms later).
        let mut lim = Limiter::default();
        let input: Vec<f32> = (0..4410).map(|n| (n as f32 * 0.01).sin() * 0.5).collect();
        let out: Vec<f32> = input.iter().map(|&x| lim.run(x, x).0).collect();
        for n in LOOKAHEAD..4410 { assert!((out[n] - input[n - LOOKAHEAD]).abs() < 1e-6); }
    }

    #[test]
    fn spectrum_puts_a_tone_in_the_right_band() {
        let mut s = Spectrum::default();
        let tone: Vec<f32> = (0..FFT_SIZE).map(|n| (2.0 * std::f32::consts::PI * 1000.0 * n as f32 / 44100.0).sin() * 0.5).collect();
        let (spec, eq) = s.levels(&tone);
        let loudest = (0..SPEC_BANDS).max_by(|&a, &b| spec[a].total_cmp(&spec[b])).unwrap();
        let lo = 35f32 * (16000f32 / 35.0).powf(loudest as f32 / 48.0);
        let hi = 35f32 * (16000f32 / 35.0).powf((loudest + 1) as f32 / 48.0);
        assert!(lo <= 1000.0 && 1000.0 <= hi * 1.15, "{lo}–{hi}");
        let eq_loudest = (0..10).max_by(|&a, &b| eq[a].total_cmp(&eq[b])).unwrap();
        assert_eq!(eq_loudest, 5);
        let (spec, _) = s.levels(&vec![0.0; FFT_SIZE]);
        assert!(spec.iter().all(|&v| v == 0.0));
    }
}
