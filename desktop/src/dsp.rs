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
    fn shelf(f: f64, gain_db: f64, high: bool) -> Self {
        let a = 10f64.powf(gain_db / 40.0);
        let w = 2.0 * PI * f / RATE;
        let (c, s) = (w.cos(), w.sin());
        let alpha = s / 2.0 * 2f64.sqrt();                          // a shelf slope of 1
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

/// The 10-band EQ: a low shelf at 32 Hz, peaks (one octave wide) from 64 Hz to 8 kHz, a high shelf at
/// 16 kHz, and a preamp. The same layout as the Mac app's.
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
/// down just before a peak arrives, then recovers over about 50 ms (Apple's peak limiter in the Mac app
/// works the same way). Nothing changes while the sound stays under the ceiling.
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
/// up as clearly as bass. The same numbers as the Mac app's, so the visualizers look the same.
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
