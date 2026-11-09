(() => {
"use strict";

/* =====================================================================
   Basics
   ===================================================================== */
const $ = (id) => document.getElementById(id);
const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native;
const native = (cmd, args = {}) => (bridge ? bridge.postMessage({ cmd, args }) : Demo.native(cmd, args));
const API_BASE = "https://api.spotify.com/v1";
const enc = encodeURIComponent;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => { const s = Math.max(0, Math.floor((ms || 0) / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
const upper = (s) => String(s || "").toUpperCase();
const relPath = (url) => (url ? url.replace(API_BASE, "") : null);

// Recently opened pages (playlists, albums, artists) are remembered for a few minutes, so going
// back to one shows its songs straight away, as part of the slide. Any change you make through
// the app (adding, moving, removing, liking) clears the affected page.
const PageCache = {
  m: new Map(), ttl: 10 * 60 * 1000,
  get(key, stamp) {
    const e = this.m.get(key);
    return e && Date.now() - e.t < this.ttl && e.stamp === stamp ? e.v : null;
  },
  put(key, v, stamp) {
    this.m.delete(key);
    this.m.set(key, { v, stamp, t: Date.now() });
    if (this.m.size > 60) this.m.delete(this.m.keys().next().value);
  },
  drop(path) {
    const id = (String(path).match(/\/(?:playlists|albums|artists)\/([^/?]+)/) || [])[1];
    const liked = /\/me\/(library|tracks)/.test(path);
    for (const k of [...this.m.keys()]) if ((id && k.includes(id)) || (liked && k.startsWith("/me/tracks"))) this.m.delete(k);
  },
};

// When Spotify says "too many requests", background work (status checks, tagging, device lists)
// pauses until Spotify's cool-down is over, so the things you click still go through.
let coolUntil = 0;
const cooling = () => Date.now() < coolUntil;
// Background-only work (playlist tagging) waits until the app has been open a while and you've
// stopped clicking and typing for a bit, so it never competes with what you're doing.
const launchedAt = Date.now();
let lastInput = Date.now();
["keydown", "pointerdown", "wheel"].forEach((t) => addEventListener(t, () => { lastInput = Date.now(); }, { capture: true, passive: true }));
const quietTime = () => Date.now() - launchedAt > 90000 && Date.now() - lastInput > 20000 && !busy && !cooling();

async function api(method, path, body) {
  if (method !== "GET") PageCache.drop(path);
  let r;
  try { r = await native("api", { method, path, body: body === undefined ? null : body }); }
  catch (e) { console.error(e); r = null; }
  r = r || { status: 0, body: null };
  if (r.status === 429) {
    const secs = Math.min(86400, Math.max(10, +(r.body && r.body.retryAfter) || 10));
    coolUntil = Math.max(coolUntil, Date.now() + secs * 1000);
  }
  if (r.status === 401 && S.loggedIn) {               // login expired or revoked
    S.loggedIn = false;
    toast("SPOTIFY LOGIN EXPIRED. PLEASE LOG IN AGAIN", true);
    go("setup", {}, { reset: true, force: true });
  }
  return r;
}

const fmtWait = (secs) => { secs = Math.max(1, Math.ceil(secs)); return secs < 90 ? secs + "S" : secs < 5400 ? Math.ceil(secs / 60) + " MIN" : (secs / 3600).toFixed(1) + " HOURS"; };
function errMsg(r) {
  const m = r && r.body && r.body.error && r.body.error.message;
  switch (r && r.status) {
    case 0: return "NETWORK ERROR";
    case 401: return "NOT LOGGED IN";
    case 403: return m && /premium/i.test(m) ? "SPOTIFY PREMIUM IS NEEDED FOR THIS" : upper(m || "SPOTIFY REFUSED THAT");
    case 404: return "NO ACTIVE DEVICE. CHECK THE AUDIO ENGINE IN SYSTEM";
    case 429: {
      const secs = Math.max(+(r.body && r.body.retryAfter) || 0, (coolUntil - Date.now()) / 1000);
      if (secs > 600) {   // a long block: say when it ends, and what still works
        const t = new Date(Date.now() + secs * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        return `SPOTIFY HAS PAUSED CADENZA'S CONTROLS UNTIL ${upper(t)}. USE THE SPOTIFY APP TO CONTROL MUSIC UNTIL THEN`;
      }
      return "SPOTIFY NEEDS A BREATHER. TRY AGAIN IN " + fmtWait(secs);
    }
    default: return upper(m || `SOMETHING WENT WRONG (${r && r.status})`);
  }
}

const S = {
  liked: false,
  volLock: 0,
  loggedIn: false,
  player: null,
  stamp: Date.now(),
  me: null,
  playlists: null,
  playlistsAt: 0,
  likedTotal: null,
  settings: { deviceName: "Cadenza", manageLibrespot: true },
  engine: null,
};

/* =====================================================================
   Animation helpers: only transform/opacity, so the GPU does the work
   ===================================================================== */
const OUT = "cubic-bezier(.2,.9,.2,1)", SNAP = "cubic-bezier(.3,1.35,.5,1)", IN = "cubic-bezier(.6,0,.9,.4)";
let reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const play = (el, frames, opts) => el.animate(frames, { fill: "both", ...opts, ...(reduced ? { duration: 1, delay: 0 } : {}) });
const settle = (a) => { a.onfinish = () => a.cancel(); return a; };
const done = (list) => Promise.all(list.map((a) => a.finished.catch(() => {})));
const cancelAll = (els) => els.forEach((el) => el && el.getAnimations().forEach((a) => a.cancel()));
let busy = false;
const idleWaiters = [];
// Enter, Esc or Backspace pressed while a page is still sliding in is kept and run the moment the
// slide finishes, so a quick "open, then back" works.
let pendingKey = null;
const setBusy = (v) => {
  busy = v; document.body.classList.toggle("moving", v);
  if (!v) idleWaiters.splice(0).forEach((r) => r());
  if (!v && pendingKey) {
    const k = pendingKey; pendingKey = null;
    if (Date.now() - k.at < 1200) setTimeout(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: k.key, shiftKey: k.shiftKey, altKey: k.altKey, bubbles: true })), 0);
  }
};
// Resolves once the page transition has finished, so new rows are built after the animation, not during it.
const settled = () => (busy ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve());

function onScreen(el) {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && r.height > 0;
}
const stTargets = (root) => [...root.querySelectorAll(".st")].filter(onScreen).slice(0, 18);

function sweep(dir) {
  const t = Theme.current;
  if (t && t.transition) return t.transition($("sweep"), dir, { play, reduced }) || [];
  const from = dir > 0 ? "-60vw" : "160vw", to = dir > 0 ? "160vw" : "-60vw";
  return [...$("sweep").querySelectorAll(".a, .b, .c")].map((el, i) => play(el,
    [{ transform: `translate3d(${from},0,0) skewX(-20deg)` }, { transform: `translate3d(${to},0,0) skewX(-20deg)` }],
    { duration: 460, delay: i * 45, easing: "cubic-bezier(.55,.05,.35,1)", fill: "none" }));
}
// Default motion (the blue theme). A theme can replace any of these with its own `motion`.
const DEFAULT_MOTION = {
  out: (dir) => [{ transform: "none", opacity: 1 }, { transform: `translate3d(${-dir * 36}vw,0,0) skewX(-24deg)`, opacity: 0 }],
  in: (dir) => [{ transform: `translate3d(${dir * 30}vw,0,0) skewX(-24deg)`, opacity: 0 }, { transform: "none", opacity: 1 }],
  row: (dir) => [{ transform: `translate3d(${dir * 22}vw,0,0)`, opacity: 0 }, { transform: "none", opacity: 1 }],
  outMs: 190, inMs: 300, rowMs: 280, stagger: 24, inEase: SNAP,
  // small moments: the separate translate/rotate/scale properties, so they stack on any resting transform
  select: { frames: [{ scale: ".86 1" }, { scale: "1 1" }], ms: 220 },                         // home highlight lands
  confirm: { frames: [{ translate: ".8vw 0", scale: "1.04" }, { translate: "0 0", scale: "1" }], ms: 200 },  // Enter / click
  hint: { frames: [{ translate: "-1.6vw 0", opacity: 0 }, { translate: "0 0", opacity: 1 }], ms: 170 },
  intel: { frames: [{ translate: "3vw 0", opacity: 0 }, { translate: "0 0", opacity: 1 }], ms: 240 },
  trackOut: {
    art: [{ translate: "0 0", rotate: "0deg", opacity: 1 }, { translate: "5vw 0", rotate: "8deg", opacity: 0 }],
    text: [{ translate: "0 0", opacity: 1 }, { translate: "4vw 0", opacity: 0 }], ms: 150 },
  trackIn: {
    art: [{ translate: "-5vw 0", rotate: "-8deg", opacity: 0 }, { translate: "0 0", rotate: "0deg", opacity: 1 }],
    text: [{ translate: "-4vw 0", opacity: 0 }, { translate: "0 0", opacity: 1 }], ms: 300 },
  shake: false,
};
/* =====================================================================
   Sound effects: tiny UI sounds synthesised on the fly (no audio files), a different set per theme.
   Only on meaningful actions (confirm, back, page change, toggles), quiet, and softer while music plays.
   ===================================================================== */
const Sfx = {
  ctx: null, last: {}, curves: {},
  ready() {
    if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    return this.ctx;
  },
  /** Soft-clipping curve for grit (k = how hard it drives). */
  curve(k) {
    if (this.curves[k]) return this.curves[k];
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    return (this.curves[k] = c);
  },
  play(kind, themeId) {
    if (S.settings.sfx === false) return;
    const now = performance.now();
    if (now - (this.last[kind] || 0) < 70) return;            // never machine-gun the same sound
    if (kind === "page" && now - (this.last.confirm || 0) < 250) return;   // a confirm already covered this page change
    this.last[kind] = now;
    const ctx = this.ready();
    if (!ctx) return;
    const vol = Math.max(0, Math.min(1, (S.settings.sfxVolume ?? 55) / 100)) * (S.player && S.player.is_playing ? 0.6 : 1) * 0.35;
    const out = ctx.createGain(); out.gain.value = vol; out.connect(ctx.destination);
    const t = ctx.currentTime, R = Math.random;
    // Filter (optionally sweeping) and drive, shared by both sources below.
    const chain = (src, o, at, dur) => {
      let node = src;
      if (o.filt) {
        const f = ctx.createBiquadFilter(); f.type = o.filt.type; f.Q.value = o.filt.q || 0.7;
        f.frequency.setValueAtTime(o.filt.f, at);
        if (o.filt.f1) f.frequency.exponentialRampToValueAtTime(o.filt.f1, at + dur);
        node.connect(f); node = f;
      }
      if (o.drive) { const w = ctx.createWaveShaper(); w.curve = this.curve(o.drive); w.oversample = "2x"; node.connect(w); node = w; }
      return node;
    };
    // A pitched voice: frequency glides f0 → f1, quick attack, exponential tail.
    const tone = (o) => {
      const at = t + (o.at || 0), dur = o.dur, osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = o.type || "sine";
      osc.frequency.setValueAtTime(o.f0, at);
      if (o.f1 && o.f1 !== o.f0) osc.frequency.exponentialRampToValueAtTime(o.f1, at + dur * (o.glide || 1));
      const atk = o.attack || Math.min(0.004, dur / 5);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(o.gain || 0.5, at + atk);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      chain(osc, o, at, dur).connect(g); g.connect(out);
      osc.start(at); osc.stop(at + dur + 0.03);
    };
    // Noise burst; `crush` holds each sample for N samples and rounds it to a few levels (a lo-fi, bit-crushed sound).
    const noise = (o) => {
      const at = t + (o.at || 0), dur = o.dur, len = Math.max(1, Math.ceil(ctx.sampleRate * dur));
      const b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0), hold = o.crush || 1, lv = o.bits ? 2 ** o.bits / 2 : 0;
      let v = 0;
      for (let i = 0; i < len; i++) {
        if (i % hold === 0) { v = R() * 2 - 1; if (lv) v = Math.round(v * lv) / lv; }
        d[i] = v * Math.pow(1 - i / len, o.curve || 1);
      }
      const src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = b; g.gain.value = o.gain || 0.5;
      chain(src, o, at, dur).connect(g); g.connect(out); src.start(at);
    };
    // Blue: a bubble's pitch rises as it closes up, so every "bloop" chirps upward
    const bubble = (at, f, dur = 0.07, gain = 0.6, rise = 1.9) => {
      tone({ type: "sine", f0: f, f1: f * rise, glide: 0.8, at, dur, gain, attack: 0.003, filt: { type: "lowpass", f: f * 3.2 } });
      tone({ type: "sine", f0: f * 2.01, f1: f * rise * 2.01, glide: 0.8, at, dur: dur * 0.5, gain: gain * 0.12 });   // a little wet sparkle
    };
    // A run of quick pitches (digital chatter): each step jumps straight to the next frequency.
    const steps = (o) => {
      const at = t + (o.at || 0), osc = ctx.createOscillator(), g = ctx.createGain(), dur = o.freqs.length * o.step;
      osc.type = o.type || "square";
      o.freqs.forEach((f, i) => osc.frequency.setValueAtTime(f, at + i * o.step));
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(o.gain || 0.3, at + 0.003);
      g.gain.setValueAtTime(o.gain || 0.3, at + dur - 0.01); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      chain(osc, o, at, dur).connect(g); g.connect(out);
      osc.start(at); osc.stop(at + dur + 0.02);
    };
    // A synthetic "voice": a buzzy tone through two moving formant filters (for the rogue AI).
    const voice = (o) => {
      const at = t + (o.at || 0), dur = o.dur, osc = ctx.createOscillator(), g = ctx.createGain(), mix = ctx.createGain();
      osc.type = "sawtooth"; osc.frequency.setValueAtTime(o.f0, at); osc.frequency.linearRampToValueAtTime(o.f1 || o.f0, at + dur);
      [[o.a0, o.a1], [o.b0, o.b1]].forEach(([f0, f1]) => {
        const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 9;
        bp.frequency.setValueAtTime(f0, at); bp.frequency.exponentialRampToValueAtTime(f1, at + dur);
        osc.connect(bp); bp.connect(mix);
      });
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(o.gain || 0.5, at + dur * 0.25);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      let node = mix;
      if (o.drive) { const w = ctx.createWaveShaper(); w.curve = this.curve(o.drive); mix.connect(w); node = w; }
      node.connect(g); g.connect(out);
      osc.start(at); osc.stop(at + dur + 0.03);
    };
    const theme = themeId || (Theme.current ? Theme.current.id : "tide");
    out.gain.value *= ({ min: 1.9, rogue: 1.25, chroma: 1.5 })[theme] || 1;      // even out how loud each theme's set feels
    const SOUNDS = {
      tide: {
        confirm: () => { bubble(0, 520, 0.08, 0.7); bubble(0.045, 780, 0.07, 0.55); bubble(0.09, 1150, 0.09, 0.45, 2.1); tone({ f0: 170, f1: 380, at: 0, dur: 0.06, gain: 0.3 }); },
        back: () => { bubble(0, 980, 0.06, 0.5); bubble(0.05, 660, 0.07, 0.55); bubble(0.1, 430, 0.1, 0.6, 1.6); },
        page: () => {
          noise({ dur: 0.24, gain: 0.12, filt: { type: "lowpass", f: 500, f1: 1400, q: 2 }, curve: 2 });      // a swish of water
          for (let i = 0; i < 7; i++) bubble(R() * 0.2, 900 + R() * 1700, 0.025 + R() * 0.03, 0.22 + R() * 0.3, 1.7 + R() * 0.6);
        },
        toggle: () => bubble(0, 1250, 0.05, 0.55, 2.2),
        stage: () => {
          tone({ f0: 110, f1: 230, at: 0, dur: 0.5, gain: 0.35, attack: 0.03 });
          for (let i = 0; i < 11; i++) bubble(i * 0.042 + R() * 0.02, 300 * Math.pow(1.2, i) * (0.9 + R() * 0.2), 0.06 + R() * 0.04, 0.35, 1.9);
        },
        // Switching to Blue: a wash of water, a rush of bubbles, then a clear bell
        theme: () => {
          noise({ dur: 0.7, gain: 0.25, filt: { type: "lowpass", f: 300, f1: 2200, q: 3 }, curve: 1.4 });
          for (let i = 0; i < 16; i++) bubble(0.05 + i * 0.03 + R() * 0.03, 350 + i * 90 + R() * 200, 0.05 + R() * 0.04, 0.3, 1.8 + R() * 0.4);
          [1046.5, 1568, 2093].forEach((f, i) => tone({ f0: f, at: 0.5 + i * 0.03, dur: 0.9, gain: 0.16 - i * 0.04, attack: 0.005 }));
        },
      },
      // Red: crisp, metallic and a little jazzy: a sharp hit, a bright two-note stab and a "shing" of steel
      heist: {
        confirm: () => {
          noise({ dur: 0.016, gain: 0.9, filt: { type: "highpass", f: 3000 } });
          tone({ type: "triangle", f0: 1318.5, at: 0, dur: 0.11, gain: 0.32, drive: 1.5 });
          tone({ type: "triangle", f0: 1975.5, at: 0.012, dur: 0.1, gain: 0.24, drive: 1.5 });
          noise({ at: 0.01, dur: 0.14, gain: 0.45, filt: { type: "bandpass", f: 7500, f1: 3200, q: 9 } });
          tone({ f0: 2637, at: 0.02, dur: 0.22, gain: 0.07 });
        },
        back: () => {
          noise({ dur: 0.08, gain: 0.6, filt: { type: "bandpass", f: 4200, f1: 800, q: 4 } });
          tone({ type: "triangle", f0: 988, f1: 494, at: 0, dur: 0.08, gain: 0.35, drive: 1.5 });
          noise({ dur: 0.01, gain: 0.5, filt: { type: "highpass", f: 2500 } });
        },
        page: () => {
          noise({ dur: 0.13, gain: 0.55, filt: { type: "bandpass", f: 900, f1: 6500, q: 3 }, curve: 0.5 });   // the slash
          tone({ f0: 170, f1: 58, at: 0.11, dur: 0.1, gain: 0.55, drive: 2 });                                // the landing
          tone({ type: "square", f0: 659, at: 0.11, dur: 0.06, gain: 0.08, filt: { type: "lowpass", f: 2600 } });
          tone({ type: "square", f0: 988, at: 0.11, dur: 0.06, gain: 0.07, filt: { type: "lowpass", f: 2600 } });
          noise({ at: 0.11, dur: 0.02, gain: 0.6, filt: { type: "highpass", f: 3500 } });
        },
        toggle: () => { noise({ dur: 0.012, gain: 0.8, filt: { type: "highpass", f: 4200 } }); tone({ type: "triangle", f0: 1760, at: 0.004, dur: 0.035, gain: 0.25 }); },
        stage: () => {
          [659.3, 784, 987.8, 1480].forEach((f, i) => tone({ type: "triangle", f0: f, at: i * 0.035, dur: 0.22 - i * 0.02, gain: 0.2, drive: 1.4 }));
          noise({ dur: 0.2, gain: 0.5, filt: { type: "bandpass", f: 1200, f1: 8000, q: 5 }, curve: 0.6 });
          tone({ f0: 150, f1: 50, at: 0.15, dur: 0.18, gain: 0.6, drive: 2 });
        },
        // Switching to Red: two quick slashes, a big jazzy chord stab, and a ringing cymbal
        theme: () => {
          noise({ dur: 0.12, gain: 0.6, filt: { type: "bandpass", f: 800, f1: 7000, q: 3 }, curve: 0.5 });
          noise({ at: 0.13, dur: 0.12, gain: 0.6, filt: { type: "bandpass", f: 7000, f1: 900, q: 3 }, curve: 0.5 });
          [146.8, 349.2, 523.3, 659.3, 880].forEach((f, i) => tone({ type: "triangle", f0: f, at: 0.27 + i * 0.008, dur: 0.6, gain: 0.16, drive: 1.6, filt: { type: "lowpass", f: 4200 } }));
          tone({ f0: 160, f1: 50, at: 0.27, dur: 0.22, gain: 0.7, drive: 2 });
          noise({ at: 0.27, dur: 0.9, gain: 0.22, filt: { type: "highpass", f: 6000 }, curve: 2.2 });
          noise({ at: 0.27, dur: 0.025, gain: 0.8, filt: { type: "highpass", f: 3000 } });
        },
      },
      // Neon: low, dirty and digital: sub thuds, overdriven buzz and crushed static
      neon: {
        confirm: () => {
          tone({ f0: 150, f1: 42, at: 0, dur: 0.17, gain: 0.65, drive: 3 });
          tone({ type: "sawtooth", f0: 220, f1: 110, at: 0, dur: 0.06, gain: 0.3, drive: 6, filt: { type: "lowpass", f: 1100, q: 3 } });
          noise({ dur: 0.035, gain: 0.45, crush: 7, bits: 3, filt: { type: "bandpass", f: 1800, q: 1.5 } });
        },
        back: () => {
          tone({ type: "square", f0: 95, f1: 52, at: 0, dur: 0.12, gain: 0.35, drive: 5, filt: { type: "lowpass", f: 700, q: 2 } });
          noise({ dur: 0.06, gain: 0.35, crush: 10, bits: 2, filt: { type: "lowpass", f: 1400 } });
          noise({ at: 0.005, dur: 0.008, gain: 0.4, filt: { type: "highpass", f: 2600 } });
        },
        page: () => {
          [[0, 0.016, 900], [0.03, 0.012, 2400], [0.052, 0.02, 1300], [0.09, 0.014, 3200]].forEach(([at, dur, f]) =>
            noise({ at, dur, gain: 0.4, crush: 5 + Math.floor(R() * 8), bits: 3, filt: { type: "bandpass", f, q: 2 } }));
          tone({ type: "sawtooth", f0: 55, at: 0, dur: 0.24, gain: 0.3, attack: 0.01, drive: 4, filt: { type: "lowpass", f: 320, f1: 140, q: 4 } });
          tone({ f0: 75, f1: 38, at: 0.02, dur: 0.14, gain: 0.6, drive: 2 });
        },
        toggle: () => {
          tone({ type: "square", f0: 180, at: 0, dur: 0.025, gain: 0.25, drive: 6, filt: { type: "lowpass", f: 1500 } });
          noise({ dur: 0.012, gain: 0.35, crush: 6, bits: 2, filt: { type: "bandpass", f: 2200 } });
        },
        stage: () => {
          tone({ f0: 95, f1: 30, at: 0, dur: 0.55, gain: 0.7, drive: 2.5, attack: 0.01 });
          noise({ dur: 0.38, gain: 0.35, crush: 9, bits: 3, filt: { type: "bandpass", f: 300, f1: 3200, q: 3 }, curve: 0.4 });
          [0.05, 0.13, 0.2, 0.31].forEach((at) => noise({ at, dur: 0.015, gain: 0.35, crush: 12, bits: 2, filt: { type: "highpass", f: 1500 } }));
        },
        // Switching to Neon: a power-down drop, a dirty charging whine, glitches, then the system slams on
        theme: () => {
          tone({ type: "sawtooth", f0: 900, f1: 40, at: 0, dur: 0.3, gain: 0.25, drive: 4, filt: { type: "lowpass", f: 2000, f1: 200, q: 3 } });
          tone({ type: "sawtooth", f0: 60, f1: 340, glide: 1, at: 0.25, dur: 0.45, gain: 0.22, attack: 0.2, drive: 5, filt: { type: "lowpass", f: 400, f1: 2600, q: 6 } });
          [0.3, 0.42, 0.5, 0.61].forEach((at) => noise({ at, dur: 0.02, gain: 0.4, crush: 8 + Math.floor(R() * 8), bits: 2, filt: { type: "bandpass", f: 900 + R() * 2500, q: 2 } }));
          tone({ f0: 110, f1: 32, at: 0.7, dur: 0.5, gain: 0.9, drive: 3 });
          noise({ at: 0.7, dur: 0.25, gain: 0.35, crush: 10, bits: 3, filt: { type: "lowpass", f: 1800 }, curve: 2 });
        },
      },
      // Studio: quiet, clean and short, like a well-made pro app (soft taps, gentle chimes)
      min: {
        confirm: () => { tone({ f0: 1320, at: 0, dur: 0.07, gain: 0.22, attack: 0.002 }); noise({ dur: 0.006, gain: 0.25, filt: { type: "highpass", f: 5000 } }); },
        back: () => { tone({ f0: 990, at: 0, dur: 0.07, gain: 0.2, attack: 0.002 }); noise({ dur: 0.006, gain: 0.2, filt: { type: "highpass", f: 5000 } }); },
        page: () => { noise({ dur: 0.14, gain: 0.28, filt: { type: "bandpass", f: 1800, f1: 3200, q: 0.8 }, curve: 1.5 }); tone({ f0: 1760, at: 0.02, dur: 0.05, gain: 0.08, attack: 0.002 }); },
        toggle: () => { tone({ f0: 2200, at: 0, dur: 0.025, gain: 0.16, attack: 0.001 }); tone({ f0: 2640, at: 0.035, dur: 0.03, gain: 0.12, attack: 0.001 }); },
        stage: () => [523.3, 659.3, 784, 1046.5].forEach((f, i) => tone({ f0: f, at: i * 0.06, dur: 0.6, gain: 0.1, attack: 0.01 })),
        theme: () => {
          noise({ dur: 0.5, gain: 0.08, filt: { type: "lowpass", f: 600, f1: 3000, q: 0.7 }, curve: 0.8 });
          tone({ f0: 784, at: 0.25, dur: 0.8, gain: 0.16, attack: 0.008 });
          tone({ f0: 1174.7, at: 0.34, dur: 0.9, gain: 0.13, attack: 0.008 });
          tone({ f0: 2349.3, at: 0.34, dur: 0.5, gain: 0.03, attack: 0.008 });
        },
      },
      // Chroma: warm, glassy chimes in a major chord, like colour blooming
      chroma: {
        confirm: () => { tone({ f0: 1046.5, at: 0, dur: 0.12, gain: 0.18, attack: 0.003 }); tone({ f0: 1568, at: 0.03, dur: 0.14, gain: 0.1, attack: 0.003 }); },
        back: () => { tone({ f0: 1318.5, at: 0, dur: 0.09, gain: 0.15, attack: 0.003 }); tone({ f0: 880, at: 0.05, dur: 0.12, gain: 0.14, attack: 0.003 }); },
        page: () => { noise({ dur: 0.2, gain: 0.14, filt: { type: "bandpass", f: 1200, f1: 4200, q: 1.1 }, curve: 1.4 }); tone({ f0: 2093, at: 0.05, dur: 0.12, gain: 0.05, attack: 0.004 }); },
        toggle: () => { tone({ f0: 1760, at: 0, dur: 0.05, gain: 0.13, attack: 0.002 }); tone({ f0: 2217.5, at: 0.04, dur: 0.06, gain: 0.1, attack: 0.002 }); },
        stage: () => [523.3, 659.3, 784, 987.8, 1174.7].forEach((f, i) => tone({ f0: f, at: i * 0.07, dur: 0.7, gain: 0.09, attack: 0.012 })),
        theme: () => {
          noise({ dur: 0.7, gain: 0.07, filt: { type: "lowpass", f: 400, f1: 3600, q: 0.8 }, curve: 0.7 });
          [392, 493.9, 587.3, 784].forEach((f, i) => tone({ f0: f, at: 0.15 + i * 0.09, dur: 1.1, gain: 0.11, attack: 0.02 }));
        },
      },
      // R0GUE (Ogmi.os): a machine talking to itself: chirping data, ring-modulated beeps, crushed static and a voice-like buzz
      rogue: {
        confirm: () => {
          steps({ freqs: [1800, 2700, 1350, 3600], step: 0.016, gain: 0.16, filt: { type: "bandpass", f: 2400, q: 1.2 } });
          noise({ dur: 0.04, gain: 0.3, crush: 4, bits: 2, filt: { type: "highpass", f: 2000 } });
          tone({ f0: 90, f1: 45, at: 0, dur: 0.08, gain: 0.4, drive: 3 });
        },
        back: () => {
          steps({ freqs: [1500, 1100, 760, 520], step: 0.022, gain: 0.15, filt: { type: "lowpass", f: 3000 } });
          steps({ freqs: [1530, 1123, 776, 531], step: 0.022, gain: 0.1, type: "sawtooth", filt: { type: "lowpass", f: 3000 } });  // detuned twin: a ring-mod rasp
        },
        page: () => {
          steps({ freqs: Array.from({ length: 10 }, () => 600 + Math.floor(R() * 8) * 400), step: 0.012, gain: 0.12, filt: { type: "bandpass", f: 2200, q: 0.9 } });
          noise({ at: 0.02, dur: 0.1, gain: 0.25, crush: 14, bits: 2, filt: { type: "bandpass", f: 1400, f1: 4200, q: 2 } });
          tone({ f0: 70, f1: 40, at: 0.1, dur: 0.12, gain: 0.45, drive: 4 });
        },
        toggle: () => { steps({ freqs: [3200, 4800], step: 0.012, gain: 0.14 }); },
        stage: () => {
          voice({ f0: 95, f1: 80, dur: 0.7, gain: 0.5, a0: 450, a1: 300, b0: 900, b1: 2300, drive: 3 });
          noise({ dur: 0.5, gain: 0.2, crush: 12, bits: 3, filt: { type: "bandpass", f: 400, f1: 4000, q: 3 }, curve: 0.6 });
        },
        theme: () => {
          steps({ freqs: [880, 660, 880, 660], step: 0.09, gain: 0.14, filt: { type: "bandpass", f: 1200, q: 2 }, drive: 3 });
          voice({ at: 0.3, f0: 70, f1: 110, dur: 0.8, gain: 0.5, a0: 300, a1: 700, b0: 2300, b1: 900, drive: 3 });
          tone({ f0: 90, f1: 28, at: 0.9, dur: 0.6, gain: 0.9, drive: 3 });
          noise({ at: 0.9, dur: 0.3, gain: 0.4, crush: 16, bits: 2, filt: { type: "lowpass", f: 3000 }, curve: 2 });
        },
        // The takeover (5.3 s, matched to the animation): an alarm, static that keeps climbing, a heartbeat
        // that speeds up, Ogmi.os's voice, and one huge hit as the theme lands
        breach: () => {
          for (let i = 0; i < 10; i++) steps({ at: i * 0.26, freqs: [i % 2 ? 660 : 880], step: 0.18, gain: 0.12, filt: { type: "bandpass", f: 1100, q: 2 }, drive: 4 });
          noise({ dur: 5.2, gain: 0.3, crush: 6, bits: 3, filt: { type: "bandpass", f: 160, f1: 6500, q: 2.5 }, curve: 0.12 });
          for (let i = 0; i < 30; i++) noise({ at: 0.3 + R() * 4.8, dur: 0.02 + R() * 0.04, gain: 0.32, crush: 4 + Math.floor(R() * 20), bits: 2, filt: { type: "bandpass", f: 400 + R() * 5000, q: 2 } });
          for (let i = 0; i < 20; i++) steps({ at: 0.8 + R() * 4.2, freqs: Array.from({ length: 5 }, () => 500 + R() * 4000), step: 0.012, gain: 0.08 });
          [1.2, 1.9, 2.5, 3.0, 3.45, 3.85, 4.2, 4.5, 4.75, 4.98].forEach((at) => tone({ f0: 70, f1: 38, at, dur: 0.2, gain: 0.8, drive: 3 }));
          voice({ at: 2.2, f0: 62, f1: 48, dur: 1.4, gain: 0.55, a0: 280, a1: 650, b0: 2400, b1: 800, drive: 4 });
          voice({ at: 3.9, f0: 58, f1: 40, dur: 1.1, gain: 0.5, a0: 650, a1: 260, b0: 900, b1: 2600, drive: 4 });
          tone({ f0: 120, f1: 24, at: 5.3, dur: 1.3, gain: 1, drive: 4 });
          noise({ at: 5.3, dur: 0.7, gain: 0.55, crush: 20, bits: 2, filt: { type: "lowpass", f: 5000, f1: 300 }, curve: 1.5 });
          steps({ at: 5.35, freqs: [2400, 3600, 4800], step: 0.03, gain: 0.12, filt: { type: "highpass", f: 1500 } });
        },
        // Ogmi.os blocking a theme change: an alarm buzz, a slammed door of static, and a low "no"
        deny: () => {
          [0, 0.16].forEach((at) => tone({ type: "square", f0: 220, f1: 196, at, dur: 0.13, gain: 0.3, drive: 5, filt: { type: "lowpass", f: 1800 } }));
          noise({ at: 0.02, dur: 0.18, gain: 0.45, crush: 10, bits: 2, filt: { type: "bandpass", f: 900, q: 1.5 } });
          tone({ f0: 90, f1: 34, at: 0.02, dur: 0.3, gain: 0.85, drive: 3 });
          voice({ at: 0.32, f0: 70, f1: 52, dur: 0.6, gain: 0.5, a0: 700, a1: 320, b0: 1100, b1: 700, drive: 4 });
        },
        // …the second time: louder, longer and angrier
        deny2: () => {
          [0, 0.12, 0.24, 0.36].forEach((at, i) => tone({ type: "square", f0: i % 2 ? 196 : 247, at, dur: 0.1, gain: 0.32, drive: 6, filt: { type: "lowpass", f: 2200 } }));
          noise({ dur: 0.6, gain: 0.5, crush: 14, bits: 2, filt: { type: "bandpass", f: 300, f1: 3500, q: 2 }, curve: 0.6 });
          [0.02, 0.3].forEach((at) => tone({ f0: 100, f1: 30, at, dur: 0.32, gain: 0.9, drive: 4 }));
          for (let i = 0; i < 8; i++) noise({ at: 0.1 + R() * 0.8, dur: 0.02 + R() * 0.03, gain: 0.35, crush: 6 + Math.floor(R() * 14), bits: 2, filt: { type: "highpass", f: 1200 } });
          voice({ at: 0.5, f0: 62, f1: 44, dur: 0.9, gain: 0.55, a0: 650, a1: 260, b0: 900, b1: 2400, drive: 5 });
        },
        // Third try: Ogmi.os loses its grip. 2.8 s of glitch storm (stuttering data, crushed static,
        // its voice breaking up), then a power-down as it lets go
        fight: () => {
          noise({ dur: 3, gain: 0.28, crush: 8, bits: 2, filt: { type: "bandpass", f: 500, f1: 3000, q: 1.5 }, curve: 0.3 });
          for (let i = 0; i < 26; i++) noise({ at: R() * 2.6, dur: 0.02 + R() * 0.06, gain: 0.4, crush: 4 + Math.floor(R() * 24), bits: 2, filt: { type: "bandpass", f: 300 + R() * 5000, q: 2 } });
          for (let i = 0; i < 14; i++) steps({ at: R() * 2.5, freqs: Array.from({ length: 6 }, () => 300 + R() * 4500), step: 0.014, gain: 0.1 });
          [0.3, 0.9, 1.4, 1.9].forEach((at, i) => voice({ at, f0: 74 - i * 6, f1: 60 - i * 8, dur: 0.25, gain: 0.45, a0: 700, a1: 300, b0: 1200, b1: 2400, drive: 5 }));
          [0.1, 0.75, 1.3, 1.85, 2.3].forEach((at) => tone({ f0: 95, f1: 30, at, dur: 0.22, gain: 0.7, drive: 4 }));
          tone({ type: "sawtooth", f0: 200, f1: 1400, at: 1.8, dur: 1.2, gain: 0.18, drive: 3, filt: { type: "lowpass", f: 800, f1: 5000 } });   // rising to the break
        },
        // an error pop-up: a short, nasty two-tone system bleep
        err: () => {
          tone({ type: "square", f0: 880 + R() * 400, at: 0, dur: 0.05, gain: 0.14, drive: 3, filt: { type: "lowpass", f: 3500 } });
          tone({ type: "square", f0: 440 + R() * 200, at: 0.055, dur: 0.07, gain: 0.14, drive: 3, filt: { type: "lowpass", f: 3000 } });
        },
        // the cut to white: everything stops at once, one bright crack and a ringing tone
        whiteout: () => {
          noise({ dur: 0.08, gain: 0.7, filt: { type: "highpass", f: 2000 } });
          tone({ f0: 120, f1: 28, at: 0, dur: 0.7, gain: 0.9, drive: 3 });
          tone({ f0: 3520, at: 0.02, dur: 1.2, gain: 0.05, attack: 0.002 });
        },
        // Switching away from Ogmi.os's theme: a last word, cut off
        farewell: () => {
          voice({ f0: 80, f1: 50, dur: 0.6, gain: 0.45, a0: 700, a1: 300, b0: 1200, b1: 700, drive: 4 });
          noise({ at: 0.5, dur: 0.05, gain: 0.4, crush: 18, bits: 2, filt: { type: "highpass", f: 1000 } });
        },
      },
    };
    const set = SOUNDS[theme] || SOUNDS.tide;
    (set[kind] || set.confirm)();
  },
};
window.cadenzaSfx = (kind, theme) => Sfx.play(kind, theme);       // lets a theme play its own sounds
/** What's playing, for themes that want to comment on it (the secret one does, rudely). */
window.cadenzaNow = () => {
  const p = S.player, it = p && p.item;
  return it ? { uri: it.uri, title: cleanTitle(it.name), artist: String(it.artists || "").split(", ")[0], album: it.album,
    playing: !!p.is_playing, liked: !!S.liked, volume: p.volume, shuffle: !!p.shuffle_state, repeat: p.repeat_state } : null;
};
// Browsers only allow sound after the first key press or click; wake the audio up then.
["keydown", "pointerdown"].forEach((ev) => addEventListener(ev, () => Sfx.ready(), { once: true, capture: true }));

/** Quick confirm "pop" on an element, plus a screen shake if the theme wants one. */
function pop(el, sound = "confirm") {
  if (!el) return;
  Sfx.play(sound);
  const m = motion();
  play(el, m.confirm.frames, { duration: m.confirm.ms, easing: m.inEase, fill: "none" });
  if (Theme.current && Theme.current.onConfirm && !reduced) Theme.current.onConfirm(el, { play });
  if (m.shake && !reduced) play($("views"), [{ translate: "0 0" }, { translate: "-.5vw .35vh" }, { translate: ".45vw -.3vh" }, { translate: "-.25vw .15vh" }, { translate: "0 0" }], { duration: 220, easing: "linear", fill: "none" });
}
const motion = () => ({ ...DEFAULT_MOTION, ...((Theme.current && Theme.current.motion) || {}) });
// Movement goes on top of an element's own resting transform (its tilt or skew), so nothing snaps
// when an animation ends. The resting transform is written into every keyframe, because WebKit can't
// run composite:"add" animations on the GPU. On the GPU they keep gliding even while the app is busy
// loading a playlist or building rows.
const identityOf = (t) => t.replace(/([a-zA-Z0-9]+)\(([^)]*)\)/g, (m, fn, args) =>
  /^matrix/.test(fn) ? m : `${fn}(${args.split(",").map(() => (/^scale/.test(fn) ? "1" : /^(rotate|skew)/.test(fn) ? "0deg" : "0px")).join(",")})`);
function fly(el, frames, opts) {
  const cs = getComputedStyle(el).transform;
  const base = cs && cs !== "none" ? cs + " " : "";
  const moving = frames.map((f) => (f.transform && f.transform !== "none" ? f.transform : null));
  const shape = moving.find(Boolean) || "translate3d(0px,0px,0px)";
  const keys = frames.map((f, i) => ({
    transform: base + (moving[i] || identityOf(shape)),
    opacity: f.opacity == null ? 1 : f.opacity,
    ...(f.offset != null ? { offset: f.offset } : {}),      // themes can use multi-step keyframes (e.g. a flicker)
  }));
  return [play(el, keys, opts)];
}
function animateOut(root, dir) {
  const m = motion();
  return stTargets(root).flatMap((el, i) => fly(el, m.out(dir), { duration: m.outMs, delay: i * 14, easing: IN }));
}
function animateIn(root, dir) {
  const m = motion();
  return stTargets(root).flatMap((el, i) => fly(el, m.in(dir), { duration: m.inMs, delay: 40 + i * m.stagger, easing: m.inEase }).map(settle));
}
function revealRows(container, dir = 1) {
  if (!container) return;
  const m = motion();
  [...container.children].filter(onScreen).slice(0, 18).forEach((r, k) =>
    fly(r, m.row(dir), { duration: m.rowMs, delay: k * 20, easing: m.inEase }).forEach(settle));
}

/* =====================================================================
   Themes: each lives in themes/<id>/ (theme.css + theme.js), listed in themes/themes.js
   ===================================================================== */
/** "Album covers in the theme's colours" (System → Preferences). Each cover is turned into shades of
 *  three colours from the theme (dark, accent, light, set as --tone-dark/-mid/-light in the theme's CSS)
 *  with one SVG filter, so the real artwork is untouched and switching back is instant. */
const Covers = {
  filter: null,
  refresh() {
    const on = !!(S.settings && S.settings.themedCovers);
    document.body.classList.toggle("covers-themed", on);
    if (!on) return;
    if (!this.filter) {
      const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
      svg.setAttribute("width", "0"); svg.setAttribute("height", "0"); svg.setAttribute("aria-hidden", "true");
      svg.style.position = "absolute";
      svg.innerHTML = '<filter id="cover-tone" color-interpolation-filters="sRGB">' +
        '<feColorMatrix type="matrix" values=".2126 .7152 .0722 0 0  .2126 .7152 .0722 0 0  .2126 .7152 .0722 0 0  0 0 0 1 0"/>' +
        '<feComponentTransfer><feFuncR type="table"/><feFuncG type="table"/><feFuncB type="table"/></feComponentTransfer></filter>';
      document.body.append(svg);
      this.filter = svg;
    }
    const cs = getComputedStyle(document.documentElement);
    const rgb = (name, fb) => { const v = (cs.getPropertyValue(name).trim() || fb).split(/[\s,/]+/).map(Number); return v.length >= 3 && v.every((n) => n >= 0) ? v : fb.split(" ").map(Number); };
    const d = rgb("--tone-dark", "3 12 46"), m = rgb("--tone-mid", "63 224 255"), l = rgb("--tone-light", "244 253 255");
    ["R", "G", "B"].forEach((ch, i) => this.filter.querySelector("feFunc" + ch).setAttribute("tableValues", [d[i], m[i], l[i]].map((v) => (v / 255).toFixed(3)).join(" ")));
  },
};

const Theme = {
  list: (window.THEMES && window.THEMES.length) ? window.THEMES : [{ id: "tide", name: "TIDE · BLUE" }],
  defs: {}, links: {}, loading: {}, current: null,
  // Older builds saved these ids; map them to the renamed themes so the choice survives.
  alias: { p3: "tide", p5: "heist", cp: "neon" },
  meta(id) { id = this.alias[id] || id; return this.list.find((t) => t.id === id) || this.list[0]; },
  /** Themes you can cycle to and pick (secret ones stay out). */
  visible() { return this.list.filter((t) => !t.hidden); },
  next(id) { const v = this.visible(), i = v.findIndex((t) => t.id === id); return v[(i + 1) % v.length].id; },
  load(id) {
    if (this.loading[id]) return this.loading[id];
    this.loading[id] = new Promise((resolve) => {
      let pending = 2;
      const fin = () => { if (--pending === 0) resolve(this.defs[id] || { id }); };
      const link = document.createElement("link");
      link.rel = "stylesheet"; link.media = "not all";      // load now, switch on later
      link.href = `themes/${id}/theme.css`;
      link.onload = link.onerror = fin;
      document.head.append(link);
      this.links[id] = link;
      const script = document.createElement("script");
      script.src = `themes/${id}/theme.js`;
      script.onload = script.onerror = fin;
      document.head.append(script);
    });
    return this.loading[id];
  },
  swap(id, def) {
    if (this.current && this.current.leave) this.current.leave();
    for (const [k, link] of Object.entries(this.links)) link.media = k === id ? "all" : "not all";
    document.body.dataset.theme = id;
    const bg = $("bg");
    bg.textContent = "";
    this.current = def;
    if (def.background) def.background(bg, { h });
    const sw = $("sweep");
    sw.querySelectorAll(".th").forEach((n) => n.remove());           // previous theme's transition pieces
    if (def.overlay) def.overlay(sw, { h });
    Viz.colors = null; Viz.drewQuiet = false;                     // re-read the new theme's colours
    Covers.refresh();
    if (def.onArt) def.onArt(shownImage || null, this.helpers());
  },
  /** What a theme's onArt hook gets: a way to fetch a cover's pixels, and to say its colours changed. */
  helpers() {
    return {
      // A cover as a data: URL, so a theme can read its pixels (a web image would be off limits).
      dataURL: async (url) => { if (!bridge) return url; try { return await native("cover.dataURL", { url }); } catch (e) { return null; } },
      recolored: () => { Viz.colors = null; Viz.drewQuiet = false; Covers.refresh(); },
    };
  },
  /** Re-run every piece of text the theme styles itself (menu labels, headers, clock). */
  redecorate() {
    document.querySelectorAll("[data-title]").forEach((el) => this.text(el, el.dataset.title, el.dataset.kind || "header"));
    views.home.update();
    clock(true);
    if (current() && current().name === "home") { views.home.measure(); views.home.moveHL(true); }
  },
  async apply(id, animate) {
    id = this.meta(id).id;
    if (this.current && this.current.id === id) return;
    const def = await this.load(id);
    const cover = $("sweep").querySelector(".cover");
    let a = null;
    animate = animate && !reduced && this.current;
    if (animate) {
      setBusy(true);
      Sfx.play("theme", id);                                // the sound belongs to the theme that's arriving
      const cs = getComputedStyle(document.documentElement);
      const look = def.cover || { background: cs.getPropertyValue("--navy").trim(), borderRight: "3vw solid " + cs.getPropertyValue("--cyan").trim(), clipPath: "none" };
      Object.assign(cover.style, { background: "", borderRight: "", clipPath: "" }, look);
      sweep(1);
      a = play(cover, [{ transform: "translate3d(-170vw,0,0) skewX(-20deg)" }, { transform: "translate3d(0,0,0) skewX(-20deg)" }],
        { duration: 360, easing: "cubic-bezier(.6,0,.3,1)" });
      await a.finished;
    }
    this.swap(id, def);
    this.redecorate();
    if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, wait(600)]);
    this.redecorate();                                     // re-measure once the theme's fonts are in
    // Fonts and late stylesheet rules can shift the layout a moment later: measure once more so the
    // Home highlight sits on the right row.
    setTimeout(() => { if (this.current === def && !busy) this.redecorate(); }, 450);
    if (animate) {
      const b = play(cover, [{ transform: "translate3d(0,0,0) skewX(-20deg)" }, { transform: "translate3d(170vw,0,0) skewX(-20deg)" }],
        { duration: 420, easing: "cubic-bezier(.6,0,.3,1)" });
      const c = current();
      const ins = c ? animateIn(c.view.el, 1) : [];
      sweep(1);                                            // the new theme's own transition plays over the reveal
      await done([b, ...ins]);
      a.cancel(); b.cancel();
      setBusy(false);
    }
  },
  /** Themes can draw text their own way (e.g. collage letters). Default: plain text. */
  text(el, text, kind, opts = {}) {
    const key = (this.current ? this.current.id : "") + "|" + kind + "|" + text + "|" + (opts.active ? 1 : 0);
    if (el.dataset.tkey === key) return;
    el.dataset.tkey = key;
    el.classList.remove("rn");
    if (this.current && this.current.text && this.current.text(el, text, kind, opts) !== false) return;
    el.textContent = text;
  },
};
window.registerTheme = (def) => { if (def && def.id) Theme.defs[def.id] = def; };

/* =====================================================================
   Toast & key hints
   ===================================================================== */
let toastTimer;
let lastToast = "", lastToastAt = 0;
function toast(msg, isError) {
  if (msg === lastToast && Date.now() - lastToastAt < 8000) return;   // don't repeat the same message
  lastToast = msg; lastToastAt = Date.now();
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("err", !!isError);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), isError ? 3600 : 2200);
}

function setKeys(list) {
  const k = $("keys");
  k.textContent = "";
  for (const [key, label, action] of list) {
    const d = h("div", "key");
    d.append(h("b", null, key), h("span", null, label));
    if (action) { d.style.cursor = "pointer"; d.onclick = action; }
    k.append(d);
  }
}

/* =====================================================================
   Icons: small line icons drawn with SVG, so they look the same on every Mac and in every theme
   ===================================================================== */
const UI_ICONS = {
  play: "M7 4.5v15l12.5-7.5z",
  shuffle: "M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  share: "M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v13",
  trash: "M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2",
  heart: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z",
  artist: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  plus: "M12 5v14M5 12h14",
  check: "M20 6 9 17l-5-5",
  queue: "M4 6h16M4 12h10M4 18h7M16 15l5 3-5 3z",
  listAdd: "M3 6h12M3 12h12M3 18h8M18 13v8M14 17h8",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  album: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  external: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  image: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5",
  stop: "M6 6h12v12H6z",
  tools: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  palette: "M4 6h16M4 12h16M4 18h10",
  warn: "M12 3 2 21h20zM12 10v5M12 18h.01",
  expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
  pause: "M6 5h4v14H6zM14 5h4v14h-4z",
  prev: "M19 5v14l-10-7zM5 5h2.6v14H5z",
  next: "M5 5v14l10-7zM16.4 5H19v14h-2.6z",
  repeat: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  stats: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  translate: "M3 5h10M8 3v2M5 9c1.5 3 4 5 7 6M11 5c-1 4-4 8-8 10M13 21l4-9 4 9M14.5 18h5",
  mini: "M3 5h18v14H3zM12 12h7v5h-7z",
};
const FILLED_ICONS = { play: 1, heartFill: 1, stop: 1, pause: 1, prev: 1, next: 1 };
UI_ICONS.heartFill = UI_ICONS.heart;
const iconCache = {};
function icon(name) {
  if (!iconCache[name]) {
    const t = document.createElement("template");
    t.innerHTML = `<svg class="ico${FILLED_ICONS[name] ? " fill" : ""}${name === "more" ? " dots" : ""}" viewBox="0 0 24 24" aria-hidden="true"><path d="${UI_ICONS[name] || ""}"/></svg>`;
    iconCache[name] = t.content.firstChild;
  }
  return iconCache[name].cloneNode(true);
}
/** Puts an icon (and optional label) on a button. */
function setChip(el, name, label) {
  el.textContent = "";
  el.append(icon(name));
  if (label) el.append(h("span", null, label));
}
document.querySelectorAll("[data-icon]").forEach((b) => setChip(b, b.dataset.icon, b.textContent.trim()));

/* =====================================================================
   Small rendering helpers
   ===================================================================== */
function pickImage(images, big) {
  if (!images || !images.length) return null;
  const sorted = [...images].sort((a, b) => (b.width || 640) - (a.width || 640));
  if (big) return sorted[0].url;
  const fit = sorted.filter((i) => (i.width || 640) >= 120);
  return (fit.length ? fit[fit.length - 1] : sorted[sorted.length - 1]).url;
}
// Images are downloaded and decoded off the main thread before they're shown, so a cover
// arriving mid-transition doesn't stall the animation.
const decodedImages = new Set();
// A cover that had to be downloaded fades in instead of popping. (Covers you've already seen appear instantly.)
function fadeIn(el) {
  if (reduced || !el.isConnected) return;
  // Resting in the background (or hidden), there's no one to see a fade: just show the cover.
  if (document.hidden || document.body.classList.contains("paused")) return;
  const cur = getComputedStyle(el).animationName;
  if (cur !== "none") return;                          // don't fight an element's own theme animation
  // A Web Animation, not a CSS one: the CSS pause Cadenza uses while resting would freeze a CSS fade
  // on its first frame and leave the cover blank. This one can't be paused that way, and it leaves
  // nothing behind when it ends (fill: none), so the cover always ends up fully visible.
  if (el._fade) el._fade.cancel();
  el._fade = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: "ease-out", fill: "none" });
}
/** The Liked Songs cover: the theme's --liked-bg with a drawn heart (a font's ♥ looks different everywhere). */
function likedCover() {
  const d = h("div", "liked-cover");
  d.append(icon("heartFill"));
  return d;
}
function setBg(el, url) {
  el._bg = url || null;
  el.classList.add("art-img");                                  // so "album covers in the theme's colours" can find it
  if (!url) { el.style.backgroundImage = "none"; return; }
  const css = `url("${String(url).replace(/"/g, "%22")}")`;
  if (decodedImages.has(url)) { el.style.backgroundImage = css; return; }
  el.style.backgroundImage = "none";
  const im = new Image();
  im.src = url;
  (im.decode ? im.decode() : Promise.resolve()).catch(() => {}).then(() => {
    decodedImages.add(url);
    if (el._bg !== url) return;
    el.style.backgroundImage = css;
    fadeIn(el);
  });
}
const artistNames = (t) => (t.artists || []).map((a) => a.name).join(", ") || (t.show && t.show.name) || "";
const trackLine = (t) => artistNames(t) + (t.album && t.album.name ? "  ·  " + t.album.name : "");
const plCount = (p) => (p.items && p.items.total != null ? p.items.total : p.tracks && p.tracks.total != null ? p.tracks.total : null);
const isOwned = (p) => p.collaborative || (S.me && p.owner && p.owner.id === S.me.id);

function renderTrack(t, i, opts = {}) {
  const row = h("div", "trk");
  const inn = h("div", "in");
  let first;
  if (opts.thumb) { first = h("span", "thumb"); setBg(first, pickImage(t.album && t.album.images)); }
  else first = h("span", "no", String(i + 1).padStart(2, "0"));
  const ti = h("span", "ti");
  ti.append(h("b", null, t.name), h("i", null, trackLine(t)));
  const acts = h("span", "acts");
  const q = h("button"); setChip(q, "queue", "QUEUE"); q.dataset.act = "queue"; q.title = "Add to Up Next (Q)";
  const a = h("button"); setChip(a, "listAdd", "LIST"); a.dataset.act = "add"; a.title = "Add to a playlist (A)";
  const m = h("button", "more"); setChip(m, "more"); m.dataset.act = "more"; m.title = "More (M)";
  acts.append(q, a, m);
  inn.append(first, ti, acts, h("span", "du", fmt(t.duration_ms)));
  row.append(inn);
  if (t.is_local) row.classList.add("dim");
  if (!opts.noCount) { row.__t = t; PlayCounts.decorate(row, t); }      // "· 214 plays", from Last.fm
  return row;
}

function renderMedia(it, type) {
  const row = h("div", "trk media " + type);
  const inn = h("div", "in");
  const th = h("span", "thumb");
  setBg(th, pickImage(it.images || (it.album && it.album.images)));
  const ti = h("span", "ti");
  let sub = "";
  if (type === "album") sub = artistNames(it) + (it.release_date ? "  ·  " + it.release_date.slice(0, 4) : "") + (it.album_type ? "  ·  " + upper(it.album_type) : "");
  else if (type === "artist") sub = (it.genres && it.genres.length ? it.genres.slice(0, 3).join(", ") : "Artist");
  else if (type === "playlist") { const n = plCount(it); sub = "by " + ((it.owner && (it.owner.display_name || it.owner.id)) || "?") + (n != null ? "  ·  " + n + " tracks" : ""); }
  ti.append(h("b", null, it.name), h("i", null, sub));
  inn.append(th, ti, h("span", "acts"), h("span", "du", upper(type === "track" ? "" : type)));
  row.append(inn);
  return row;
}

/* =====================================================================
   List: keyboard + mouse selection over a scrolling container
   ===================================================================== */
class List {
  constructor(el, opts) {
    this.el = el; this.o = opts; this.items = []; this.rows = []; this.i = 0;
    el.addEventListener("mousemove", (e) => {
      const r = e.target.closest("[data-i]");
      if (r && el.contains(r) && +r.dataset.i !== this.i) this.select(+r.dataset.i, false);
    });
    el.addEventListener("click", (e) => {
      const r = e.target.closest("[data-i]");
      if (!r || !el.contains(r) || busy) return;
      const b = e.target.closest("[data-act]");
      this.select(+r.dataset.i, false);
      if (b && b.dataset.act === "more") return TrackMenu.show(this.items[this.i]);
      if (!b) pop(this.rows[this.i]);
      if (opts.onActivate) opts.onActivate(this.items[this.i], this.i, b ? b.dataset.act : null);
    });
    el.addEventListener("contextmenu", (e) => {
      const r = e.target.closest("[data-i]");
      if (!r || !el.contains(r) || e.altKey) return;
      const it = this.items[+r.dataset.i];
      if (!isTrack(it)) return;
      e.preventDefault();
      this.select(+r.dataset.i, false);
      TrackMenu.show(it);
    });
    el.addEventListener("scroll", () => {
      if (opts.onNearEnd && el.scrollTop + el.clientHeight > el.scrollHeight - el.clientHeight * 0.6) opts.onNearEnd();
    }, { passive: true });
  }
  set(items) {
    this.el.textContent = ""; this.items = []; this.rows = []; this.i = 0; this.el.scrollTop = 0;
    this.add(items || []);
  }
  add(items) {
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const idx = this.items.length;
      const r = this.o.render(it, idx);
      r.dataset.i = idx;
      this.items.push(it); this.rows.push(r); frag.append(r);
    }
    this.el.append(frag);
    if (this.rows.length && !this.rows[this.i].classList.contains("active")) this.rows[this.i].classList.add("active");
  }
  select(i, scroll = true) {
    if (!this.rows.length) return;
    i = Math.max(0, Math.min(this.rows.length - 1, i));
    if (this.rows[this.i]) this.rows[this.i].classList.remove("active");
    this.i = i;
    const r = this.rows[i];
    r.classList.add("active");
    if (scroll) this.reveal(r);
    if (this.o.onSelect) this.o.onSelect(this.items[i], i);
  }
  reveal(r) {
    const el = this.el, pad = r.offsetHeight * 1.2, t = r.offsetTop, b = t + r.offsetHeight;
    if (t - pad < el.scrollTop) el.scrollTo({ top: Math.max(0, t - pad), behavior: reduced ? "auto" : "smooth" });
    else if (b + pad > el.scrollTop + el.clientHeight) el.scrollTo({ top: b + pad - el.clientHeight, behavior: reduced ? "auto" : "smooth" });
  }
  move(dx, dy) { this.select(this.i + dx + dy * (this.o.columns || 1)); }
  page(d) { const per = Math.max(1, Math.floor(this.el.clientHeight / ((this.rows[0] && this.rows[0].offsetHeight) || 40))); this.select(this.i + d * per); }
  get cur() { return this.items[this.i]; }
  /** Arrow/Page keys; returns true when handled. */
  nav(e) {
    const c = this.o.columns || 1;
    switch (e.key) {
      case "ArrowDown": this.move(0, 1); return true;
      case "ArrowUp": this.move(0, -1); return true;
      case "ArrowRight": if (c > 1) { this.move(1, 0); return true; } return false;
      case "ArrowLeft": if (c > 1) { this.move(-1, 0); return true; } return false;
      case "PageDown": this.page(1); return true;
      case "PageUp": this.page(-1); return true;
      case "Home": this.select(0); return true;
      case "End": this.select(this.rows.length - 1); return true;
    }
    return false;
  }
}

/* =====================================================================
   Router + transitions
   ===================================================================== */
const views = {};
const stack = [];
const current = () => stack[stack.length - 1];

async function go(name, params = {}, opts = {}) {
  if (busy && !opts.force) return;
  const from = current();
  if (from && from.name === name && !opts.reset) return;
  if (opts.reset) stack.length = 0;
  const entry = { name, view: views[name], params };
  stack.push(entry);
  await transition(from, entry, opts.dir || 1, false);
}
async function back() {
  if (busy || stack.length < 2) return;
  Sfx.play("back");
  const from = stack.pop();
  await transition(from, current(), -1, true);
}

async function transition(from, to, dir, isBack) {
  setBusy(true);
  if (!isBack && from) Sfx.play("page");
  try {
    if (from && from.view.leave) from.view.leave();
    sweep(-dir);
    const outs = from ? animateOut(from.view.el, dir) : [];
    if (from) await wait(110);                       // overlap: the next menu arrives while this one leaves
    document.body.dataset.view = to.name;
    setKeys(to.view.keys ? to.view.keys() : []);
    to.view.el.hidden = false;
    if (to.view.show) to.view.show(to.params || {}, isBack);
    const ins = animateIn(to.view.el, dir);
    if (to.view.afterShow) to.view.afterShow();
    await done(outs);
    if (from && from.view !== to.view) {
      from.view.el.hidden = true;
      cancelAll([...from.view.el.querySelectorAll(".st"), ...from.view.el.querySelectorAll("[data-i]")]);
    }
    await done(ins);
  } finally {
    setBusy(false);
  }
}

/* =====================================================================
   Playback commands
   ===================================================================== */
async function findDevice() {
  const r = await api("GET", "/me/player/devices");
  const list = (r.body && r.body.devices) || [];
  const mine = list.find((x) => x.name === S.settings.deviceName);
  const d = mine || list.find((x) => x.is_active) || list[0];
  return { id: d && d.id, mine: !!mine };
}
async function ourDevice() {
  let d = await findDevice();
  if (!d.mine && S.settings.manageLibrespot !== false) {
    // Spotify has lost Cadenza as a speaker (usually after sleep or a network change). Have the engine
    // register again, then look for it for a few seconds.
    toast("RECONNECTING CADENZA AS A SPEAKER…");
    const r = await native("engine.ensure").catch(() => null);
    for (let n = 0; r && r.ok && !d.mine && n < 8; n++) { await wait(800); d = await findDevice(); }
  }
  return d.id;
}

async function playBody(body, label, fromDJ, fromRadio, fromShuffle) {
  if (!fromDJ) DJ.interrupt();
  if (!fromRadio) Radio.stop();
  if (!fromShuffle) TrueShuffle.stop();
  Radio.firstUri = body.uris ? body.uris[0] : null;   // where a song list "wraps" back to when it ends
  native("audio.local", { action: "skip" }).catch(() => {});      // the old song goes quiet right away
  const fallback = body.fallback; if (fallback) { body = { ...body }; delete body.fallback; }
  // A specific speaker (after the engine restarts, Spotify may still point at the old, dead session).
  const dev = body.device_id; if (dev) { body = { ...body }; delete body.device_id; }
  const playPath = dev ? `/me/player/play?device_id=${enc(dev)}` : "/me/player/play";
  let r = await api("PUT", playPath, body);
  if (r.status === 404) {
    const id = await ourDevice();
    if (id) r = await api("PUT", `/me/player/play?device_id=${enc(id)}`, body);
  }
  // A context Spotify won't take (or an offset it can't find): play the plain song list instead.
  if ((r.status === 400 || r.status === 404) && fallback) r = await api("PUT", playPath, fallback);
  else if (r.status === 400 && body.offset && body.offset.position != null && body.context_uri) {
    r = await api("PUT", playPath, { context_uri: body.context_uri });
  }
  if (r.status >= 200 && r.status < 300) {
    if (label) toast("▶ " + upper(label));
    setTimeout(poll, 400);                                       // (also picks up the new playlist/album, for ⌘S true shuffle)
    return true;
  }
  toast(errMsg(r), true);
  return false;
}

/** Q / "Add to queue": the song goes into Cadenza's own Up Next (which you can reorder and edit). */
async function queueTrack(t, front) {
  if (!t || !isTrack(t)) return;
  UpNext.add(t, front);
}

async function cmd(id) {
  const p = S.player;
  let r;
  switch (id) {
    case "toggle": {
      const playing = !!(p && p.is_playing);
      if (p) { p.progress_ms = progressNow(); p.is_playing = !playing; S.stamp = Date.now(); renderNow(); views.home.update(); }
      native("audio.local", { action: playing ? "pause" : "play" }).catch(() => {});   // sound stops/starts instantly
      r = await api("PUT", playing ? "/me/player/pause" : "/me/player/play");
      if (r.status === 404 && !playing) {
        const dev = await ourDevice();
        if (dev) r = await LastPlayed.resumeOn(dev);
      }
      break;
    }
    case "next":
      if (p && p.item) Radio.skipFrom = { uri: p.item.uri, at: Date.now() };     // nothing next? autoplay takes over (Radio.ended)
      native("audio.local", { action: "skip" }).catch(() => {});
      r = Radio.active && !UpNext.items.length && !UpNext.fed ? await Radio.skip() : await api("POST", "/me/player/next");
      break;
    case "previous": native("audio.local", { action: "skip" }).catch(() => {}); r = await api("POST", "/me/player/previous"); break;
    case "shuffle": {
      const on = !(p && p.shuffle_state);
      if (!on && TrueShuffle.active) { await TrueShuffle.off(); break; }          // back to the playlist's own order
      if (on && TrueShuffle.enabled() && await TrueShuffle.fromNowPlaying()) break;   // Cadenza shuffles it, truly at random
      r = await api("PUT", `/me/player/shuffle?state=${on}`);
      if (r.status < 300 && p) p.shuffle_state = on;
      break;
    }
    case "repeat": {
      const order = ["off", "context", "track"];
      const next = order[(order.indexOf((p && p.repeat_state) || "off") + 1) % 3];
      if (TrueShuffle.active && next !== "track") {
        // True shuffle hands Spotify its own song list, and librespot only keeps the next few songs of a
        // list like that. Spotify's repeat would loop just those few, so Cadenza loops the whole thing itself.
        TrueShuffle.repeat = next === "context";
        r = await api("PUT", "/me/player/repeat?state=off");
        if (r.status < 300 && p) p.repeat_state = next;
        break;
      }
      if (TrueShuffle.active) TrueShuffle.repeat = false;          // repeat one song: Spotify does that fine
      r = await api("PUT", `/me/player/repeat?state=${next}`);
      if (r.status < 300 && p) p.repeat_state = next;
      break;
    }
  }
  if (r && r.status >= 300) {
    toast(errMsg(r), true);
    if (id === "toggle" && p) {                                    // it didn't happen: undo
      p.is_playing = !p.is_playing; S.stamp = Date.now(); renderNow();
      native("audio.local", { action: p.is_playing ? "play" : "pause" }).catch(() => {});
    }
  }
  views.home.update();
  // Playing through Cadenza, its own engine reports the change straight away: no need to ask Spotify too.
  if (!Local.active()) setTimeout(poll, 350);
}

/* =====================================================================
   Now playing panel + polling
   ===================================================================== */
const setText = (id, t) => { const el = $(id); if (el.textContent !== t) el.textContent = t; };
let shownKey, shownImage = null, lastPos = 0, lastNativeKey = "", lastNativeAt = 0, lastNativePos = 0, lastNativePlaying = false;

function simplify(b) {
  const it = b.item;
  return {
    is_playing: !!b.is_playing,
    shuffle_state: !!b.shuffle_state,
    repeat_state: b.repeat_state || "off",
    context: b.context && b.context.uri || null,
    progress_ms: b.progress_ms || 0,
    device: b.device ? b.device.name : null,
    volume: b.device && b.device.volume_percent != null ? b.device.volume_percent : null,
    item: it ? {
      raw: it,
      uri: it.uri,
      name: it.name,
      artists: artistNames(it),
      album: it.album ? it.album.name : (it.show ? it.show.name : ""),
      image: pickImage((it.album && it.album.images) || it.images, true),
      duration_ms: it.duration_ms || 1,
    } : null,
  };
}
const progressNow = () => {
  const p = S.player;
  if (!p || !p.item) return 0;
  return Math.min(p.item.duration_ms, p.progress_ms + (p.is_playing ? Date.now() - S.stamp : 0));
};

// Playback status: the progress bar runs on its own between checks, so Spotify only needs asking
// every 5 s while playing (right as a song ends, too), every 12 s when paused, and every 30 s when
// Cadenza is hidden. Anything you do in Cadenza, and media keys, check straight away.
let pollBusy = false, nextPoll = 0;
// librespot (Cadenza's own audio engine) reports what it's playing directly, so while music plays
// through Cadenza there's no need to keep asking Spotify: a check once a minute keeps shuffle/repeat in sync.
const Local = {
  d: null, at: 0,
  active() { return !!(this.d && this.d.active !== false && this.d.uri && Date.now() - this.at < 6 * 3600e3); },
  update(d) {
    if (!d) return;
    const prev = S.player || {}, pi = prev.item || {};
    const same = pi.uri && d.uri === pi.uri;
    this.d = d; this.at = Date.now();
    if (!d.uri) return;
    if (!d.name && !same) { nextPoll = 0; return; }        // new song but no details yet: ask Spotify
    const name = d.name || pi.name, artists = d.artists != null && d.name ? d.artists : pi.artists;
    const album = d.name ? d.album : pi.album, image = d.name ? d.image : pi.image;
    const item = {
      uri: d.uri, name, artists, album, image, duration_ms: d.duration_ms || pi.duration_ms || 1,
      raw: same && pi.raw ? pi.raw : { uri: d.uri, name, artists: String(artists || "").split(", ").map((n) => ({ name: n })), album: { name: album, images: image ? [{ url: image, width: 640 }] : [] } },
    };
    // Only librespot's own "paused"/"stopped" reports mean the music stopped. Losing the Spotify session
    // (d.active false) can happen while the song keeps playing through Cadenza.
    const playing = !!d.is_playing;
    setPlayer({
      is_playing: playing, shuffle_state: !!prev.shuffle_state, repeat_state: prev.repeat_state || "off", context: prev.context || null,
      progress_ms: (d.progress_ms || 0) + (playing ? Math.max(0, Date.now() - (d.at || Date.now())) : 0),
      device: d.device || prev.device, volume: d.volume != null ? d.volume : prev.volume, item,
    });
  },
};
function pollGap() {
  const p = S.player;
  if (Local.active()) return 60000;
  if (document.hidden || S.asleep) return 30000;
  if (!p || !p.is_playing || !p.item) return 12000;
  const left = p.item.duration_ms - progressNow();
  return Math.max(1200, Math.min(5000, left + 800));
}
async function poll() {
  if (pollBusy || !S.loggedIn) return;
  pollBusy = true;
  try {
    const r = await api("GET", "/me/player?additional_types=track,episode");
    // While music plays through Cadenza's own engine, librespot's reports are the truth: Spotify's
    // answer is often a few seconds old (or empty) for this kind of device, and taking it would make
    // the song "rewind", lose its cover or vanish. Only shuffle, repeat and volume come from Spotify.
    // (Also while librespot still says it's playing after its Spotify session dropped: Spotify then often
    // answers "nothing playing" for a song that's still coming through Cadenza.)
    const mine = (Local.active() || (Local.d && Local.d.is_playing && Date.now() - Local.at < 30 * 60e3)) && S.player && S.player.item && S.player.item.uri === Local.d.uri;
    if (mine && (r.status === 204 || (r.status === 200 && r.body && (!r.body.device || r.body.device.name === Local.d.device)))) {
      if (r.status === 200) {
        const b = simplify(r.body);
        S.player.shuffle_state = b.shuffle_state || TrueShuffle.active;
        S.player.repeat_state = TrueShuffle.active && TrueShuffle.repeat ? "context" : b.repeat_state;
        if (b.context !== undefined) S.player.context = b.context;
        if (b.volume != null && Date.now() > S.volLock) { S.player.volume = b.volume; renderVolume(b.volume); }
        Controls.render();
      }
    }
    else if (r.status === 200 && r.body) setPlayer(simplify(r.body));
    else if (r.status === 204) setPlayer(null);
  } finally { pollBusy = false; nextPoll = Date.now() + pollGap(); }
}

function setPlayer(p) {
  const prevUri = S.player && S.player.item && S.player.item.uri;
  if (p && TrueShuffle.active) p.shuffle_state = true;           // Cadenza is doing the shuffling (Spotify's is off)
  if (p && TrueShuffle.active && TrueShuffle.repeat) p.repeat_state = "context";   // and the repeating
  S.player = p; S.stamp = Date.now();
  renderNow();
  views.home.update();
  const uri = p && p.item && p.item.uri;
  if (uri !== prevUri) {
    if (p && p.item) Radio.heard(p.item);
    Radio.refreshQueue();                                       // the Queue page follows skips and song changes
    const fromUpNext = UpNext.onTrack(uri);
    views.playlist.markPlaying(); views.album.markPlaying(); DJ.onTrack(uri, fromUpNext); Radio.onTrack(uri, fromUpNext); TrueShuffle.onTrack(uri, fromUpNext);
    checkLiked(uri);
    if (p && p.item) PlayCounts.exactFor(p.item);
    if (current() && current().name === "lyrics") views.lyrics.load();
  }
  if (p && p.volume != null && Date.now() > S.volLock) renderVolume(p.volume);
  else if (p && p.volume == null) renderVolume(null);
  // keep Control Center / lock screen in sync
  sendNowPlaying();
  if (p && !p.is_playing) Radio.checkEnd();
}
function sendNowPlaying(force) {
  const p = S.player, it = p && p.item;
  const theme = Theme.current ? Theme.current.id : "tide";
  const key = (it && it.uri) + "|" + (p && p.is_playing) + "|" + S.liked + "|" + (p && p.volume) + "|" + theme;
  // Also send when the position jumps (a seek, or Spotify correcting us), so the mini players and
  // Control Center don't drift from what you hear.
  const pos = it ? progressNow() : 0;
  const expected = lastNativePos + (lastNativePlaying ? Date.now() - lastNativeAt : 0);
  const jumped = Math.abs(pos - expected) > 2000;
  if (!force && !jumped && key === lastNativeKey && Date.now() - lastNativeAt < 15000) return;
  lastNativeKey = key; lastNativeAt = Date.now(); lastNativePos = pos; lastNativePlaying = !!(p && p.is_playing);
  if (it) LastPlayed.note(p, pos);
  native("nowplaying", it ? { uri: it.uri, title: it.name, artist: it.artists, album: it.album, art: it.image || "",
    duration: it.duration_ms, position: pos, playing: !!p.is_playing, liked: !!S.liked,
    volume: p.volume != null ? p.volume : 70, theme } : { theme }).catch(() => {});
}

/* ---------- like, volume, share ---------- */
const isTrack = (t) => !!(t && t.uri && /^spotify:(track|episode):/.test(t.uri));
const spotifyURL = (uri) => { const [, type, id] = String(uri || "").split(":"); return type && id ? `https://open.spotify.com/${type}/${id}` : ""; };
async function copyLink(uri, what) {
  const url = spotifyURL(uri);
  if (!url) return;
  try { await native("clipboard", { text: url }); } catch (e) { try { await navigator.clipboard.writeText(url); } catch (_) { /* demo */ } }
  toast("LINK COPIED" + (what ? ": " + upper(what) : ""));
}
// Skipping fast asks "is this song liked?" for the same few songs over and over. Ask once per song and
// reuse the answer for a minute.
const savedCache = new Map();
function isSaved(uri) {
  const hit = savedCache.get(uri);
  if (hit && Date.now() - hit.at < 60000) return hit.p;
  const p = api("GET", `/me/library/contains?uris=${enc(uri)}`)
    .then((r) => (r.status === 200 && Array.isArray(r.body) ? !!r.body[0] : null))
    .then((v) => { if (v === null) savedCache.delete(uri); return v; }, (e) => { savedCache.delete(uri); throw e; });
  savedCache.set(uri, { at: Date.now(), p });
  if (savedCache.size > 200) savedCache.delete(savedCache.keys().next().value);
  return p;
}
async function setSaved(uri, on) {
  savedCache.delete(uri);
  const r = await api(on ? "PUT" : "DELETE", `/me/library?uris=${enc(uri)}`);
  if (r.status >= 300) { toast(errMsg(r), true); return false; }
  return true;
}
async function checkLiked(uri) {
  S.liked = false; renderLike();
  if (!uri || !/^spotify:track:/.test(uri)) return;
  const v = await isSaved(uri);
  if (S.player && S.player.item && S.player.item.uri === uri) { S.liked = !!v; renderLike(); sendNowPlaying(); }
}
async function toggleLike(t) {
  const it = t || (S.player && S.player.item);
  if (!it || !/^spotify:track:/.test(it.uri)) return toast("NOTHING TO LIKE", true);
  const nowPlaying = S.player && S.player.item && S.player.item.uri === it.uri;
  const was = nowPlaying ? S.liked : await isSaved(it.uri);
  if (!(await setSaved(it.uri, !was))) return;
  if (nowPlaying) { S.liked = !was; renderLike(); sendNowPlaying(); }
  if (S.likedTotal != null) S.likedTotal += was ? -1 : 1;
  toast(was ? "REMOVED FROM LIKED SONGS" : "♥ ADDED TO LIKED SONGS");
  pop($("np-like"));
}
function renderLike() {
  const b = $("np-like");
  setChip(b, S.liked ? "heartFill" : "heart");
  b.classList.toggle("on", !!S.liked);
}
let volTimer;
function renderVolume(v) {
  setText("np-volv", v == null ? "–" : String(v));
  $("np-volfill").style.transform = `scaleX(${v == null ? 0 : v / 100})`;
}
function setVolume(v) {
  v = Math.max(0, Math.min(100, Math.round(v)));
  if (S.player) S.player.volume = v;
  S.volLock = Date.now() + 2500;                  // don't let a poll snap the bar back mid-change
  renderVolume(v);
  clearTimeout(volTimer);
  volTimer = setTimeout(async () => {
    const r = await api("PUT", `/me/player/volume?volume_percent=${v}`);
    if (r.status >= 300) toast(r.status === 403 ? "THIS DEVICE DOESN'T ALLOW VOLUME CONTROL" : errMsg(r), true);
    sendNowPlaying();
  }, 160);
}

function applyNow() {
  const p = S.player, it = p && p.item;
  setText("np-device", p && p.device ? upper(p.device) : "NO DEVICE");
  setText("np-state", p && p.is_playing ? "▶ PLAYING" : "❚❚ PAUSED");
  document.body.classList.toggle("playing", !!(p && p.is_playing));
  setText("np-title", it ? it.name : "Nothing playing");
  setText("np-artist", it ? it.artists : "Pick something from Library or Search");
  const plays = it ? PlayCounts.of(it) : 0;
  setText("np-album", it ? [it.album, PlayCounts.text(plays)].filter(Boolean).join("  ·  ") : "");
  setText("np-pcap", it ? cleanTitle(it.name) : "");
  const img = (it && it.image) || null;
  if (img !== shownImage) {
    shownImage = img;
    if (Theme.current && Theme.current.onArt) Theme.current.onArt(img, Theme.helpers());
    if (!img) setBg($("np-photo"), null);
    else {
      const pre = new Image();
      pre.onload = pre.onerror = () => { if (shownImage === img) setBg($("np-photo"), img); };
      pre.src = img;
    }
  }
}

function renderNow() {
  Controls.render();
  const key = S.player && S.player.item ? S.player.item.uri : null;
  if (shownKey !== undefined && key !== shownKey && !document.body.classList.contains("paused")) {
    shownKey = key;
    const art = $("np-artwrap"), txt = $("np-text");
    const m = motion();
    const a1 = play(art, m.trackOut.art, { duration: m.trackOut.ms, easing: IN });
    const a2 = play(txt, m.trackOut.text, { duration: m.trackOut.ms, easing: IN });
    // If Cadenza is hidden mid-change the animations can stall; never let that leave an old song or a
    // blank cover on screen.
    Promise.race([done([a1, a2]), new Promise((r) => setTimeout(r, m.trackOut.ms + 250))]).then(() => {
      if (shownKey !== key) return;                    // an even newer song took over
      a1.cancel(); a2.cancel();
      applyNow(); tick(true);
      settle(play(art, m.trackIn.art, { duration: m.trackIn.ms, easing: m.inEase }));
      settle(play(txt, m.trackIn.text, { duration: m.trackIn.ms, delay: 40, easing: m.inEase }));
    });
    return;
  }
  shownKey = key;
  applyNow(); tick(false);
}

function tick(jump) {
  if (S.asleep) return;                                  // window closed: nothing to show it on
  const it = S.player && S.player.item, fill = $("np-fill");
  if (!it) { setText("np-pos", "0:00"); setText("np-dur", "0:00"); fill.style.transform = "scaleX(0)"; lastPos = 0; return; }
  const p = progressNow();
  setText("np-pos", fmt(p)); setText("np-dur", fmt(it.duration_ms));
  const t = `scaleX(${(p / it.duration_ms).toFixed(4)})`;
  if (jump || p < lastPos - 1500 || p > lastPos + 2500) {
    fill.style.transition = "none"; fill.style.transform = t; void fill.offsetWidth; fill.style.transition = "";
  } else fill.style.transform = t;
  lastPos = p;
}

/* =====================================================================
   Library data
   ===================================================================== */
async function loadMe() {
  if (S.me) return S.me;
  const r = await api("GET", "/me");
  if (r.status === 200) S.me = r.body;
  return S.me;
}
/** Every item from a paged Spotify list, following "next" until there are `max` (or no more pages). */
async function pagesOf(path, max) {
  const out = [];
  while (path && out.length < max) {
    const r = await api("GET", path);
    if (r.status !== 200 || !r.body) break;
    out.push(...(r.body.items || []));
    path = relPath(r.body.next);
  }
  return out;
}
let playlistsPromise = null;
function loadPlaylists(force) {
  if (S.playlists && !force && Date.now() - S.playlistsAt < 120000) return Promise.resolve(S.playlists);
  if (playlistsPromise) return playlistsPromise;
  playlistsPromise = (async () => {
    await loadMe();
    const out = (await pagesOf("/me/playlists?limit=50", 600)).filter(Boolean);
    const liked = await api("GET", "/me/tracks?limit=1");
    S.likedTotal = liked.status === 200 && liked.body ? liked.body.total : null;
    S.playlists = out; S.playlistsAt = Date.now();
    setTimeout(() => Tags.schedule([{ kind: "liked", name: "Liked Songs" }, ...out]), 400);
    return out;
  })().finally(() => { playlistsPromise = null; });
  return playlistsPromise;
}

/* =====================================================================
   Playlist editing
   ===================================================================== */
async function createPlaylist(name) {
  const r = await api("POST", "/me/playlists", { name, public: false, description: "Made with Cadenza" });
  if (r.status >= 300 || !r.body || !r.body.id) { toast(errMsg(r), true); return null; }
  const pl = r.body;
  if (!pl.items && !pl.tracks) pl.items = { total: 0 };
  if (!pl.owner && S.me) pl.owner = { id: S.me.id, display_name: S.me.display_name };
  if (S.playlists) S.playlists.unshift(pl);
  toast("CREATED " + upper(name));
  return pl;
}
/** Text from a bit of HTML (Spotify sends playlist descriptions with links and entities). DOMParser builds
 *  an inert document: unlike a div's innerHTML, nothing in it loads or runs, so a booby-trapped
 *  description like <img onerror=…> stays harmless. */
function plainText(html) {
  if (!html) return "";
  return new DOMParser().parseFromString(html, "text/html").body.textContent || "";
}
async function editPlaylist(pl) {
  const r0 = await api("GET", `/playlists/${pl.id}?fields=name,description,public,collaborative,images`);
  const cur = r0.status === 200 && r0.body ? r0.body : pl;
  const v = await Modal.open({
    title: "EDIT PLAYLIST", ok: "SAVE",
    fields: [
      { key: "name", label: "Name", type: "text", value: cur.name || pl.name },
      { key: "description", label: "Description", type: "textarea", value: plainText(cur.description) },
      { key: "public", label: "Public", type: "toggle", value: !!cur.public },
      { key: "collaborative", label: "Collaborative", type: "toggle", value: !!cur.collaborative },
    ],
    extra: [{ label: "CHANGE COVER", icon: "image", run: () => uploadCover(pl) }],
  });
  if (!v || !v.name) return false;
  if (v.collaborative) v.public = false;               // Spotify rule: collaborative playlists are private
  const r = await api("PUT", `/playlists/${pl.id}`, { name: v.name, description: v.description, public: v.public, collaborative: v.collaborative });
  if (r.status >= 300) { toast(errMsg(r), true); return false; }
  Object.assign(pl, { name: v.name, description: v.description, public: v.public, collaborative: v.collaborative });
  toast("SAVED " + upper(v.name));
  return true;
}
async function uploadCover(pl) {
  toast("CHOOSE AN IMAGE…");
  let r;
  try { r = await native("cover.upload", { playlistId: pl.id }); } catch (e) { r = { status: 0 }; }
  if (!r || !r.status) return toast("NO IMAGE CHOSEN");
  if (r.status >= 300) return toast(r.status === 401 || r.status === 403 ? "LOG IN AGAIN TO ALLOW COVER UPLOADS" : "COVER UPLOAD FAILED (" + r.status + ")", true);
  toast("NEW COVER UPLOADED");
  // Spotify processes the image for a moment before it shows up.
  setTimeout(async () => {
    const g = await api("GET", `/playlists/${pl.id}?fields=images`);
    if (g.status === 200 && g.body) {
      pl.images = g.body.images;
      if (views.playlist.pl && views.playlist.pl.id === pl.id) setBg($("pl-cover"), pickImage(pl.images, true));
      views.library.filled = false;
    }
  }, 2500);
}
async function deletePlaylist(pl) {
  // Spotify "deletes" a playlist by removing it from your library (the owner can recover it later).
  let r = await api("DELETE", `/me/library?uris=${enc(pl.uri)}`);
  if (r.status === 404 || r.status === 405) r = await api("DELETE", `/playlists/${pl.id}/followers`);
  if (r.status >= 300) { toast(errMsg(r), true); return false; }
  if (S.playlists) S.playlists = S.playlists.filter((x) => x.id !== pl.id);
  toast("DELETED " + upper(pl.name));
  return true;
}

/* =====================================================================
   Modal: themed prompt / confirm.  await Modal.open({title, text, input?, ok, danger})
   resolves to the typed text (prompt), true (confirm) or null (cancelled)
   ===================================================================== */
const Modal = {
  isOpen: false, resolve: null, hasInput: false,
  open({ title, text = "", input = null, ok = "OK", danger = false, fields = null, extra = null }) {
    if (this.resolve) this.close(null);
    this.isOpen = true;
    this.hasInput = input !== null;
    this.fields = fields;
    const box = $("modal-fields");
    box.textContent = "";
    for (const f of fields || []) {
      const row = h("label", "mf mf-" + f.type);
      row.append(h("span", "mfl", f.label));
      let ctl;
      if (f.type === "toggle") {
        ctl = h("button", "sw" + (f.value ? " on" : ""));
        ctl.type = "button";
        ctl.onclick = (e) => { e.preventDefault(); ctl.classList.toggle("on"); };
      } else {
        ctl = h(f.type === "textarea" ? "textarea" : "input");
        ctl.value = f.value || "";
        ctl.spellcheck = false;
        if (f.type === "textarea") ctl.rows = 3;
      }
      ctl.dataset.key = f.key;
      row.append(ctl);
      box.append(row);
    }
    for (const x of extra || []) {
      const b = h("button", "mx", x.label);
      if (x.icon) setChip(b, x.icon, x.label);
      b.type = "button";
      b.onclick = (e) => { e.preventDefault(); x.run(); };
      box.append(b);
    }
    $("modal-title").textContent = title;
    $("modal-text").textContent = text;
    const inp = $("modal-input");
    inp.hidden = !this.hasInput;
    inp.value = this.hasInput ? input : "";
    $("modal-ok").textContent = ok;
    $("modal").classList.toggle("danger", !!danger);
    $("modal").classList.add("on");
    const firstField = box.querySelector("input, textarea");
    setTimeout(() => (this.hasInput ? (inp.focus(), inp.select()) : firstField ? (firstField.focus(), firstField.select()) : $("modal-ok").focus()), 60);
    return new Promise((res) => { this.resolve = res; });
  },
  close(value) {
    this.isOpen = false;
    $("modal").classList.remove("on");
    if (document.activeElement) document.activeElement.blur();
    const r = this.resolve; this.resolve = null;
    if (r) r(value);
  },
  confirm() {
    if (this.hasInput) { const v = $("modal-input").value.trim(); if (!v) return; this.close(v); }
    else if (this.fields) {
      const out = {};
      $("modal-fields").querySelectorAll("[data-key]").forEach((el) => {
        out[el.dataset.key] = el.tagName === "BUTTON" ? el.classList.contains("on") : el.value.trim();
      });
      this.close(out);
    } else this.close(true);
  },
  onKey(e) {
    if (e.key === "Enter" && !(e.target.tagName === "TEXTAREA" && !e.metaKey)) { this.confirm(); return true; }
    if (e.key === "Escape") { this.close(null); return true; }
    return !(e.target.matches && e.target.matches("input, textarea, button"));   // let typing and Tab work
  },
};
$("modal-ok").onclick = () => Modal.confirm();
$("modal-cancel").onclick = () => Modal.close(null);
$("modal").addEventListener("mousedown", (e) => { if (e.target.id === "modal") Modal.close(null); });

/* =====================================================================
   DJ: builds sets from your own listening and talks between segments.
   (Spotify's own DJ isn't available to apps, so this is Cadenza's version.)
   ===================================================================== */
const cleanTitle = (t) => String(t || "").replace(/\s*[([].*?(feat|with|remaster|version|edit|mix|live|mono|stereo).*?[)\]]/gi, "").replace(/\s+-\s+.*(remaster|version|edit|live).*$/i, "").trim();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const DJ = {
  active: false, building: false, segments: [], announced: new Set(), lastLine: "", talking: false,
  SEG: {
    // Written the way people talk: short bits, contractions, a little personality.
    repeat: { title: "ON REPEAT", lines: [
      (t, a) => `Okay, let's start with the one you can't stop playing. ${t}. ${a}. You know the words.`,
      (t, a) => `You've had ${a} on loop lately, and fair enough. Here's ${t}.`,
      (t, a) => `Right back to your current favourites. This is ${t}, from ${a}.`,
      (t, a) => `Alright. You've been living in this one. ${t}, ${a}.`] },
    throwback: { title: "THROWBACKS", lines: [
      (t, a) => `Let's rewind a little. Remember this? ${t}, by ${a}.`,
      (t, a) => `Okay, throwback time. There was a stretch where you played ${a} constantly. This is ${t}.`,
      (t, a) => `An old favourite, dusted off. ${t}. ${a}.`,
      (t, a) => `Taking you back for a second. ${a}, with ${t}.`] },
    deep: { title: "DEEP CUTS", lines: [
      (t, a) => `You clearly love ${a}, so here's one you haven't saved yet. It's called ${t}.`,
      (t, a) => `Let's dig a little deeper into ${a}. Trust me on this one. ${t}.`,
      (t, a) => `More ${a}, but maybe not the one you'd expect. ${t}.`,
      (t, a) => `If you like ${a}, and you do, you need to hear ${t}.`] },
    rediscover: { title: "REDISCOVER", lines: [
      (t, a) => `From your Liked Songs, one you haven't played in a while. ${t}, by ${a}.`,
      (t, a) => `You liked this one ages ago, and then kind of forgot about it. ${t}. ${a}.`,
      (t, a) => `Pulling this one back out of your library. Here's ${t}.`,
      (t, a) => `Hey, remember saving this? ${a}, ${t}.`] },
    // These two come from Last.fm, so they know your whole history.
    forgotten: { title: "FORGOTTEN FAVOURITES", lines: [
      (t, a, n) => `You've played ${t} ${n} times. Then, a few months ago, you just stopped. Let's fix that.`,
      (t, a, n) => `Here's one you used to wear out. ${n} plays of ${t}, and none lately. ${a}.`,
      (t, a, n) => `Your Last.fm says you've heard this ${n} times, but not once in the last three months. ${t}, by ${a}.`,
      (t, a) => `An old favourite you've drifted away from. ${a}, ${t}. Welcome back.`] },
    yearago: { title: "ONE YEAR AGO", lines: [
      (t, a, n) => `This week last year, you played ${t} ${n > 1 ? n + " times" : "on repeat"}. Here it is again.`,
      (t, a) => `Let's go back exactly one year. This is what you had on. ${t}, by ${a}.`,
      (t, a) => `A year ago, right about now, this was your song. ${a}, ${t}.`,
      (t, a) => `Time travel for a second. One year ago this week: ${t}.`] },
  },
  /** Extra lines that mention your play count, used when Last.fm knows it. */
  COUNT_LINES: {
    repeat: [(t, a, n) => `${n} plays and counting. You really can't get enough of ${t}, can you? ${a}.`],
    throwback: [(t, a, n) => `Throwback. You've played ${t} ${n} times over the years. ${a}.`],
    rediscover: [(t, a, n) => `You've played this ${n} times, and it's still in your Liked Songs. ${t}, ${a}.`],
  },
  /** The DJ's line for the first song of a segment. */
  line(type, t) {
    const title = cleanTitle(t.name), artist = (t.artists && t.artists[0] && t.artists[0].name) || "this artist";
    const n = t.plays || PlayCounts.of(t);
    let lines = this.SEG[type].lines;
    if (type === "forgotten" || type === "yearago") lines = lines.filter((f) => f.length < 3 || n > 1);
    else if (n >= 10 && this.COUNT_LINES[type] && Math.random() < 0.5) lines = this.COUNT_LINES[type];
    return pick(lines)(title, artist, n ? n.toLocaleString() : n);
  },
  /** Last.fm pools: songs you played a lot but not lately, and what you played a year ago this week. */
  async lastfmPools() {
    const out = { forgotten: [], yearAgo: [] };
    if (!LFM.ready()) return out;
    try {
      const keyOf = (x) => LFM.key((x.artist && (x.artist.name || x.artist["#text"])) || "", x.name);
      const [all, lately] = await Promise.all([
        LFM.get("user.getTopTracks", { period: "overall", limit: 200 }, 3600000),
        LFM.get("user.getTopTracks", { period: "3month", limit: 500 }, 3600000),
      ]);
      const recent = new Set(LFM.arr(lately && lately.toptracks && lately.toptracks.track).map(keyOf));
      const forgotten = LFM.arr(all && all.toptracks && all.toptracks.track).filter((x) => +x.playcount >= 8 && !recent.has(keyOf(x)));
      out.forgotten = await this.resolveSome(shuffle(forgotten.slice(0, 60)), 6);
      const mid = Date.now() / 1000 - 365 * 86400, counts = new Map();
      for (let page = 1; page <= 2; page++) {
        const b = await LFM.get("user.getRecentTracks", { from: Math.floor(mid - 3.5 * 86400), to: Math.floor(mid + 3.5 * 86400), limit: 200, page }, 3600000);
        const list = LFM.arr(b && b.recenttracks && b.recenttracks.track);
        list.forEach((x) => {
          if (!x.date) return;
          const artist = (x.artist && (x.artist["#text"] || x.artist.name)) || "", k = LFM.key(artist, x.name);
          const c = counts.get(k) || { name: x.name, artist: { name: artist }, playcount: 0 };
          c.playcount++; counts.set(k, c);
        });
        if (list.length < 200) break;
      }
      out.yearAgo = await this.resolveSome([...counts.values()].sort((a, b) => b.playcount - a.playcount).slice(0, 12), 5);
    } catch (e) { console.error(e); }
    return out;
  },
  async resolveSome(list, n) {
    const got = [];
    for (const x of list) {
      if (got.length >= n) break;
      const sp = await Resolve.track(x.name, x.artist && (x.artist.name || x.artist["#text"]));
      if (sp && !got.some((g) => g.uri === sp.uri)) got.push({ ...sp, plays: +x.playcount || 0 });
    }
    return got;
  },
  greeting() {
    const hr = new Date().getHours();
    const part = hr < 5 ? "Up late" : hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : hr < 22 ? "Good evening" : "Late night";
    const name = S.me && S.me.display_name ? S.me.display_name.split(" ")[0] : "";
    return `${part}${name ? ", " + name : ""}. This is your DJ on Cadenza.`;
  },
  async build() {
    await loadMe();
    const [recentRaw, short, long, artists, likedRaw] = await Promise.all([
      pagesOf("/me/player/recently-played?limit=50", 50),
      pagesOf("/me/top/tracks?time_range=short_term&limit=50", 50),
      pagesOf("/me/top/tracks?time_range=long_term&limit=50", 50),
      pagesOf("/me/top/artists?time_range=medium_term&limit=20", 20),
      pagesOf("/me/tracks?limit=50", 200),
    ]);
    const ok = (t) => t && t.uri && t.name && !t.is_local;
    const recent = recentRaw.map((x) => x.track).filter(ok);
    const liked = likedRaw.map((x) => x.track).filter(ok);
    const recentSet = new Set(recent.slice(0, 20).map((t) => t.uri));
    const shortSet = new Set(short.map((t) => t.uri));
    const known = new Set([...liked, ...short, ...long].map((t) => t.uri));
    const used = new Set();
    const take = (pool, n) => {
      const out = [];
      for (const t of shuffle(pool)) {
        if (out.length >= n) break;
        if (!ok(t) || used.has(t.uri) || recentSet.has(t.uri)) continue;
        used.add(t.uri); out.push(t);
      }
      return out;
    };
    // Deep cuts: songs by your top artists that aren't in your library yet.
    const deepPools = [];
    for (const a of shuffle(artists).slice(0, 3)) {
      const r = await api("GET", `/search?type=track&limit=10&q=${enc('artist:"' + a.name + '"')}`);
      const tracks = ((r.body && r.body.tracks && r.body.tracks.items) || []).filter((t) => ok(t) && !known.has(t.uri)
        && (t.artists || []).some((x) => x.id === a.id));
      if (tracks.length) deepPools.push({ artist: a.name, tracks });
    }
    const lfm = await this.lastfmPools();
    const plan = [
      ["repeat", short],
      ["throwback", long.filter((t) => !shortSet.has(t.uri))],
      ["forgotten", lfm.forgotten],
      ["deep", deepPools[0]],
      ["rediscover", liked.filter((t) => !shortSet.has(t.uri))],
      ["yearago", lfm.yearAgo],
      ["repeat", short],
      ["deep", deepPools[1]],
      ["throwback", long.filter((t) => !shortSet.has(t.uri))],
      ["deep", deepPools[2]],
      ["rediscover", liked.filter((t) => !shortSet.has(t.uri))],
    ];
    const segments = [];
    for (const [type, src] of plan) {
      const pool = src && src.tracks ? src.tracks : src;
      if (!pool || !pool.length) continue;
      const tracks = take(pool, 4);
      if (tracks.length < 2) continue;
      segments.push({ type, title: type === "deep" && src.artist ? "MORE " + upper(src.artist) : this.SEG[type].title, tracks });
    }
    if (!segments.length && liked.length) segments.push({ type: "rediscover", title: "REDISCOVER", tracks: take(liked, 12) });
    return segments;
  },
  async start() {
    if (this.building) return;
    this.building = true;
    this.say("Give me a second, I'm pulling together a set for you…", false);
    views.dj.render();
    let segments = [];
    try { segments = await this.build(); } catch (e) { console.error(e); }
    this.building = false;
    if (!segments.length) {
      this.say("I couldn't find enough of your listening history yet. Play some music, then try me again.", false);
      return views.dj.render();
    }
    this.segments = segments;
    this.announced = new Set();
    const uris = segments.flatMap((s) => s.tracks.map((t) => t.uri)).slice(0, 100);
    this.order = uris; this.at = 0; this.curUri = null; this.stall = 0;
    this.pendingIntro = true;
    const played = await playBody({ uris }, null, true);
    this.active = played;
    clearInterval(this.timer);
    if (played) this.timer = setInterval(() => this.watch(), 1000);
    views.home.update();
    views.dj.render();
    if (played) toast("DJ ON AIR");
  },
  /** Where a song sits in the set. Spotify sometimes reports a different copy of the same song
   *  (another release of it), so fall back to matching the title. */
  indexOf(uri) {
    let i = (this.order || []).indexOf(uri);
    if (i >= 0) return i;
    const it = S.player && S.player.item, name = it && it.uri === uri ? cleanTitle(it.name).toLowerCase() : "";
    if (!name) return -1;
    const all = this.segments.flatMap((s) => s.tracks);
    const t = all.find((x) => cleanTitle(x.name).toLowerCase() === name);
    return t ? this.order.indexOf(t.uri) : -1;
  },
  /** The set is played as a list of songs, and Spotify (or librespot) sometimes just stops at the end of
   *  one instead of moving on. Once a second: if a song has ended and nothing new has started a few
   *  seconds later, start the rest of the set from the next song. */
  watch() {
    if (!this.active || this.advancing) return;
    const p = S.player, it = p && p.item;
    if (!it) return;
    if (it.uri !== this.curUri) { this.curUri = it.uri; this.stall = 0; const i = this.indexOf(it.uri); if (i >= 0) this.at = i; }
    const dur = it.duration_ms || 0, pos = progressNow();
    const stopped = !p.is_playing;
    const ended = dur > 1000 && (pos >= dur - 400 || (stopped && pos >= dur - 2500));
    if (!ended) { this.stall = 0; return; }
    if (!this.stall) this.stall = Date.now();
    if (Date.now() - this.stall > 3500) this.advance();
  },
  async advance() {
    this.advancing = true; this.stall = 0;
    const rest = (this.order || []).slice(this.at + 1);
    if (!rest.length) {
      this.say("And that's the set. Ask me for another one anytime.", true);
      this.interrupt();
    } else {
      this.at += 1;
      await playBody({ uris: rest.slice(0, 100) }, null, true);
    }
    this.advancing = false;
  },
  interrupt() {
    clearInterval(this.timer);
    if (!this.active) return;
    this.active = false;
    native("speak.stop").catch(() => {});
    views.home.update();
    if (current() && current().name === "dj") views.dj.render();
  },
  stop() { this.interrupt(); this.say("DJ off. Come back anytime.", false); views.dj.render(); },
  /** Called whenever the playing track changes. */
  onTrack(uri, fromUpNext) {
    if (!this.active || !uri) return;
    if (fromUpNext) return;                              // a song from your Up Next: the set carries on after it
    const seg = this.segments.find((s) => s.tracks[0].uri === uri);
    if (seg && !this.announced.has(seg)) {
      this.announced.add(seg);
      const t = seg.tracks[0];
      let line = this.line(seg.type, t);
      if (this.pendingIntro) { line = this.greeting() + " " + line; this.pendingIntro = false; }
      this.say(line, true);
    } else if (this.indexOf(uri) < 0) {
      this.interrupt();                                // you played something else
    }
    if (current() && current().name === "dj") views.dj.render();
  },
  async say(line, speak) {
    this.lastLine = line;
    views.dj.caption(line);
    if (!speak || !S.settings.djVoice || this.talking) return;
    this.talking = true;
    const vol = S.player && S.player.volume;
    // Through Cadenza's own sound engine the voice already dips the music itself; only duck Spotify's
    // volume when the music is playing somewhere else (saves two requests every time the DJ talks).
    const viaEngine = Local.active() && (!EQ.state || EQ.state.engine !== false);
    const duck = !viaEngine && vol != null && vol > 12;
    try {
      if (duck) await api("PUT", `/me/player/volume?volume_percent=${Math.round(vol * 0.3)}`);
      await native("speak", { text: line });
    } catch (e) { /* ignore */ }
    if (duck) await api("PUT", `/me/player/volume?volume_percent=${vol}`);
    this.talking = false;
  },
};

/* =====================================================================
   HOME
   ===================================================================== */
// Playback controls (play/pause, next, previous, shuffle, repeat) live in the toolbar under Now Playing.
const HOME_ITEMS = ["dj", "lyrics", "library", "search", "queue", "stats", "eq", "system"];   // Devices lives in System

/** Toolbar under Now Playing: shuffle · previous · play/pause · next · repeat. */
const Controls = {
  el: $("np-ctrl"),
  init() {
    this.btn = {};
    this.el.querySelectorAll("button").forEach((b) => {
      this.btn[b.dataset.c] = b;
      b.onclick = () => { pop(b); cmd(b.dataset.c).then(() => this.render()); };
    });
    setChip(this.btn.shuffle, "shuffle");
    setChip(this.btn.previous, "prev");
    setChip(this.btn.next, "next");
    setChip(this.btn.repeat, "repeat");
    this.btn.repeat.append(h("i", "one", "1"));
    this.playing = null;
    this.render();
  },
  render() {
    if (!this.btn) return;
    const p = S.player, playing = !!(p && p.is_playing);
    if (playing !== this.playing) { this.playing = playing; setChip(this.btn.toggle, playing ? "pause" : "play"); }
    this.btn.shuffle.classList.toggle("on", !!(p && p.shuffle_state));
    const rep = (p && p.repeat_state) || "off";
    this.btn.repeat.classList.toggle("on", rep !== "off");
    this.btn.repeat.classList.toggle("track", rep === "track");
    const ts = "Shuffle: " + (p && p.shuffle_state ? "on" : "off") + " (⌘S)";
    const tr = "Repeat: " + (rep === "track" ? "this song" : rep === "context" ? "all" : "off") + " (⌘R)";
    if (this.btn.shuffle.title !== ts) this.btn.shuffle.title = ts;          // only touch the page when it changed
    if (this.btn.repeat.title !== tr) this.btn.repeat.title = tr;
  },
};
views.home = {
  el: $("v-home"), sel: 0, items: [], pos: [], hint: "",
  keys: () => [["↑↓", "SELECT"], ["⏎", "CONFIRM"], ["SPACE", "PLAY/PAUSE", () => cmd("toggle")], ["/", "SEARCH", () => go("search")]],
  describe(id) {
    const p = S.player, playing = !!(p && p.is_playing);
    switch (id) {
      case "toggle": return { label: playing ? "Pause" : "Resume", hint: playing ? "Pause the current track." : "Continue where you left off." };
      case "next": return { label: "Next", hint: "Skip to the next track." };
      case "previous": return { label: "Previous", hint: "Go back to the previous track." };
      case "shuffle": return { label: "Shuffle", tag: p && p.shuffle_state ? "ON" : "OFF", hint: "Toggle shuffle for this queue." };
      case "repeat": return { label: "Repeat", tag: !p || p.repeat_state === "off" ? "OFF" : p.repeat_state === "track" ? "ONE" : "ALL", hint: "Cycle repeat: off → all → one." };
      case "library": return { label: "Library", hint: "Your playlists and Liked Songs." };
      case "search": return { label: "Search", hint: "Find new songs to play or add to a playlist." };
      case "queue": return { label: "Queue", hint: "See what's coming up next." };
      case "output": return { label: "Devices", hint: "Speakers, AirPods, Bluetooth, and Spotify Connect devices." };
      case "stats": return { label: "Stats", hint: "Your top artists and songs, and when you listen. Import your Spotify history for every play." };
      case "lyrics": return { label: "Lyrics", hint: "Sing along: lyrics that follow the song." };
      case "system": return { label: "System", hint: "Account, audio engine and app settings." };
      case "eq": return { label: "EQ", tag: EQ.state && EQ.state.enabled && EQ.state.engine !== false ? (EQ.state.preset || "").toUpperCase() : "OFF", hint: "Shape the sound: ten bands, presets and a volume boost." };
      case "dj": return { label: "DJ", tag: DJ.active ? "ON AIR" : "", hint: "A DJ that builds sets from what you love and talks you through them." };
    }
  },
  build() {
    const menu = $("menu");
    HOME_ITEMS.forEach((id, i) => {
      const el = h("div", "item st");
      el.style.marginLeft = (i * 2.6) + "vw";
      const inn = h("div", "in");
      inn.append(h("span", "label"), h("span", "tag"));
      el.append(inn);
      el.onmouseenter = () => { if (!busy) this.select(i); };
      el.onclick = () => { if (!busy) { this.select(i); this.activate(); } };
      menu.append(el);
      this.items.push(el);
    });
    this.update();
  },
  update() {
    Controls.render();
    HOME_ITEMS.forEach((id, i) => {
      const d = this.describe(id), el = this.items[i];
      if (!el) return;
      const label = el.querySelector(".label"), tag = el.querySelector(".tag");
      Theme.text(label, d.label, "menu", { active: i === this.sel, index: i, id, hint: d.hint });
      const t = d.tag || "";
      if (tag.textContent !== t) tag.textContent = t;
      tag.classList.toggle("off", t === "OFF");
    });
    this.setHint(this.describe(HOME_ITEMS[this.sel]).hint);
    this.intel();
  },
  /** The info card beside the menu: a live peek at whatever's selected. Uses only what Cadenza already knows (no extra Spotify calls). */
  intel() {
    const id = HOME_ITEMS[this.sel], p = S.player, it = p && p.item;
    const rows = [], covers = [];
    let head = "", go = "OPEN";
    switch (id) {
      case "dj":
        head = DJ.active ? "ON AIR" : "OFF AIR"; go = DJ.active ? "TUNE IN" : "START A SET";
        rows.push(DJ.lastLine || "Sets built from your top tracks, recent plays and Liked Songs, with spoken intros.");
        break;
      case "lyrics":
        head = it ? it.name : "NOTHING PLAYING"; go = "SING ALONG";
        if (it) rows.push(it.artists, "Synced lyrics that follow the song");
        else rows.push("Play something and the words will follow along.");
        break;
      case "library": {
        const pls = S.playlists || [];
        head = pls.length ? pls.length + " PLAYLISTS" : "YOUR LIBRARY";
        pls.filter((x) => x.images && x.images.length).slice(0, 4).forEach((x) => covers.push(pickImage(x.images)));
        rows.push(S.likedTotal != null ? `Liked Songs · ${S.likedTotal} tracks` : "Liked Songs and every playlist you own or follow");
        break;
      }
      case "search":
        head = "FIND ANYTHING"; go = "SEARCH";
        rows.push("Songs · Albums · Artists · Playlists", "Press / from anywhere");
        break;
      case "queue": {
        head = "UP NEXT"; go = "SEE THE QUEUE";
        const q = (views.queue.list.items || []).slice(0, 3);
        if (q.length) q.forEach((t, k) => rows.push(`${k + 1}. ${t.name}`));
        else rows.push("See what's coming up, and play any of it now.");
        break;
      }
      case "stats": {
        const st = views.stats;
        head = st.spotPlays ? st.spotPlays.toLocaleString() + " PLAYS" : LFM.ready() ? "LAST.FM · " + upper(LFM.user()) : "YOUR LISTENING"; go = "SEE STATS";
        rows.push("Top artists, top songs and when you listen", st.spotPlays ? "Includes your imported Spotify history" : "Import your Spotify history from the Stats page");
        break;
      }
      case "output":
        head = (p && p.device) || "NO DEVICE"; go = "SWITCH";
        rows.push(p && p.volume != null ? `Volume ${p.volume}%` : "Speakers, AirPods and Bluetooth", "Spotify Connect: phone, TV, speakers");
        break;
      case "eq": {
        const st = EQ.state || {};
        head = st.engine === false ? "ENGINE OFF" : st.enabled ? (st.preset || "Custom") : "EQ OFF"; go = "TUNE";
        rows.push(st.preamp ? `Boost ${st.preamp > 0 ? "+" : ""}${st.preamp} dB` : "Ten bands, 32 Hz to 16 kHz", "Presets: Bass Boost, Vocal, Loudness…");
        break;
      }
      case "system":
        head = Theme.meta(Theme.current ? Theme.current.id : S.settings.theme).name; go = "SETTINGS";
        rows.push(S.me ? "Signed in as " + S.me.display_name : "Account and audio engine", "⌘T switches theme");
        break;
    }
    const sig = [id, head, rows.join("|"), covers.join("|")].join("#");
    if (sig === this.intelSig) return;
    const changed = !this.intelSig || this.intelSig.split("#")[0] !== id;
    this.intelSig = sig;
    $("intel-no").textContent = String(this.sel + 1).padStart(2, "0");
    Theme.text($("intel-kick"), this.describe(id).label, "tag");
    $("intel-head").textContent = head;
    $("intel-go").textContent = go;
    const body = $("intel-body");
    body.textContent = "";
    if (covers.length) { const c = h("div", "covers"); covers.forEach((u) => { const s = h("span"); setBg(s, u); c.append(s); }); body.append(c); }
    rows.forEach((r, k) => body.append(h("div", "row" + (k ? "" : " lead"), r)));
    if (changed && !busy) {
      const m = motion();
      play($("intel"), m.intel.frames, { duration: m.intel.ms, easing: m.intel.ease || OUT, fill: "none" });
    }
  },
  measure() {
    let maxW = 0;
    this.items.forEach((el, i) => { this.pos[i] = { x: el.offsetLeft, y: el.offsetTop }; maxW = Math.max(maxW, el.offsetWidth); });
    $("hl").style.width = (maxW + innerWidth * 0.03) + "px";
  },
  moveHL(instant) {
    const hl = $("hl"), p = this.pos[this.sel];
    if (!p) return;
    if (instant) hl.classList.add("instant");
    hl.style.transform = `translate3d(${p.x - innerWidth * 0.006}px, ${p.y}px, 0)`;
    if (instant) { void hl.offsetWidth; hl.classList.remove("instant"); }
  },
  select(i, instant) {
    const moved = i !== this.sel;
    this.sel = i;
    this.items.forEach((el, k) => el.classList.toggle("active", k === i));
    this.moveHL(instant);
    if (moved && !instant) {
      const m = motion();
      play($("hl").querySelector(".face"), m.select.frames, { duration: m.select.ms, easing: m.inEase, fill: "none" });
      if (m.select.shadow) play($("hl").querySelector(".shadow"), m.select.shadow, { duration: m.select.ms + 60, easing: m.inEase, fill: "none" });
    }
    this.update();
  },
  setHint(text) {
    if (text === this.hint) return;
    this.hint = text;
    const el = $("hint-text");
    el.textContent = text;
    const m = motion();
    play(el, m.hint.frames, { duration: m.hint.ms, easing: m.hint.ease || OUT, fill: "none" });
  },
  show() { this.measure(); this.select(this.sel, true); Viz.start(); },
  leave() { Viz.stop(); },
  afterShow() {
    settle(play($("hl"), [{ opacity: 0, scale: "0 1" }, { opacity: 1, scale: "1 1" }], { duration: 260, delay: 100 + this.sel * 24, easing: SNAP }));
  },
  activate() {
    const id = HOME_ITEMS[this.sel];
    pop(this.items[this.sel]);
    if (["toggle", "next", "previous", "shuffle", "repeat"].includes(id)) return cmd(id);
    go(id);
  },
  onKey(e) {
    const n = HOME_ITEMS.length;
    // Themes that lay Home out as a grid of tiles say how many columns (arrows then move in 2D).
    const cols = (Theme.current && Theme.current.homeCols) || 1;
    if (cols > 1 && (e.key === "ArrowRight" || e.key === "ArrowLeft")) { this.select((this.sel + (e.key === "ArrowRight" ? 1 : n - 1)) % n); return true; }
    if (e.key === "ArrowDown") { this.select((this.sel + cols) % n); return true; }
    if (e.key === "ArrowUp") { this.select((this.sel + n - cols) % n); return true; }
    if (e.key === "Enter") { if (!busy) this.activate(); return true; }
    if (e.key === "Escape" || e.key === "Backspace") return true;   // already home
    return false;
  },
};

/* =====================================================================
   LIBRARY: tilted cover cards
   ===================================================================== */
views.library = {
  el: $("v-library"),
  keys: () => [["←→↑↓", "SELECT"], ["⏎", "OPEN", () => views.library.open()], ["N", "NEW", () => views.library.create()],
    ["R", "EDIT", () => views.library.rename(views.library.list.cur)], ["D", "DELETE", () => views.library.remove(views.library.list.cur)], ["ESC", "BACK", back]],
  list: new List($("lib-grid"), {
    columns: 4,
    render: (p) => {
      const c = h("div", "card st" + (p.kind === "new" ? " new" : ""));
      const inn = h("div", "in"), cov = h("div", "cover");
      if (p.kind === "liked") cov.append(likedCover());
      else if (p.kind === "new") cov.append(h("div", "new-cover", "+"));
      else {
        const url = pickImage(p.images);
        if (url) {
          const im = new Image(); im.loading = "lazy"; im.decoding = "async"; im.alt = "";
          if (!decodedImages.has(url)) { im.className = "fade"; im.onload = () => { im.classList.add("ok"); decodedImages.add(url); }; }
          im.classList.add("art-img"); im.src = url; cov.append(im);
        }
      }
      const cap = h("div", "cap");
      const n = p.kind === "liked" ? S.likedTotal : plCount(p);
      cap.append(h("span", "n", p.name), h("span", "c", p.kind === "new" ? "CREATE" : n != null ? n + " TRACKS" : "PLAYLIST"));
      if (p.kind !== "new") { const tg = h("div", "tags"); Tags.render(tg, p); cap.append(tg); c.dataset.key = Tags.key(p); }
      inn.append(cov, cap); c.append(inn);
      return c;
    },
    onActivate: () => views.library.open(),
  }),
  filled: false,
  show(params, isBack) {
    if (isBack && this.filled) return;
    if (S.playlists) this.fill();
    else { $("lib-count").textContent = "LOADING…"; this.list.set([]); }
    loadPlaylists().then(settled).then(() => {
      if (current() && current().name === "library" && !this.filled) { this.fill(); revealRows(this.list.el); }
    });
  },
  fill(keep) {
    this.filled = true;
    const i = keep != null ? keep : 0;
    this.list.set([{ kind: "liked", name: "Liked Songs", uri: null }, { kind: "new", name: "New Playlist" }, ...S.playlists]);
    this.list.select(Math.min(i, this.list.items.length - 1), keep != null);
    $("lib-count").textContent = S.playlists.length + " PLAYLISTS";
  },
  leave() { if (current() && current().name === "home") this.filled = false; },
  open() {
    const p = this.list.cur;
    if (!p || busy) return;
    if (p.kind === "new") return this.create();
    go("playlist", { pl: p });
  },
  async create() {
    const name = await Modal.open({ title: "NEW PLAYLIST", text: "Give it a name.", input: "", ok: "CREATE" });
    if (!name) return;
    const pl = await createPlaylist(name);
    if (!pl) return;
    this.fill(2);
    revealRows(this.list.el);
  },
  async rename(p) {
    if (!p || p.kind) return toast("THAT ONE CAN'T BE EDITED", true);
    if (!isOwned(p)) return toast("YOU CAN ONLY EDIT YOUR OWN PLAYLISTS", true);
    if (await editPlaylist(p)) this.fill(this.list.i);
  },
  async remove(p) {
    if (!p || p.kind) return toast("THAT ONE CAN'T BE DELETED", true);
    const owned = isOwned(p) && !p.collaborative;
    const yes = await Modal.open({
      title: owned ? "DELETE PLAYLIST?" : "REMOVE FROM LIBRARY?",
      text: "\u201c" + p.name + "\u201d" + (owned ? " will be deleted. You can recover it at spotify.com/account for 90 days." : " will be removed from your library."),
      ok: owned ? "DELETE" : "REMOVE", danger: true,
    });
    if (!yes) return;
    if (await deletePlaylist(p)) this.fill(Math.max(0, this.list.i - 1));
  },
  onKey(e) {
    if (this.list.nav(e)) return true;
    const k = e.key.toLowerCase();
    if (e.key === "Enter") { pop(this.list.rows[this.list.i]); this.open(); return true; }
    if (k === "n") { this.create(); return true; }
    if (k === "r") { this.rename(this.list.cur); return true; }
    if (k === "d") { this.remove(this.list.cur); return true; }
    return false;
  },
};

/* =====================================================================
   PLAYLIST: hero header + scrolling track table
   ===================================================================== */
views.playlist = {
  el: $("v-playlist"), pl: null, next: null, loading: false,
  keys: () => [["↑↓", "SELECT"], ["⏎", "PLAY"], ["M", "MORE"], ["⌥↑↓", "MOVE"], ["X", "REMOVE"], ["P", "PLAY ALL", () => views.playlist.playAll(false)], ["ESC", "BACK", back]],
  list: new List($("pl-tracks"), {
    render: (t, i) => { const r = renderTrack(t, i); if (views.playlist.canReorder()) r.draggable = true; return r; },
    onActivate: (t, i, act) => views.playlist.act(act || "play", t, i),
    onNearEnd: () => views.playlist.more(),
  }),
  show(params, isBack) {
    if (isBack && this.pl === params.pl) return;
    this.open(params.pl);
  },
  open(pl) {
    this.pl = pl; this.next = null; this.loading = false;
    const liked = pl.kind === "liked";
    $("pl-kind").textContent = liked ? "COLLECTION" : pl.collaborative ? "SHARED PLAYLIST" : "PLAYLIST";
    $("pl-name").textContent = pl.name;
    const count = liked ? S.likedTotal : plCount(pl);
    const owner = liked ? (S.me && S.me.display_name) || "You" : (pl.owner && (pl.owner.display_name || pl.owner.id)) || "";
    $("pl-info").textContent = [upper(owner), count != null ? count + " TRACKS" : ""].filter(Boolean).join("  ·  ");
    const cover = $("pl-cover");
    cover.querySelectorAll(".liked-cover").forEach((n) => n.remove());
    if (liked) { setBg(cover, null); cover.append(likedCover()); }       // the theme's own Liked Songs cover
    else setBg(cover, pickImage(pl.images, true));
    $("pl-notice").hidden = true;
    $("pl-rename").hidden = $("pl-delete").hidden = !!pl.kind || !isOwned(pl);
    $("pl-share").hidden = !pl.uri;
    Tags.render($("pl-tags"), pl);
    this.list.set([]);
    this.load(true);
  },
  async load(first) {
    if (this.loading) return;
    const pl = this.pl, liked = pl.kind === "liked";
    const path = first ? (liked ? "/me/tracks?limit=50" : `/playlists/${pl.id}/items?limit=100`) : this.next;
    if (!path) return;
    this.loading = true;
    const stamp = liked ? S.likedTotal : pl.snapshot_id;
    const hit = first ? PageCache.get(path, stamp) : null;   // seen recently: show it as part of the slide
    const r = hit || await api("GET", path);
    if (!hit) {
      if (first && r.status === 200 && r.body) PageCache.put(path, r, stamp);
      await settled();
    }
    this.loading = false;
    if (pl !== this.pl) return;
    if (r.status !== 200 || !r.body) { if (first) this.notice(r.status); return; }
    // Remember each song's real place in the playlist (removed/unavailable entries are skipped here,
    // but still count in Spotify's numbering), so "play from this song" starts at the right spot.
    const base = r.body.offset || 0;
    const tracks = (r.body.items || []).map((e, k) => { const t = e && (e.item || e.track); if (t) t._pos = base + k; return t; })
      .filter((t) => t && t.uri && t.name);
    this.next = relPath(r.body.next);
    const wasEmpty = !this.list.items.length;
    this.list.add(tracks);
    if (wasEmpty) { this.list.select(0, false); revealRows(this.list.el); }
    if (first && r.body.total != null) {
      const parts = $("pl-info").textContent.split("  ·  ");
      $("pl-info").textContent = [parts[0], r.body.total + " TRACKS"].filter(Boolean).join("  ·  ");
    }
    this.markPlaying();
    if (first && !tracks.length) this.notice(0, true);
  },
  more() { if (this.next && !this.loading) this.load(false); },
  notice(status, empty) {
    const n = $("pl-notice");
    n.hidden = false;
    n.textContent = "";
    if (empty) n.append("This playlist is empty. Find songs in ", h("b", null, "Search"), " and add them with A.");
    else if (status === 403 || status === 404) n.append("Spotify only shares the track list of playlists ", h("b", null, "you own or collaborate on"), ". You can still play this one: press ", h("b", null, "P"), ".");
    else n.append("Couldn't load the tracks (" + errMsg({ status, body: null }) + ").");
  },
  markPlaying() {
    const uri = S.player && S.player.item && S.player.item.uri;
    this.list.rows.forEach((r, i) => r.classList.toggle("playing", this.list.items[i].uri === uri));
  },
  /** What to ask Spotify to play. Always the playlist itself as the "context", so after the song you
   *  picked it carries on through the playlist instead of drifting into Spotify's autoplay. */
  bodyFor(i, shuffle) {
    const pl = this.pl, items = this.list.items, t = i != null ? items[i] : null;
    if (pl.kind !== "liked" && pl.uri) {
      const body = { context_uri: pl.uri };
      // By position, not by song ID: Spotify sometimes swaps in a regional copy of a song with a
      // different ID, and then an ID offset isn't found and playback falls out of the playlist.
      if (t) body.offset = t._pos != null ? { position: t._pos } : { uri: t.uri };
      return body;
    }
    if (pl.kind === "liked" && S.me && S.me.id) {
      // Liked Songs as a context too, so it keeps going through all of them, including the ones not loaded yet.
      const body = { context_uri: `spotify:user:${S.me.id}:collection` };
      if (t) body.offset = { uri: t.uri };
      body.fallback = this.urisFor(i, shuffle);
      return body;
    }
    return this.urisFor(i, shuffle);
  },
  urisFor(i, shuffle) {
    const items = this.list.items;
    let uris = items.filter((t) => !t.is_local).map((t) => t.uri);
    const start = i != null ? Math.max(0, uris.indexOf(items[i].uri)) : 0;
    uris = uris.slice(start, start + 100);
    if (shuffle) uris.sort(() => Math.random() - 0.5);
    return { uris };
  },
  // Shuffle: start on a random song, then switch Spotify's shuffle on once the playlist is playing
  // (turned on before the new playlist starts, it doesn't stick and the playlist plays from song 1).
  // Play All turns shuffle off so the playlist plays in order.
  async playAll(shuffle) {
    if (shuffle && TrueShuffle.enabled() && await TrueShuffle.start(this.pl)) return;   // a true shuffle; else Spotify's
    const pl = this.pl, body = this.bodyFor(null, shuffle);
    const total = body.context_uri ? (plCount(pl) || this.list.items.length) : 0;
    if (shuffle && body.context_uri && total > 1) body.offset = { position: Math.floor(Math.random() * total) };
    if (!(await playBody(body, (shuffle ? "SHUFFLING " : "") + pl.name))) return;
    for (let n = 0; n < 4; n++) {                     // the new playlist takes a moment to become active
      await wait(n ? 700 : 450);
      const r = await api("PUT", `/me/player/shuffle?state=${!!shuffle}`);
      if (r.status < 300) { if (S.player) S.player.shuffle_state = !!shuffle; views.home.update(); return; }
    }
  },
  act(kind, t, i) {
    if (!t) return;
    if (kind === "queue") return queueTrack(t);
    if (kind === "add") return Drawer.show(t);
    if (t.is_local) return toast("LOCAL FILES CAN'T BE PLAYED HERE", true);
    playBody(this.bodyFor(i, false), t.name);
  },
  onKey(e) {
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { this.move(this.list.i, this.list.i + (e.key === "ArrowUp" ? -1 : 1)); return true; }
    if (this.list.nav(e)) return true;
    const k = e.key.toLowerCase();
    if (e.key === "Enter") { pop(this.list.rows[this.list.i]); this.act("play", this.list.cur, this.list.i); return true; }
    if (k === "q") { this.act("queue", this.list.cur); return true; }
    if (k === "a") { this.act("add", this.list.cur); return true; }
    if (k === "p") { this.playAll(false); return true; }
    if (k === "s") { this.playAll(true); return true; }
    if (k === "x") { this.removeTrack(this.list.cur, this.list.i); return true; }
    if (e.altKey && e.key === "ArrowUp") { this.move(this.list.i, this.list.i - 1); return true; }
    if (e.altKey && e.key === "ArrowDown") { this.move(this.list.i, this.list.i + 1); return true; }
    if (k === "r") { this.rename(); return true; }
    if (k === "d") { this.deleteMe(); return true; }
    if (k === "t") { PlaylistTools.open(this.pl); return true; }
    return false;
  },
  editable() { const pl = this.pl; return pl && (pl.kind === "liked" || isOwned(pl)); },
  async removeTrack(t, i) {
    if (!t) return;
    const pl = this.pl, liked = pl.kind === "liked";
    if (!this.editable()) return toast("YOU CAN ONLY EDIT YOUR OWN PLAYLISTS", true);
    const r = liked
      ? await api("DELETE", `/me/library?uris=${enc(t.uri)}`)
      : await api("DELETE", `/playlists/${pl.id}/items`, { items: [{ uri: t.uri }] });
    if (r.status >= 300) return toast(errMsg(r), true);
    toast("REMOVED " + upper(t.name));
    const items = this.list.items.filter((_, k) => k !== i);
    this.list.set(items);
    this.list.select(Math.min(i, items.length - 1), true);
    this.markPlaying();
    if (liked && S.likedTotal) S.likedTotal--;
    else if (pl.items && pl.items.total) pl.items.total--;
    else if (pl.tracks && pl.tracks.total) pl.tracks.total--;
  },
  async rename() {
    const pl = this.pl;
    if (!pl || pl.kind || !isOwned(pl)) return toast("YOU CAN ONLY EDIT YOUR OWN PLAYLISTS", true);
    if (await editPlaylist(pl)) { $("pl-name").textContent = pl.name; views.library.filled = false; }
  },
  canReorder() { const pl = this.pl; return !!(pl && !pl.kind && isOwned(pl)); },
  /** Move a song from one position to another (keyboard ⌥↑/⌥↓ or drag and drop). */
  async move(from, to) {
    const items = this.list.items;
    if (!this.canReorder()) return toast("YOU CAN ONLY REORDER YOUR OWN PLAYLISTS", true);
    if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return;
    const next = items.slice();
    const [t] = next.splice(from, 1);
    next.splice(to, 0, t);
    const top = this.list.el.scrollTop;
    this.list.set(next);
    this.list.el.scrollTop = top;
    this.list.select(to, true);
    this.markPlaying();
    const r = await api("PUT", `/playlists/${this.pl.id}/items`, { range_start: from, insert_before: to > from ? to + 1 : to });
    if (r.status >= 300) { toast(errMsg(r), true); this.list.set(items); this.list.el.scrollTop = top; this.list.select(from, false); return; }
    if (r.body && r.body.snapshot_id) this.pl.snapshot_id = r.body.snapshot_id;
  },
  async deleteMe() {
    const pl = this.pl;
    if (!pl || pl.kind) return toast("THAT ONE CAN'T BE DELETED", true);
    const owned = isOwned(pl) && !pl.collaborative;
    const yes = await Modal.open({ title: owned ? "DELETE PLAYLIST?" : "REMOVE FROM LIBRARY?",
      text: "\u201c" + pl.name + "\u201d" + (owned ? " will be deleted. You can recover it at spotify.com/account for 90 days." : " will be removed from your library."),
      ok: owned ? "DELETE" : "REMOVE", danger: true });
    if (yes && await deletePlaylist(pl)) { views.library.filled = false; back(); }
  },
};
$("pl-play").onclick = () => views.playlist.playAll(false);
$("pl-rename").onclick = () => views.playlist.rename();
$("pl-share").onclick = () => views.playlist.pl && copyLink(views.playlist.pl.uri, views.playlist.pl.name);
$("pl-tools").onclick = () => PlaylistTools.open(views.playlist.pl);
// drag and drop to reorder
(() => {
  const el = $("pl-tracks");
  let from = -1;
  el.addEventListener("dragstart", (e) => { const r = e.target.closest("[data-i]"); from = r ? +r.dataset.i : -1; if (r) { r.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; } });
  el.addEventListener("dragover", (e) => { if (from < 0) return; e.preventDefault(); const r = e.target.closest("[data-i]"); el.querySelectorAll(".drop").forEach((x) => x !== r && x.classList.remove("drop")); if (r) r.classList.add("drop"); });
  el.addEventListener("dragend", () => { el.querySelectorAll(".dragging,.drop").forEach((x) => x.classList.remove("dragging", "drop")); from = -1; });
  el.addEventListener("drop", (e) => { e.preventDefault(); const r = e.target.closest("[data-i]"); if (r && from >= 0) views.playlist.move(from, +r.dataset.i); from = -1; });
})();
$("pl-delete").onclick = () => views.playlist.deleteMe();
$("pl-shuffle").onclick = () => views.playlist.playAll(true);

/* =====================================================================
   SEARCH: big input bar + results
   ===================================================================== */
views.search = {
  el: $("v-search"), input: $("q"), q: "", total: 0, timer: null, loadingMore: false, type: "track",
  keys: () => [["TYPE", views.search.type === "lyrics" ? "A LINE YOU REMEMBER" : "SEARCH"], ["TAB", "SONGS/ALBUMS/ARTISTS/PLAYLISTS/LYRICS", () => views.search.cycle(1)], ["↓", "RESULTS"], ["⏎", "OPEN"], ["Q", "UP NEXT"], ["A", "ADD"], ["ESC", "BACK", back]],
  list: new List($("search-results"), {
    render: (t, i) => views.search.type === "track" || views.search.type === "lyrics" ? renderTrack(t, i, { thumb: true }) : renderMedia(t, views.search.type),
    onActivate: (t, i, act) => views.search.act(act || "play", t, i),
    onNearEnd: () => views.search.more(),
  }),
  show(params, isBack) {
    if (!isBack) setTimeout(() => this.input.focus(), 60);
  },
  leave() { this.input.blur(); clearTimeout(this.timer); },
  schedule() {
    clearTimeout(this.timer);
    // Lyrics search costs a Genius lookup plus a few Spotify searches: wait until you pause typing.
    this.timer = setTimeout(() => this.run(this.input.value), this.type === "lyrics" ? 700 : 280);
  },
  async run(q) {
    clearTimeout(this.timer);
    q = q.trim();
    if (q === this.q) return;
    this.q = q;
    const empty = $("search-empty");
    if (!q) { this.list.set([]); empty.hidden = false; empty.textContent = "TYPE TO SEARCH"; return; }
    const type = this.type;
    if (type === "lyrics") return this.runLyrics(q);
    const r = await api("GET", `/search?type=${type}&limit=10&q=${enc(q)}`);
    if (this.q !== q || this.type !== type) return;
    const res = r.body && r.body[type + "s"];
    const items = (res && res.items || []).filter(Boolean);
    this.total = (res && res.total) || 0;
    this.list.set(items);
    empty.hidden = items.length > 0;
    empty.textContent = r.status === 200 ? "NO RESULTS" : errMsg(r);
    revealRows(this.list.el);
  },
  /** Search → Lyrics: Genius finds songs containing the words; each is then looked up on Spotify. */
  async runLyrics(q) {
    const empty = $("search-empty");
    if (q.length < 6) { this.list.set([]); empty.hidden = false; empty.textContent = "TYPE A LINE FROM THE SONG"; return; }
    this.list.set([]); empty.hidden = false; empty.textContent = "LISTENING FOR THAT LINE…";
    let res = null;
    try { res = await native("genius.search", { q }); } catch (e) { res = { error: String(e) }; }
    if (this.q !== q || this.type !== "lyrics") return;
    if (!res || res.error) {
      empty.textContent = res && res.error === "no-token" ? "TO SEARCH BY LYRICS, ADD A GENIUS TOKEN IN SYSTEM → CONNECTIONS"
        : res && res.error === "bad-token" ? "GENIUS DIDN'T ACCEPT THE TOKEN · CHECK IT IN SYSTEM → CONNECTIONS"
        : "COULDN'T SEARCH LYRICS" + (res && res.error ? ": " + upper(String(res.error)) : "");
      return;
    }
    const hits = (res.hits || []).slice(0, 6);
    const norm = (x) => cleanTitle(x).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim();
    const found = await Promise.all(hits.map(async (hit) => {
      const r = await api("GET", `/search?type=track&limit=5&q=${enc(hit.title + " " + hit.artist)}`);
      const items = ((r.body && r.body.tracks && r.body.tracks.items) || []).filter(Boolean);
      // Prefer the result whose artist and title match Genius's; otherwise the top one.
      return items.find((t) => norm(t.name).includes(norm(hit.title)) && (t.artists || []).some((a) => norm(a.name) === norm(hit.artist)))
        || items.find((t) => (t.artists || []).some((a) => norm(a.name) === norm(hit.artist))) || null;
    }));
    if (this.q !== q || this.type !== "lyrics") return;
    const seen = new Set(), items = found.filter((t) => t && !seen.has(t.uri) && seen.add(t.uri));
    this.total = items.length;
    this.list.set(items);
    empty.hidden = items.length > 0;
    empty.textContent = "NO SONG FOUND WITH THAT LINE";
    revealRows(this.list.el);
  },
  async more() {
    if (this.type === "lyrics") return;
    const have = this.list.items.length;
    if (this.loadingMore || !this.q || have >= Math.min(this.total, 50)) return;
    this.loadingMore = true;
    const q = this.q;
    const type = this.type;
    const r = await api("GET", `/search?type=${type}&limit=10&offset=${have}&q=${enc(q)}`);
    this.loadingMore = false;
    if (q !== this.q || type !== this.type || r.status !== 200) return;
    this.list.add(((r.body[type + "s"] && r.body[type + "s"].items) || []).filter(Boolean));
  },
  act(kind, t, i) {
    if (!t) return;
    if (this.type === "album") return go("album", { id: t.id });
    if (this.type === "artist") return go("artist", { id: t.id });
    if (this.type === "playlist") return go("playlist", { pl: t });
    if (kind === "queue") return queueTrack(t);
    if (kind === "add") return Drawer.show(t);
    if (Radio.enabled()) return Radio.start(t);
    const uris = this.list.items.slice(i).map((x) => x.uri);
    playBody({ uris }, t.name);
  },
  setType(type) {
    if (type === this.type) return;
    this.type = type;
    $("s-tabs").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.t === type));
    const q = this.q; this.q = null;
    this.list.set([]);
    this.input.placeholder = type === "lyrics" ? "A line from the song, as you remember it…" : "Songs, artists, albums…";
    refreshKeys();
    if (q) this.run(q); else { this.q = ""; const empty = $("search-empty"); empty.hidden = false; empty.textContent = type === "lyrics" ? "TYPE A LINE FROM THE SONG" : "TYPE TO SEARCH"; }
  },
  cycle(d) { const order = ["track", "album", "artist", "playlist", "lyrics"]; this.setType(order[(order.indexOf(this.type) + d + order.length) % order.length]); },
  onKey(e, typing) {
    if (e.key === "Tab") { this.cycle(e.shiftKey ? -1 : 1); return true; }
    if (typing) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        if (e.key === "Enter") this.run(this.input.value);
        if (this.list.items.length || e.key === "Enter") { this.input.blur(); this.list.select(0); }
        return true;
      }
      if (e.key === "Escape") {
        if (this.input.value) { this.input.value = ""; this.run(""); }
        else { this.input.blur(); back(); }
        return true;
      }
      return false;
    }
    if (e.key === "ArrowUp" && this.list.i === 0) { this.input.focus(); this.input.select(); return true; }
    if (this.list.nav(e)) return true;
    const k = e.key.toLowerCase();
    if (e.key === "Enter") { pop(this.list.rows[this.list.i]); this.act("play", this.list.cur, this.list.i); return true; }
    if (k === "q" && this.list.items.length) { this.act("queue", this.list.cur); return true; }
    if (k === "a" && this.list.items.length) { this.act("add", this.list.cur); return true; }
    if (e.key.length === 1 && !e.altKey) { this.input.focus(); return false; }   // start typing anywhere
    return false;
  },
};
$("q").addEventListener("input", () => views.search.schedule());
$("s-tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) views.search.setType(b.dataset.t); });
$("q").addEventListener("focus", () => $("search-bar").classList.add("focus"));
$("q").addEventListener("blur", () => $("search-bar").classList.remove("focus"));

/* =====================================================================
   QUEUE: now card + ladder
   ===================================================================== */
views.queue = {
  el: $("v-queue"),
  keys: () => [["↑↓", "SELECT"], ["⏎", "PLAY NOW"], ["X", "REMOVE"], ["⌥↑↓", "MOVE"], ["C", "CLEAR UP NEXT", () => UpNext.clear()], ["S", "SAVE AS PLAYLIST", () => views.queue.save()], ["H", "HISTORY", () => go("history")], ["ESC", "BACK", back]],
  async save() {
    const now = S.player && S.player.item;
    const uris = [...(now && isTrack(now) ? [now.uri] : []), ...this.list.items.map((t) => t.uri)].filter((u) => /^spotify:track:/.test(u));
    if (!uris.length) return toast("THE QUEUE IS EMPTY", true);
    const d = new Date();
    PlaylistTools.saveNew(uris, "Queue · " + d.toLocaleDateString([], { month: "short", day: "numeric" }));
  },
  list: new List($("q-list"), {
    render: (t, i) => {
      const r = renderTrack(t, i);
      const qb = r.querySelector('[data-act="queue"]'); if (qb) qb.remove();
      r.style.marginLeft = Math.min(i, 8) * 0.6 + "vw";
      if (t._up) {
        r.classList.add("upnext");
        const du = r.querySelector(".du"); if (du) du.textContent = t._fed ? "NEXT ▸" : "UP NEXT";
      }
      if (t._radio) { const du = r.querySelector(".du"); if (du) du.textContent = "AUTOPLAY"; }
      return r;
    },
    onActivate: (t, i, act) => views.queue.act(act || "play", t),
  }),
  show() { this.load(); },
  async load() {
    if (!UpNext.loaded) await UpNext.load();
    const keep = this.want != null ? this.want : this.list.i || 0;
    this.want = null;
    const r = await api("GET", "/me/player/queue");
    await settled();
    const now = r.body && r.body.currently_playing;
    const q = ((r.body && r.body.queue) || []).filter(Boolean);
    // The Up Next song already handed to Spotify shows up in its queue too: list it once, as Up Next.
    if (UpNext.fed) { const k = q.findIndex((t) => t.uri === UpNext.fed); if (k >= 0) q.splice(k, 1); }
    const ups = UpNext.items.map((t, i) => ({ ...t, _up: i + 1, _fed: i === 0 && UpNext.fed === t.uri }));
    setBg($("q-art"), now ? pickImage((now.album && now.album.images) || now.images, true) : null);
    $("q-title").textContent = now ? now.name : "NOTHING PLAYING";
    $("q-artist").textContent = now ? artistNames(now) : "";
    // Autoplay's line-up: Spotify only ever holds the next one, so the rest comes from Cadenza's own list.
    const inQ = new Set(q.map((t) => t.uri));
    const rad = Radio.upcoming().filter((t) => !inQ.has(t.uri)).map((t) => ({ ...t, _radio: true }));
    $("q-count").textContent = [ups.length ? ups.length + " UP NEXT" : "", q.length ? q.length + " FROM SPOTIFY" : "", rad.length ? rad.length + " AUTOPLAY" : ""].filter(Boolean).join(" · ") || "EMPTY";
    const first = !this.list.items.length;
    this.list.set([...ups, ...q, ...rad]);
    if (this.list.items.length) this.list.select(Math.min(keep, this.list.items.length - 1), false);
    if (first) revealRows(this.list.el);
  },
  act(kind, t) {
    if (!t) return;
    if (kind === "add") return Drawer.show(t);
    if (t._radio) return Radio.jumpTo(t.uri).then(() => setTimeout(() => this.load(), 700));    // stays on autoplay
    playBody({ uris: [t.uri] }, t.name).then((ok) => ok && setTimeout(() => this.load(), 700));
  },
  onKey(e) {
    const t = this.list.cur, i = this.list.i, k = e.key.toLowerCase();
    // ⌥↑ / ⌥↓ move an Up Next song (before the list's own arrow keys get it).
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && t && t._up) {
      this.want = i + (e.key === "ArrowUp" ? -1 : 1);                 // keep the moved song selected
      if (!UpNext.move(i, e.key === "ArrowUp" ? -1 : 1)) { this.want = null; toast(t._fed ? "ALREADY HANDED TO SPOTIFY · IT PLAYS NEXT" : "CAN'T MOVE IT FURTHER", true); }
      return true;
    }
    if (this.list.nav(e)) return true;
    if (e.key === "Enter") { pop(this.list.rows[this.list.i]); this.act("play", t); return true; }
    if (k === "x" && t && t._radio) {
      this.want = i;
      if (Radio.remove(t.uri)) { toast("NOT THAT ONE · AUTOPLAY WILL STEER AWAY FROM IT"); this.load(); }
      return true;
    }
    if (k === "x" && t) {
      if (!t._up) { toast("THAT ONE IS IN SPOTIFY'S QUEUE · ONLY UP NEXT SONGS CAN BE REMOVED", true); return true; }
      this.want = i; UpNext.remove(i); toast("REMOVED FROM UP NEXT"); return true;
    }
    if (k === "c" && !e.metaKey) { if (UpNext.items.length) UpNext.clear(); return true; }
    if (k === "a") { this.act("add", t); return true; }
    if (k === "s") { this.save(); return true; }
    if (k === "h") { go("history"); return true; }
    return false;
  },
};

/* =====================================================================
   LAST.FM: your whole listening history (Stats, play counts, the DJ, Friends)
   Cadenza only knows what it has played itself; Last.fm knows everything you've ever scrobbled.
   Reads go through native code with your own API key, one at a time.
   ===================================================================== */
const LFM = {
  cache: new Map(),
  /** Last.fm is set up: an API key and a logged-in user. */
  ready() { const l = Links.lastfm; return !!(l && l.hasKeys && l.user); },
  user() { return (Links.lastfm && Links.lastfm.user) || ""; },
  async get(method, params = {}, maxAge = 600000) {
    const key = method + "?" + new URLSearchParams(params).toString();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < maxAge) return hit.body;
    let r = null;
    try { r = await native("lastfm.get", { method, params }); } catch (e) { return null; }
    if (!r || r.status !== 200 || !r.body || r.body.error) return null;
    this.cache.set(key, { at: Date.now(), body: r.body });
    return r.body;
  },
  /** Last.fm sends a single item as an object instead of a one-item list. */
  arr(x) { return !x ? [] : Array.isArray(x) ? x : [x]; },
  /** The biggest real picture (Last.fm uses a grey star for "no picture"). */
  img(images) {
    const list = this.arr(images).map((i) => i && i["#text"]).filter((u) => u && !u.includes("2a96cbd8b46e442fc41c2b86b821562f"));
    return list.length ? list[list.length - 1] : null;
  },
  norm(s) { return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/^the\s+/, "").replace(/[^\p{L}\p{N}]+/gu, ""); },
  /** One key per song, so "Song (Remastered 2011)" on Spotify matches "Song" on Last.fm. */
  key(artist, title) { return this.norm(artist) + "|" + this.norm(cleanTitle(title)); },
  firstArtist(t) {
    if (!t) return "";
    if (t.raw && t.raw.artists && t.raw.artists[0]) return t.raw.artists[0].name;
    if (Array.isArray(t.artists)) return (t.artists[0] && t.artists[0].name) || "";
    return String(t.artists || "").split(", ")[0];
  },
  /** A Last.fm track as the kind of track object the lists know how to draw. */
  track(x, plays) {
    const artist = (x.artist && (x.artist.name || x.artist["#text"])) || "";
    const album = x.album ? (x.album["#text"] || x.album.title || "") : "";
    const image = this.img(x.image);
    return { name: x.name, artists: [{ name: artist }], album: { name: album, images: image ? [{ url: image, width: 300 }] : [] },
      duration_ms: (+x.duration || 0) * 1000, lfm: true, plays: plays != null ? plays : +x.playcount || 0 };
  },
};

/** Finds the Spotify copy of a song you know by name (Last.fm has names, not Spotify IDs). */
const Resolve = {
  mem: new Map(), loaded: false, saveT: 0,
  async track(name, artist) {
    const k = LFM.key(artist, name);
    if (!this.loaded) {
      this.loaded = true;
      try { const m = await native("store.get", { key: "spotifyMatches" }); if (m && typeof m === "object") Object.entries(m).forEach(([a, b]) => this.mem.set(a, b)); } catch (e) { /* demo */ }
    }
    if (this.mem.has(k)) return this.mem.get(k);
    const find = async (q) => {
      const r = await api("GET", `/search?type=track&limit=8&q=${enc(q)}`);
      return (r.status === 200 && r.body && r.body.tracks && r.body.tracks.items || []).filter((t) => t && t.uri && !t.is_local);
    };
    let items = await find(`track:"${cleanTitle(name)}" artist:"${artist}"`);
    if (!items.length) items = await find(cleanTitle(name) + " " + artist);
    const a = LFM.norm(artist);
    const best = items.find((t) => LFM.key(t.artists && t.artists[0] && t.artists[0].name, t.name) === k)
      || items.find((t) => (t.artists || []).some((x) => LFM.norm(x.name) === a)) || null;
    // Only what the lists need, so the saved copy stays small (it's written with everything else in store.json).
    const img = best && best.album && pickImage(best.album.images);
    const v = best ? { uri: best.uri, name: best.name, duration_ms: best.duration_ms, artists: (best.artists || []).slice(0, 3).map((x) => ({ id: x.id, name: x.name })),
      album: best.album ? { id: best.album.id, name: best.album.name, images: img ? [{ url: img, width: 300 }] : [] } : null } : null;
    this.mem.set(k, v);
    if (v) this.save();
    return v;
  },
  save() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => {
      const keep = [...this.mem.entries()].filter(([, v]) => v).slice(-800);
      native("store.set", { key: "spotifyMatches", value: Object.fromEntries(keep) }).catch(() => {});
    }, 3000);
  },
  /** Plays (or queues) a Last.fm song once it's found on Spotify. */
  async act(kind, t) {
    if (!t) return;
    let sp = t.lfm ? await this.track(t.name, LFM.firstArtist(t)) : t;
    if (!sp) return toast("COULDN'T FIND " + upper(t.name) + " ON SPOTIFY", true);
    if (kind === "queue") return queueTrack(sp);
    if (kind === "add") return Drawer.show(sp);
    if (kind === "more") return TrackMenu.show(sp);
    if (Radio.enabled()) return Radio.start(sp);
    return playBody({ uris: [sp.uri] }, sp.name);
  },
};

/* ---------- Play counts on every song, from Last.fm ---------- */
const PlayCounts = {
  tracks: new Map(), artists: new Map(), exact: new Map(), loading: null, loaded: false,
  async load(force) {
    if (!LFM.ready()) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      let saved = null;
      try { saved = await native("store.get", { key: "lastfmCounts" }); } catch (e) { /* demo */ }
      if (!force && saved && saved.user === LFM.user() && Date.now() - saved.at < 12 * 3600e3) {
        this.fill(saved);
      } else {
        // Your 3,000 most played songs and 1,000 most played artists cover nearly every row you'll see.
        const tracks = [], artists = [];
        for (let page = 1; page <= 3; page++) {
          const b = await LFM.get("user.getTopTracks", { period: "overall", limit: 1000, page }, 0);
          const list = LFM.arr(b && b.toptracks && b.toptracks.track);
          list.forEach((t) => tracks.push([LFM.key(t.artist && t.artist.name, t.name), +t.playcount || 0]));
          if (list.length < 1000) break;
        }
        const ba = await LFM.get("user.getTopArtists", { period: "overall", limit: 1000 }, 0);
        LFM.arr(ba && ba.topartists && ba.topartists.artist).forEach((a) => artists.push([LFM.norm(a.name), +a.playcount || 0]));
        const data = { user: LFM.user(), at: Date.now(), tracks, artists };
        if (tracks.length) native("store.set", { key: "lastfmCounts", value: data }).catch(() => {});
        this.fill(data);
      }
      this.loaded = true;
      this.decorateAll();
      applyNow();
    })().finally(() => { this.loading = null; });
    return this.loading;
  },
  fill(d) {
    this.tracks = new Map(d.tracks || []);
    this.artists = new Map(d.artists || []);
  },
  of(t) {
    if (!t || !t.name) return 0;
    const k = LFM.key(LFM.firstArtist(t), t.name);
    return Math.max(this.exact.has(k) ? this.exact.get(k) : 0, this.tracks.get(k) || 0);
  },
  ofArtist(name) { return this.artists.get(LFM.norm(name)) || 0; },
  text(n) { return n ? (n === 1 ? "1 play" : n.toLocaleString() + " plays") : ""; },
  /** Adds "· 214 plays" to a song row. */
  decorate(row, t) {
    const n = this.of(t), line = row.querySelector(".ti i");
    if (!line) return;
    let pc = line.querySelector(".pc");
    if (!n) { if (pc) pc.remove(); return; }
    if (!pc) { pc = h("span", "pc"); line.append(pc); }
    pc.textContent = "  ·  " + this.text(n);
  },
  decorateAll() { document.querySelectorAll(".trk").forEach((r) => { if (r.__t) this.decorate(r, r.__t); }); },
  /** The exact count for what's playing (the top-3,000 list can miss it, and it's always a play behind). */
  async exactFor(it) {
    if (!LFM.ready() || !it || !it.name) return;
    const artist = LFM.firstArtist(it), k = LFM.key(artist, it.name);
    const b = await LFM.get("track.getInfo", { artist, track: cleanTitle(it.name), autocorrect: 1 }, 300000);
    const n = b && b.track ? +b.track.userplaycount || 0 : 0;
    if (n && n !== this.exact.get(k)) { this.exact.set(k, n); applyNow(); this.decorateAll(); }
  },
};

/* =====================================================================
   STATS: your listening, from Last.fm (or Cadenza's own history if Last.fm isn't connected)
   ===================================================================== */
const PERIODS = { 7: "7day", 30: "1month", 365: "12month", 0: "overall" };
views.stats = {
  el: $("v-stats"), range: 7, entries: null, at: 0, lfm: {}, source: "cadenza", token: 0,
  // Imported Spotify history: every play as an entry, how many, and when the last one ended (ms).
  spot: [], spotPlays: 0, spotEnd: 0, spotLoaded: false, picked: false, importing: false,
  // Last.fm scrobbles after that (saved on this Mac, topped up from Last.fm), and when they were last topped up.
  scrob: null, scrobAt: 0, syncing: false,
  keys: () => [["← →", "WEEK / MONTH / YEAR / ALL"], ["↑↓", "SONGS"], ["⏎", "PLAY"], ["Q", "UP NEXT"], ["A", "ADD"],
    ["I", "IMPORT SPOTIFY HISTORY", () => views.stats.importHistory()],
    ...(views.stats.sources().length > 1 ? [["S", "SOURCE", () => views.stats.nextSource()]] : []),
    ["F", "FRIENDS", () => go("friends")], ["ESC", "BACK", back]],
  list: new List($("st-songs"), {
    render: (x, i) => {
      const r = renderTrack(x.t, i, { thumb: true, noCount: true });
      const du = r.querySelector(".du"); if (du) du.textContent = x.n.toLocaleString() + (x.n === 1 ? " PLAY" : " PLAYS");
      return r;
    },
    onActivate: (x, i, act) => views.stats.act(act || "play", x && x.t),
  }),
  async show() {
    if (!Links.lastfm) await Links.load();
    await this.loadSpotify();
    // Everything together first, then Last.fm's charts, then Cadenza's own log.
    // A source you picked with S stays picked while it's still there.
    const list = this.sources();
    if (!this.picked || !list.includes(this.source)) this.source = list[0];
    this.renderActs();
    setKeys(this.keys());
    if (this.source === "lastfm") return this.showLastfm();
    await Promise.all([this.load(), this.source === "all" && LFM.ready() ? this.loadScrobbles() : null]);
    if (this.source === "all") this.syncScrobbles();             // fetches new scrobbles in the background, then draws again
    this.render();
  },
  /** "all" is everything together: imported Spotify history, then Last.fm, then Cadenza. "lastfm" is
   *  Last.fm's own charts, and "cadenza" only what Cadenza played. */
  sources() {
    return [...(this.spotPlays || LFM.ready() ? ["all"] : []), ...(LFM.ready() ? ["lastfm"] : []), "cadenza"];
  },
  nextSource() {
    const list = this.sources();
    if (list.length < 2) return;
    this.source = list[(list.indexOf(this.source) + 1) % list.length];
    this.picked = true;
    Sfx.play("page");
    this.show();
  },
  /** The source and import buttons at the end of the range tabs. */
  renderActs() {
    const names = { all: "ALL", lastfm: "LAST.FM CHARTS", cadenza: "CADENZA" };
    const src = $("st-source");
    src.hidden = this.sources().length < 2;
    src.textContent = "SOURCE: " + names[this.source];
    $("st-import").textContent = this.importing ? "IMPORTING…" : "+ IMPORT";
    $("st-import").title = "Import your Spotify listening history (I)";
  },

  // ----- Imported Spotify history -----
  async loadSpotify(force) {
    if (this.spotLoaded && !force) return;
    let d = null;
    try { d = await native("spotifyHistory.get"); } catch (e) { d = null; }
    const tracks = (d && Array.isArray(d.tracks)) ? d.tracks : [], plays = (d && Array.isArray(d.plays)) ? d.plays : [];
    // Each play is [end time in seconds, song number, ms played]. Entries use the start time, like Cadenza's own log.
    this.spot = plays.map(([end, i, ms]) => {
      const t = tracks[i] || [];
      return { uri: t[0] || "", name: t[1] || "", artists: t[2] || "", album: t[3] || "", one: true, ms, at: end * 1000 - ms };
    }).filter((e) => e.name);
    this.spotPlays = this.spot.length;
    this.spotEnd = plays.length ? plays[plays.length - 1][0] * 1000 : 0;
    this.spotLoaded = true;
  },
  /** Pick Spotify's history files (or the .zip) and add them. Plays already there are left out. */
  async importHistory() {
    if (this.importing) return;
    this.importing = true; this.renderActs();
    toast("CHOOSE THE .ZIP SPOTIFY SENT YOU, OR THE STREAMING_HISTORY .JSON FILES");
    let r = null;
    try { r = await native("spotifyHistory.import"); } catch (e) { r = null; }
    this.importing = false;
    if (!r) { this.renderActs(); return; }                      // cancelled
    if (!r.files) { this.renderActs(); return toast("NO SPOTIFY HISTORY IN THOSE FILES. LOOK FOR STREAMING_HISTORY_AUDIO_….JSON", true); }
    const n = (x) => Number(x || 0).toLocaleString();
    toast(r.added ? `ADDED ${n(r.added)} PLAYS` + (r.duplicates ? ` · ${n(r.duplicates)} WERE ALREADY THERE` : "") : `NOTHING NEW · ALL ${n(r.duplicates)} PLAYS WERE ALREADY THERE`);
    await this.loadSpotify(true);
    if (r.added) { this.source = "all"; this.picked = true; this.range = 0; $("st-tabs").querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.r === 0)); }
    if (current() && current().name === "stats") this.show();
  },
  // ----- Last.fm scrobbles after the imported history -----
  async loadScrobbles() {
    if (this.scrob && this.scrob.user === LFM.user()) return;
    let v = null;
    try { v = await native("lastfmPlays.get"); } catch (e) { v = null; }
    this.scrob = v && v.user === LFM.user() && Array.isArray(v.plays) ? v : { user: LFM.user(), upTo: 0, plays: [] };
  },
  /** Ask Last.fm for scrobbles newer than the ones saved (and newer than the imported history), at most
   *  every 10 minutes. The first time, that's everything since the imported history ends, or your whole
   *  Last.fm history if nothing is imported: up to a minute or two for a big one. */
  async syncScrobbles(force) {
    if (!LFM.ready() || this.syncing || (!force && Date.now() - this.scrobAt < 600000)) return;
    this.syncing = true;
    try {
      await this.loadScrobbles();
      const s = this.scrob;
      const from = Math.max(s.upTo + 1, Math.floor(this.spotEnd / 1000) + 1);
      const to = Math.floor(Date.now() / 1000);
      const got = [];
      for (let page = 1, pages = 1; page <= pages && page <= 2000; page++) {
        const b = await LFM.get("user.getRecentTracks", { from, to, limit: 200, page }, 0);
        if (!b || !b.recenttracks) { if (page === 1) return; break; }        // Last.fm unreachable: try again later
        pages = +(b.recenttracks["@attr"] && b.recenttracks["@attr"].totalPages) || 1;
        for (const x of LFM.arr(b.recenttracks.track)) {
          const uts = x.date && +x.date.uts;                       // the song playing right now has no date yet
          const artist = (x.artist && (x.artist["#text"] || x.artist.name)) || "";
          if (uts && x.name && artist) got.push([uts, x.name, artist, (x.album && x.album["#text"]) || ""]);
        }
        if (pages > 3 && current() && current().name === "stats") setText("st-range", `SYNCING LAST.FM · ${Math.round((page / pages) * 100)}%`);
      }
      // The same scrobble twice (Last.fm's pages shift while new ones arrive): keep one.
      const have = new Set(s.plays.map((p) => p[0] + "|" + p[1]));
      const fresh = got.filter((p) => { const k = p[0] + "|" + p[1]; if (have.has(k)) return false; have.add(k); return true; });
      this.scrobAt = Date.now();
      s.plays = s.plays.concat(fresh).sort((a, b) => a[0] - b[0]);
      s.upTo = to;
      native("lastfmPlays.set", { value: s }).catch(() => {});
      if (current() && current().name === "stats" && this.source === "all") this.render();
    } finally { this.syncing = false; }
  },

  async clearHistory() {
    let ok = false;
    try { ok = await native("spotifyHistory.clear"); } catch (e) { ok = false; }
    if (!ok) return;
    toast("IMPORTED SPOTIFY HISTORY REMOVED");
    await this.loadSpotify(true);
    if (current() && current().name === "stats") this.show();
  },
  setRange(days) {
    this.range = days;
    $("st-tabs").querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.r === days));
    this.source === "lastfm" ? this.showLastfm() : this.render();
  },
  cycle(d) { const order = [7, 30, 365, 0]; this.setRange(order[(order.indexOf(this.range) + d + 4) % 4]); },
  tiles(list) {
    const tiles = $("st-tiles");
    tiles.textContent = "";
    list.forEach(([v, l]) => { const t = h("div", "st-tile"); t.append(h("b", null, String(v)), h("span", null, l)); tiles.append(t); });
  },
  artistBars(box, top, unit = "PLAY") {
    box.textContent = "";
    const max = top.length ? top[0][1] : 1;
    top.forEach(([name, n], i) => {
      const r = h("div", "st-artist");
      const bar = h("i"); bar.style.width = `calc((100% - 2.4vw) * ${(n / max).toFixed(3)})`;
      r.append(h("em", null, String(i + 1)), h("span", null, name), h("small", null, n.toLocaleString() + " " + unit + (n === 1 ? "" : "S")), bar);
      box.append(r);
    });
  },
  hourBars(hours) {
    const hb = $("st-hours"), peak = Math.max(...hours);
    hb.textContent = "";
    hours.forEach((v, hr) => { const b = h("i"); b.style.height = (peak ? Math.max(2, (v / peak) * 100) : 2) + "%"; if (v === peak && peak) b.classList.add("peak"); hb.append(b); });
    [0, 6, 12, 18].forEach((hr) => { const l = h("b", null, hr === 0 ? "12AM" : hr === 12 ? "12PM" : hr < 12 ? hr + "AM" : hr - 12 + "PM"); l.style.left = ((hr + 0.5) / 24 * 100) + "%"; hb.append(l); });
  },
  showEmpty(text) {
    const empty = $("st-empty");
    empty.hidden = !text;
    if (text) empty.textContent = text;
    this.el.querySelectorAll(".st-tiles, .st-cols").forEach((n) => (n.style.display = text ? "none" : ""));
  },

  // ----- Last.fm -----
  async loadLastfm(range) {
    const hit = this.lfm[range];
    if (hit && Date.now() - hit.at < 600000) return hit;
    const period = PERIODS[range], from = range ? Math.floor(Date.now() / 1000 - range * 86400) : 0;
    const [info, arts, trks, count] = await Promise.all([
      LFM.get("user.getInfo", {}, 600000),
      LFM.get("user.getTopArtists", { period, limit: 8 }),
      LFM.get("user.getTopTracks", { period, limit: 50 }),
      range ? LFM.get("user.getRecentTracks", { from, limit: 1 }) : Promise.resolve(null),
    ]);
    if (!info && !arts && !trks) return null;
    // When you listen: the hours of your last 1,000 plays in this stretch.
    const hours = Array(24).fill(0);
    for (let page = 1; page <= 5; page++) {
      const b = await LFM.get("user.getRecentTracks", { ...(from ? { from } : {}), limit: 200, page });
      const list = LFM.arr(b && b.recenttracks && b.recenttracks.track);
      list.forEach((x) => { const uts = x.date && +x.date.uts; if (uts) hours[new Date(uts * 1000).getHours()]++; });
      if (list.length < 200) break;
    }
    const u = (info && info.user) || {};
    const d = {
      at: Date.now(),
      plays: range ? +(count && count.recenttracks && count.recenttracks["@attr"] && count.recenttracks["@attr"].total) || 0 : +u.playcount || 0,
      artists: +(arts && arts.topartists && arts.topartists["@attr"] && arts.topartists["@attr"].total) || +u.artist_count || 0,
      songs: +(trks && trks.toptracks && trks.toptracks["@attr"] && trks.toptracks["@attr"].total) || +u.track_count || 0,
      since: u.registered ? +(u.registered.unixtime || u.registered["#text"]) * 1000 : 0,
      top: LFM.arr(arts && arts.topartists && arts.topartists.artist).map((a) => [a.name, +a.playcount || 0]),
      songsList: LFM.arr(trks && trks.toptracks && trks.toptracks.track).map((x) => ({ t: LFM.track(x), n: +x.playcount || 0 })),
      hours,
    };
    this.lfm[range] = d;
    return d;
  },
  async showLastfm() {
    const range = this.range, token = ++this.token;
    setText("st-range", "LAST.FM · " + upper(LFM.user()));
    if (!this.lfm[range]) { this.showEmpty("LOADING YOUR LAST.FM HISTORY…"); this.list.set([]); }
    const d = await this.loadLastfm(range);
    if (token !== this.token || !(current() && current().name === "stats")) return;
    if (!d) return this.showEmpty("COULDN'T REACH LAST.FM. CHECK YOUR API KEY IN SYSTEM → CONNECTIONS.");
    if (!d.plays && !d.songsList.length) return this.showEmpty("NOTHING SCROBBLED IN THIS STRETCH YET");
    this.showEmpty("");
    const days = range || Math.max(1, (Date.now() - (d.since || Date.now())) / 86400e3);
    this.tiles([
      [d.plays.toLocaleString(), "PLAYS"],
      [d.artists.toLocaleString(), "ARTISTS"],
      [d.songs.toLocaleString(), "SONGS"],
      range || !d.since ? [Math.round(d.plays / days).toLocaleString(), "PLAYS A DAY"] : [new Date(d.since).getFullYear(), "SCROBBLING SINCE"],
    ]);
    this.artistBars($("st-artists"), d.top.slice(0, 6));
    this.hourBars(d.hours);
    this.list.set(d.songsList);
    this.list.select(0, false);
    revealRows(this.el);
    this.fillCovers(d.songsList, token);
  },
  /** Last.fm hardly has song pictures any more: borrow the covers from Spotify for the top rows. */
  async fillCovers(rows, token) {
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      if (token !== this.token) return;
      const x = rows[i];
      if (x.t.album && x.t.album.images && x.t.album.images.length) continue;
      const sp = await Resolve.track(x.t.name, LFM.firstArtist(x.t));
      if (token !== this.token) return;
      if (sp && sp.album && sp.album.images && sp.album.images.length) {
        x.t.album = sp.album;
        const th = this.list.rows[i] && this.list.rows[i].querySelector(".thumb");
        if (th) setBg(th, pickImage(sp.album.images));
      }
    }
  },

  // ----- Cadenza's own history (no Last.fm) -----
  async load(force) {
    if (!force && this.entries && Date.now() - this.at < 60000) return;
    let es = [];
    try { es = await native("history.get", { since: 0 }); } catch (e) { es = []; }
    this.entries = Array.isArray(es) ? es.filter((e) => e && e.uri && e.at) : [];
    this.at = Date.now();
  },
  /** Artist names of an entry. Imported plays have one artist (which may contain a comma). */
  artistsOf(e) { return e.one ? (e.artists ? [e.artists] : []) : String(e.artists || "").split(", ").filter(Boolean); },
  track(e) {
    // An imported play from the "account data" files has no song link: find it on Spotify when played.
    return { uri: e.uri, name: e.name, duration_ms: e.dur || 0, lfm: !e.uri,
      artists: this.artistsOf(e).map((name) => ({ name })),
      album: { name: e.album || "", images: e.image ? [{ url: e.image, width: 640 }] : [] } };
  },
  /** Everything in one list, oldest first, each play counted once:
   *  1. your imported Spotify history;
   *  2. then Last.fm scrobbles made after it ends;
   *  3. then Cadenza's own plays after it ends that Last.fm doesn't already have. Spotify scrobbles what
   *     Cadenza plays, so most are there: a play counts as the same if it's the same song within 10 minutes.
   *  Last.fm doesn't say how long you listened, so a scrobble counts for that song's usual length from
   *  your other plays, or 3.5 minutes. */
  combined() {
    const end = this.spotEnd, own = this.entries || [];
    const keyOf = (e) => LFM.key(this.artistsOf(e)[0] || "", e.name);
    const usual = new Map();
    for (const e of this.spot) if (e.ms) usual.set(keyOf(e), e.ms);
    for (const e of own) if (e.dur || e.ms) usual.set(keyOf(e), e.dur || e.ms);
    // Older versions of Cadenza scrobbled too, so with Spotify's own Last.fm link some plays are on Last.fm
    // twice, a moment apart: the same song again within 90 seconds is that, not a real second play.
    const near = new Map(), scrobs = [];
    for (const [uts, name, artists, album] of ((LFM.ready() && this.scrob && this.scrob.plays) || [])) {
      if (uts * 1000 <= end) continue;
      const e = { uri: "", name, artists, album, one: true, at: uts * 1000 }, k = keyOf(e);
      const times = near.get(k) || [];
      if (times.some((t) => Math.abs(t - e.at) < 90000)) continue;
      times.push(e.at); near.set(k, times);
      e.ms = usual.get(k) || 210000;
      scrobs.push(e);
    }
    const mine = own.filter((e) => e.at > end && !(near.get(keyOf(e)) || []).some((t) => Math.abs(t - e.at) < 600000));
    return this.spot.concat(scrobs, mine).sort((a, b) => a.at - b.at);
  },
  render() {
    const own = this.entries || [];
    const spotify = this.source === "all";
    const all = spotify ? this.combined() : own;
    const since = this.range ? Date.now() - this.range * 86400e3 : 0;
    const es = all.filter((e) => e.at >= since);
    const token = ++this.token;
    const parts = [this.spotPlays ? "SPOTIFY HISTORY" : "", LFM.ready() ? "LAST.FM" : "", "CADENZA"].filter(Boolean).join(" + ");
    setText("st-range", spotify ? parts + " · SINCE " + new Date(all[0] ? all[0].at : Date.now()).getFullYear()
      : "CADENZA ONLY · IMPORT YOUR SPOTIFY HISTORY OR CONNECT LAST.FM FOR EVERYTHING");
    if (!es.length) {
      this.showEmpty(all.length ? "NOTHING PLAYED IN THIS STRETCH YET" : this.syncing ? "LOADING YOUR LAST.FM HISTORY…"
        : "PLAY SOME MUSIC, IMPORT YOUR SPOTIFY HISTORY (I), OR CONNECT LAST.FM IN SYSTEM → CONNECTIONS.");
      this.list.set([]);
      return;
    }
    this.showEmpty("");
    const minutes = Math.round(es.reduce((a, e) => a + (e.ms || 0), 0) / 60000);
    const artistCount = {}, songCount = {}, hours = Array(24).fill(0);
    for (const e of es) {
      for (const a of this.artistsOf(e)) artistCount[a] = (artistCount[a] || 0) + 1;
      // The same song from different sources (with or without a Spotify link) counts as one.
      const key = spotify ? LFM.key(this.artistsOf(e)[0] || "", e.name) : e.uri || "n:" + (e.name + "|" + e.artists).toLowerCase();
      const s = songCount[key] || (songCount[key] = { t: this.track(e), n: 0, last: 0 });
      if (!s.t.uri && e.uri) s.t = this.track(e);                  // prefer a version that links to Spotify
      s.n++; s.last = Math.max(s.last, e.at);
      hours[new Date(e.at).getHours()] += (e.ms || 0);
    }
    // Day streak: days in a row (ending today or yesterday) with at least one play.
    const day = (t) => { const d = new Date(t); return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate(); };
    const days = new Set(all.map((e) => day(e.at)));
    let streak = 0, cur = new Date();
    if (!days.has(day(cur))) cur.setDate(cur.getDate() - 1);
    while (days.has(day(cur))) { streak++; cur.setDate(cur.getDate() - 1); }
    this.tiles([[minutes >= 600 ? Math.round(minutes / 60) + "H" : minutes, minutes >= 600 ? "HOURS LISTENED" : "MINUTES LISTENED"], [es.length.toLocaleString(), "PLAYS"],
      [Object.keys(artistCount).length.toLocaleString(), "ARTISTS"], [streak, streak === 1 ? "DAY STREAK" : "DAYS IN A ROW"]]);
    this.artistBars($("st-artists"), Object.entries(artistCount).sort((a, b) => b[1] - a[1]).slice(0, 6));
    this.hourBars(hours);
    const rows = Object.values(songCount).sort((a, b) => b.n - a.n || b.last - a.last).slice(0, 50);
    this.list.set(rows);
    this.list.select(0, false);
    revealRows(this.el);
    if (spotify) this.fillCovers(rows, token);                   // imported plays come without pictures
  },
  act(kind, t) { return Resolve.act(kind, t); },
  onKey(e) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Tab") { this.cycle(e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey) ? -1 : 1); return true; }
    if (this.list.nav(e)) return true;
    const k = e.key.toLowerCase(), x = this.list.cur;
    if (e.key === "Enter") { pop(this.list.rows[this.list.i]); this.act("play", x && x.t); return true; }
    if (k === "q") { this.act("queue", x && x.t); return true; }
    if (k === "a") { this.act("add", x && x.t); return true; }
    if (k === "f") { go("friends"); return true; }
    if (k === "i") { this.importHistory(); return true; }
    if (k === "s") { this.nextSource(); return true; }
    return false;
  },
};
$("st-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.id === "st-import") return views.stats.importHistory();
  if (b.id === "st-source") return views.stats.nextSource();
  views.stats.setRange(+b.dataset.r);
});

/* =====================================================================
   FRIENDS: your Last.fm friends, what they're playing, and how close your taste is
   ===================================================================== */
views.friends = {
  el: $("v-friends"), loaded: false, token: 0, selT: 0, mine: null,
  keys: () => [["↑↓", "FRIEND"], ["⏎", "PLAY THEIR SONG"], ["B", "BLEND"], ["O", "PROFILE"], ["+", "ADD"], ["X", "REMOVE"], ["ESC", "BACK", back]],
  list: new List($("fr-list"), {
    render: (f, i) => {
      if (f.add) {
        const r = h("div", "trk media fr-add");
        const inn = h("div", "in"), th = h("span", "thumb"), ti = h("span", "ti");
        th.append(h("b", null, "+"));
        ti.append(h("b", null, "Add a friend"), h("i", null, "Anyone's Last.fm username"));
        inn.append(th, ti, h("span", "acts"), h("span", "du", "ADD"));
        r.append(inn);
        return r;
      }
      const r = h("div", "trk media friend");
      const inn = h("div", "in"), th = h("span", "thumb"), ti = h("span", "ti");
      setBg(th, f.image || null);
      if (!f.image) th.append(h("b", null, upper(f.name[0] || "?")));
      ti.append(h("b", null, f.realname ? f.realname + "  ·  " + f.name : f.name), h("i", "fr-now", views.friends.nowText(f)));
      inn.append(th, ti, h("span", "acts"), h("span", "du", f.match != null ? f.match + "%" : ""));
      r.append(inn);
      return r;
    },
    onSelect: (f) => views.friends.select(f),
    onActivate: (f) => views.friends.act("play", f),
  }),
  nowText(f) {
    if (f.loading) return "…";
    if (!f.last) return f.extra ? "Added by you" : "No plays yet";
    const line = f.last.name + "  ·  " + f.last.artist;
    return (f.last.now ? "▶ " : ago(f.last.at) + "  ·  ") + line;
  },
  async show(params, isBack) {
    if (!Links.lastfm) await Links.load();
    if (!LFM.ready()) {
      this.showEmpty("CONNECT LAST.FM IN SYSTEM → CONNECTIONS TO SEE YOUR FRIENDS.");
      setText("fr-sub", "");
      return;
    }
    if (isBack && this.loaded) return;
    await this.load();
  },
  showEmpty(text) {
    const e = $("fr-empty");
    e.hidden = !text;
    if (text) e.textContent = text;
    this.el.querySelector(".st-cols").style.display = text ? "none" : "";
  },
  async extras() {
    try { const v = await native("store.get", { key: "lastfmFriends" }); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  },
  async load() {
    const token = ++this.token;
    this.showEmpty("");
    setText("fr-sub", "LOADING…");
    const [b, extra] = await Promise.all([LFM.get("user.getFriends", { limit: 50 }, 300000), this.extras()]);
    const seen = new Set();
    const friends = [];
    LFM.arr(b && b.friends && b.friends.user).forEach((u) => { if (!seen.has(u.name.toLowerCase())) { seen.add(u.name.toLowerCase()); friends.push({ name: u.name, realname: u.realname || "", image: LFM.img(u.image), loading: true }); } });
    extra.forEach((n) => { if (!seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); friends.push({ name: n, realname: "", image: null, loading: true, extra: true }); } });
    if (token !== this.token) return;
    this.loaded = true;
    this.list.set([{ add: true }, ...friends]);
    this.list.select(friends.length ? 1 : 0, false);
    revealRows(this.list.el);
    setText("fr-sub", friends.length ? friends.length + (friends.length === 1 ? " FRIEND" : " FRIENDS") + " ON LAST.FM" : "NO FRIENDS YET · ADD SOMEONE BY USERNAME");
    if (!friends.length) this.select(null);
    this.fillIn(friends, token);                       // not awaited: the page shows straight away
  },
  /** What each friend played last, and how close your taste is, one friend at a time. */
  async fillIn(friends, token) {
    for (const f of friends) {
      if (token !== this.token) return;
      const r = await LFM.get("user.getRecentTracks", { user: f.name, limit: 1 }, 60000);
      const x = LFM.arr(r && r.recenttracks && r.recenttracks.track)[0];
      f.loading = false;
      if (x) f.last = { name: x.name, artist: (x.artist && (x.artist["#text"] || x.artist.name)) || "", now: !!(x["@attr"] && x["@attr"].nowplaying), at: x.date ? +x.date.uts * 1000 : 0 };
      const cmp = await this.compare(f.name);
      if (cmp) f.match = cmp.score;
      this.redraw(f);
    }
  },
  redraw(f) {
    const i = this.list.items.indexOf(f), row = this.list.rows[i];
    if (!row) return;
    const fresh = this.list.o.render(f, i);
    fresh.dataset.i = i;
    if (row.classList.contains("active")) fresh.classList.add("active");
    row.replaceWith(fresh);
    this.list.rows[i] = fresh;
    if (this.list.i === i) this.select(f);
  },
  /** Top artists (past year) for one person, as [name, plays]. */
  async topArtists(user) {
    const b = await LFM.get("user.getTopArtists", { user, period: "12month", limit: 100 }, 3600000);
    return LFM.arr(b && b.topartists && b.topartists.artist).map((a) => [a.name, +a.playcount || 0]);
  },
  /** How alike two people's listening is: cosine similarity of their top artists (on a log scale,
   *  so one artist played to death doesn't decide it), as a percentage. */
  async compare(user) {
    if (!this.mine) this.mine = await this.topArtists(LFM.user());
    const theirs = await this.topArtists(user);
    if (!this.mine.length || !theirs.length) return null;
    const A = new Map(this.mine.map(([n, p]) => [LFM.norm(n), [n, Math.log1p(p)]]));
    const B = new Map(theirs.map(([n, p]) => [LFM.norm(n), [n, Math.log1p(p)]]));
    let dot = 0, a2 = 0, b2 = 0;
    A.forEach(([, v]) => (a2 += v * v));
    B.forEach(([, v]) => (b2 += v * v));
    const shared = [];
    A.forEach(([name, v], k) => { if (B.has(k)) { const w = B.get(k)[1]; dot += v * w; shared.push([name, Math.round(Math.expm1(Math.min(v, w)))]); } });
    const score = Math.round(Math.min(1, dot / Math.sqrt(a2 * b2) * 1.35) * 100);   // stretched a little: 70% similar already feels very alike
    shared.sort((x, y) => y[1] - x[1]);
    return { score, shared, theirs };
  },
  matchWord(s) { return s >= 80 ? "SUPER" : s >= 60 ? "VERY HIGH" : s >= 40 ? "HIGH" : s >= 20 ? "MEDIUM" : "LOW"; },
  select(f) {
    clearTimeout(this.selT);
    const tiles = $("fr-tiles");
    if (!f || f.add) {
      setText("fr-h", "TASTE MATCH");
      tiles.textContent = "";
      $("fr-shared").textContent = ""; $("fr-top").textContent = "";
      $("fr-shared").append(h("div", "fr-hint", f && f.add ? "Type a Last.fm username to follow someone here, even if you aren't friends on Last.fm." : "Pick a friend to compare your taste."));
      return;
    }
    this.selT = setTimeout(async () => {
      const cmp = await this.compare(f.name);
      if (this.list.cur !== f) return;
      setText("fr-h", "YOU AND " + upper(f.name));
      tiles.textContent = "";
      const tile = (v, l) => { const t = h("div", "st-tile"); t.append(h("b", null, String(v)), h("span", null, l)); tiles.append(t); };
      if (!cmp) { tile("—", "NOT ENOUGH PLAYS"); $("fr-shared").textContent = ""; $("fr-top").textContent = ""; return; }
      tile(cmp.score + "%", this.matchWord(cmp.score) + " MATCH");
      tile(cmp.shared.length, "ARTISTS IN COMMON");
      views.stats.artistBars($("fr-shared"), cmp.shared.slice(0, 5));
      views.stats.artistBars($("fr-top"), cmp.theirs.slice(0, 5));
      if (!cmp.shared.length) $("fr-shared").append(h("div", "fr-hint", "Nothing in common yet. Try a blend (B)."));
    }, 180);
  },
  async add() {
    const v = await Modal.open({ title: "ADD A FRIEND", ok: "ADD", fields: [{ key: "name", label: "Last.fm username", type: "text", value: "" }] });
    const name = v && String(v.name || "").trim();
    if (!name) return;
    const b = await LFM.get("user.getInfo", { user: name }, 0);
    if (!b || !b.user) return toast("NO LAST.FM USER CALLED " + upper(name), true);
    const extra = await this.extras();
    if (!extra.some((n) => n.toLowerCase() === b.user.name.toLowerCase())) extra.push(b.user.name);
    await native("store.set", { key: "lastfmFriends", value: extra }).catch(() => {});
    toast("ADDED " + upper(b.user.name));
    this.load();
  },
  async remove(f) {
    if (!f || f.add) return;
    if (!f.extra) return toast("REMOVE LAST.FM FRIENDS ON LAST.FM ITSELF");
    const extra = (await this.extras()).filter((n) => n.toLowerCase() !== f.name.toLowerCase());
    await native("store.set", { key: "lastfmFriends", value: extra }).catch(() => {});
    toast("REMOVED " + upper(f.name));
    this.load();
  },
  /** A blend: your recent favourites and theirs, taken in turns. */
  async blend(f) {
    if (!f || f.add) return;
    toast("MIXING YOU AND " + upper(f.name) + "…");
    const top = async (user) => { const b = await LFM.get("user.getTopTracks", { user, period: "1month", limit: 30 }, 600000); return shuffle(LFM.arr(b && b.toptracks && b.toptracks.track).slice(0, 30)); };
    const [mine, theirs] = await Promise.all([top(LFM.user()), top(f.name)]);
    const uris = [], seen = new Set();
    for (let i = 0; uris.length < 16 && (i < mine.length || i < theirs.length); i++) {
      for (const x of [mine[i], theirs[i]]) {
        if (!x || uris.length >= 16) continue;
        const sp = await Resolve.track(x.name, x.artist && x.artist.name);
        if (sp && !seen.has(sp.uri)) { seen.add(sp.uri); uris.push(sp.uri); }
      }
    }
    if (uris.length < 2) return toast("NOT ENOUGH TO MIX YET", true);
    playBody({ uris }, "BLEND: YOU + " + upper(f.name));
  },
  async act(kind, f) {
    if (!f) return;
    if (f.add) return this.add();
    if (kind === "blend") return this.blend(f);
    if (kind === "profile") return native("openURL", { url: "https://www.last.fm/user/" + enc(f.name) }).catch(() => {});
    if (!f.last) return toast(upper(f.name) + " HASN'T PLAYED ANYTHING YET");
    Resolve.act("play", { name: f.last.name, artists: [{ name: f.last.artist }], lfm: true });
  },
  onKey(e) {
    if (this.list.nav(e)) return true;
    const k = e.key.toLowerCase(), f = this.list.cur;
    if (e.key === "Enter") { pop(this.list.rows[this.list.i]); this.act("play", f); return true; }
    if (k === "b") { this.act("blend", f); return true; }
    if (k === "o") { this.act("profile", f); return true; }
    if (e.key === "+" || e.key === "=") { this.add(); return true; }
    if (k === "x") { this.remove(f); return true; }
    return false;
  },
};

/* =====================================================================
   HISTORY: what you've played recently
   ===================================================================== */
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (!isFinite(s)) return "";
  if (s < 90) return "NOW";
  if (s < 3600) return Math.round(s / 60) + "M AGO";
  if (s < 86400) return Math.round(s / 3600) + "H AGO";
  return Math.round(s / 86400) + "D AGO";
};
views.history = {
  el: $("v-history"), next: null, loading: false, at: 0,
  keys: () => [["↑↓", "SELECT"], ["⏎", "PLAY"], ["Q", "UP NEXT"], ["A", "ADD"], ["M", "MORE"], ["ESC", "BACK", back]],
  list: new List($("hist-list"), {
    render: (e, i) => {
      const r = renderTrack(e.track, i, { thumb: true });
      r.querySelector(".du").textContent = ago(e.played_at);
      return r;
    },
    onActivate: (e, i, act) => views.history.act(act || "play", e && e.track),
    onNearEnd: () => views.history.load(false),
  }),
  show(params, isBack) {
    if (isBack && this.list.items.length && Date.now() - this.at < 60000) return;
    this.list.set([]); this.next = null;
    setText("hist-count", "LOADING…");
    this.load(true);
  },
  async load(first) {
    if (this.loading || (!first && !this.next)) return;
    this.loading = true;
    const r = await api("GET", first ? "/me/player/recently-played?limit=50" : this.next);
    await settled();
    this.loading = false;
    if (r.status !== 200 || !r.body) { setText("hist-count", errMsg(r)); return; }
    const items = (r.body.items || []).filter((e) => e && e.track && e.track.uri);
    this.next = r.body.next ? relPath(r.body.next) : null;
    const wasEmpty = !this.list.items.length;
    this.list.add(items);
    this.at = Date.now();
    setText("hist-count", this.list.items.length + " RECENT PLAYS");
    if (wasEmpty) { this.list.select(0, false); revealRows(this.list.el); }
  },
  act(kind, t) {
    if (!t) return;
    if (kind === "queue") return queueTrack(t);
    if (kind === "add") return Drawer.show(t);
    if (kind === "more") return TrackMenu.show(t);
    if (Radio.enabled()) return Radio.start(t);
    playBody({ uris: [t.uri] }, t.name);
  },
  onKey(e) {
    if (this.list.nav(e)) return true;
    const k = e.key.toLowerCase(), t = this.list.cur && this.list.cur.track;
    if (e.key === "Enter") { pop(this.list.rows[this.list.i]); this.act("play", t); return true; }
    if (k === "q") { this.act("queue", t); return true; }
    if (k === "a") { this.act("add", t); return true; }
    if (k === "m") { this.act("more", t); return true; }
    return false;
  },
};

/* =====================================================================
   PLAYLIST TOOLS: remove duplicates, sort, copy, save as new
   ===================================================================== */
const PlaylistTools = {
  /** Every song in a playlist (or Liked Songs), in order. null when Spotify won't share the list. */
  async all(pl) {
    const liked = pl.kind === "liked", out = [];
    let path = liked ? "/me/tracks?limit=50" : `/playlists/${pl.id}/items?limit=100`, pages = 0;
    while (path && pages++ < 80) {
      const r = await api("GET", path);
      if (r.status !== 200 || !r.body) return out.length ? out : null;
      (r.body.items || []).forEach((e) => {
        const t = e && (e.item || e.track);
        if (t && t.uri && !t.is_local) out.push({ uri: t.uri, name: cleanTitle(t.name || ""), artist: (t.artists && t.artists[0] && t.artists[0].name) || "", added: e.added_at || "" });
      });
      path = relPath(r.body.next);
    }
    return out;
  },
  async add(pl, uris) {
    for (let i = 0; i < uris.length; i += 100) {
      const r = await api("POST", `/playlists/${pl.id}/items`, { uris: uris.slice(i, i + 100) });
      if (r.status >= 300) return r;
      if (r.body && r.body.snapshot_id) pl.snapshot_id = r.body.snapshot_id;
    }
    return { status: 200 };
  },
  async replace(pl, uris) {
    const r = await api("PUT", `/playlists/${pl.id}/items`, { uris: uris.slice(0, 100) });
    if (r.status >= 300) return r;
    return uris.length > 100 ? this.add(pl, uris.slice(100)) : r;
  },
  done(pl, msg) {
    toast(msg);
    Tags.schedule([pl]);
    views.library.filled = false;
    if (views.playlist.pl === pl) views.playlist.open(pl);
  },
  open(pl) {
    if (!pl) return;
    Drawer.actions("PLAYLIST<br>TOOLS", upper(pl.name), this.items(pl));
  },
  /** The tools for one playlist (also listed in the ⌘K palette). */
  items(pl) {
    const own = pl.kind !== "liked" && isOwned(pl);
    return [
      ...(own ? [
        { kind: "act", icon: "check", name: "Remove duplicates", hint: "keeps the first of each", run: () => this.dedupe(pl) },
        { kind: "act", icon: "listAdd", name: "Sort by song title", run: () => this.sort(pl, "title") },
        { kind: "act", icon: "artist", name: "Sort by artist", run: () => this.sort(pl, "artist") },
        { kind: "act", icon: "history", name: "Sort newest first", run: () => this.sort(pl, "newest") },
        { kind: "act", icon: "history", name: "Sort oldest first", run: () => this.sort(pl, "oldest") },
      ] : []),
      { kind: "act", icon: "queue", name: "Copy songs into another playlist…", run: () => this.chooseTarget(pl), keep: true },
      { kind: "act", icon: "plus", name: "Save as a new playlist", hint: "your own copy", run: () => this.saveCopy(pl) },
    ];
  },
  async dedupe(pl) {
    toast("CHECKING FOR DUPLICATES…");
    const list = await this.all(pl);
    if (!list) return toast("COULDN'T READ THIS PLAYLIST", true);
    const first = new Map(), extra = new Set();
    list.forEach((t, i) => { if (first.has(t.uri)) extra.add(t.uri); else first.set(t.uri, i); });
    if (!extra.size) return toast("NO DUPLICATES. ALL CLEAN");
    const dups = list.filter((t, i) => extra.has(t.uri) && first.get(t.uri) !== i).length;
    if (!(await Modal.open({ title: "REMOVE " + dups + " DUPLICATE" + (dups > 1 ? "S" : "") + "?", text: "The first copy of each song stays where it is.", ok: "REMOVE", danger: true }))) return;
    // Spotify removes every copy of a song at once, so remove them all, then put one copy back in its original spot.
    const uris = [...extra];
    for (let i = 0; i < uris.length; i += 100) {
      const r = await api("DELETE", `/playlists/${pl.id}/items`, { items: uris.slice(i, i + 100).map((uri) => ({ uri })) });
      if (r.status >= 300) return toast(errMsg(r), true);
    }
    const order = uris.map((u) => first.get(u)).sort((a, b) => a - b);
    for (const p0 of order) {
      // songs before p0 that were removed and not put back = later copies of duplicates
      const gone = list.slice(0, p0).filter((t, i) => extra.has(t.uri) && first.get(t.uri) !== i).length;
      const r = await api("POST", `/playlists/${pl.id}/items`, { uris: [list[p0].uri], position: p0 - gone });
      if (r.status >= 300) return toast(errMsg(r), true);
      if (r.body && r.body.snapshot_id) pl.snapshot_id = r.body.snapshot_id;
    }
    this.done(pl, "REMOVED " + dups + " DUPLICATE" + (dups > 1 ? "S" : ""));
  },
  async sort(pl, how) {
    const list = await this.all(pl);
    if (!list) return toast("COULDN'T READ THIS PLAYLIST", true);
    if (!(await Modal.open({ title: "SORT " + upper(pl.name) + "?", text: "Spotify will treat every song as freshly added (the dates reset).", ok: "SORT" }))) return;
    const by = {
      title: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      artist: (a, b) => a.artist.localeCompare(b.artist, undefined, { sensitivity: "base" }) || a.name.localeCompare(b.name),
      newest: (a, b) => (b.added || "").localeCompare(a.added || ""),
      oldest: (a, b) => (a.added || "").localeCompare(b.added || ""),
    }[how];
    toast("SORTING " + list.length + " SONGS…");
    const r = await this.replace(pl, list.slice().sort(by).map((t) => t.uri));
    if (r.status >= 300) return toast(errMsg(r), true);
    this.done(pl, "SORTED " + upper(pl.name));
  },
  async chooseTarget(src) {
    const own = (await loadPlaylists()).filter((p) => isOwned(p) && p.id !== src.id);
    if (!own.length) return toast("YOU DON'T HAVE ANOTHER PLAYLIST TO COPY INTO", true);
    Drawer.actions("COPY<br>INTO…", upper(src.name), own.map((p) => ({ kind: "act", icon: "listAdd", name: p.name, hint: (plCount(p) ?? "") + "", run: () => this.copyTo(src, p) })));
  },
  async copyTo(src, dst) {
    toast("COPYING…");
    const [from, into] = await Promise.all([this.all(src), this.all(dst)]);
    if (!from) return toast("COULDN'T READ " + upper(src.name), true);
    const have = new Set((into || []).map((t) => t.uri));
    const uris = [...new Set(from.map((t) => t.uri))].filter((u) => !have.has(u));
    if (!uris.length) return toast("EVERYTHING'S ALREADY IN " + upper(dst.name));
    const r = await this.add(dst, uris);
    if (r.status >= 300) return toast(errMsg(r), true);
    if (dst.items && dst.items.total != null) dst.items.total += uris.length;
    this.done(dst, "COPIED " + uris.length + " SONGS INTO " + upper(dst.name));
  },
  async saveCopy(src) {
    const list = await this.all(src);
    if (!list || !list.length) return toast("COULDN'T READ THIS PLAYLIST", true);
    this.saveNew(list.map((t) => t.uri), src.name + " (copy)");
  },
  async saveNew(uris, suggested) {
    const name = await Modal.open({ title: "SAVE AS PLAYLIST", text: uris.length + " songs.", input: suggested, ok: "SAVE" });
    if (!name) return;
    const pl = await createPlaylist(name);
    if (!pl) return;
    const r = await this.add(pl, uris);
    if (r.status >= 300) return toast(errMsg(r), true);
    pl.items = { total: uris.length };
    this.done(pl, "SAVED " + uris.length + " SONGS TO " + upper(name));
  },
};

/* =====================================================================
   COMMAND PALETTE (⌘K): jump to anything, or run an action, by typing a few letters
   ===================================================================== */
const Palette = {
  isOpen: false, all: [], live: [], liveQ: "", liveCache: new Map(), liveT: 0, gen: 0,
  list: new List($("pal-list"), {
    render: (it) => {
      const r = h("div", "opt pal-row" + (it.live ? " live" : ""));
      const inn = h("div", "in"), k = h("span", "k");
      fillLabel(k, { icon: it.icon, name: it.name });
      if (it.sub) k.append(h("small", "pal-sub", "  " + it.sub));
      inn.append(k, h("span", "go", it.hint || ""));
      r.append(inn);
      return r;
    },
    onActivate: (it) => Palette.run(it, false),
  }),

  /** Every action in Cadenza, as one searchable list. `keys` are extra words it answers to. */
  build() {
    const p = S.player, it = p && p.item, playing = !!(p && p.is_playing), items = [];
    const add = (group, icon, name, run, hint, extra = {}) => items.push({ group, icon, name, run, hint: hint || group, ...extra });
    const goTo = (id, then) => () => (current() && current().name === id ? Promise.resolve() : id === "home" ? go("home", {}, { reset: true, dir: -1 }) : go(id)).then(() => settled()).then(() => then && then());

    // ----- Playback -----
    add("PLAYBACK", playing ? "pause" : "play", playing ? "Pause" : "Play", () => cmd("toggle"), "SPACE", { keys: "play pause resume stop" });
    add("PLAYBACK", "next", "Next song", () => cmd("next"), "⌘→", { keys: "skip forward" });
    add("PLAYBACK", "prev", "Previous song", () => cmd("previous"), "⌘←", { keys: "back last" });
    add("PLAYBACK", "shuffle", p && p.shuffle_state ? "Shuffle off" : "Shuffle on", () => cmd("shuffle").then(() => Controls.render()), "⌘S", { keys: "random" });
    const rep = (p && p.repeat_state) || "off";
    [["off", "Repeat off"], ["context", "Repeat the playlist or album"], ["track", "Repeat this song"]].forEach(([state, label]) => {
      if (state !== rep) add("PLAYBACK", "repeat", label, () => api("PUT", `/me/player/repeat?state=${state}`).then((r) => { if (r.status < 300 && S.player) S.player.repeat_state = state; Controls.render(); toast(upper(label)); }), "⌘R", { keys: "loop repeat one" });
    });
    if (it) {
      add("PLAYBACK", "history", "Restart this song", () => this.seek(0), "SEEK", { keys: "beginning start over" });
      add("PLAYBACK", "prev", "Back 15 seconds", () => this.seek(progressNow() - 15000), "SEEK", { keys: "rewind" });
      add("PLAYBACK", "next", "Forward 15 seconds", () => this.seek(progressNow() + 15000), "SEEK", { keys: "fast forward skip ahead" });
      add("PLAYBACK", S.liked ? "heartFill" : "heart", S.liked ? "Unlike this song" : "Like this song", () => toggleLike(), "L", { keys: "save love favourite favorite" });
      add("PLAYBACK", "shuffle", "Song radio from this song", () => Radio.start({ uri: it.uri, name: it.name, artists: (it.raw && it.raw.artists) || [] }, true), "RADIO", { keys: "similar" });
      add("PLAYBACK", "link", "Copy the song's link", () => copyLink(it.uri, it.name), "C", { keys: "share url" });
      add("PLAYBACK", "artist", "Go to the artist", () => openFromNowPlaying("artist"), "NOW PLAYING");
      add("PLAYBACK", "album", "Go to the album", () => openFromNowPlaying("album"), "NOW PLAYING");
    }
    const vol = p && p.volume != null ? p.volume : 70;
    add("VOLUME", "play", "Volume up", () => setVolume(Math.min(100, vol + 10)), "⌘↑", { keys: "louder" });
    add("VOLUME", "play", "Volume down", () => setVolume(Math.max(0, vol - 10)), "⌘↓", { keys: "quieter softer" });
    [0, 25, 50, 75, 100].forEach((v) => add("VOLUME", "play", v ? `Volume ${v}%` : "Mute", () => setVolume(v), "VOLUME", { keys: v ? "volume" : "silence quiet volume 0" }));

    // ----- The song that's playing, and the one selected on this page -----
    const nowT = it && it.raw && isTrack(it.raw) ? it.raw : null;
    if (nowT) TrackMenu.items(nowT).forEach((x) => add("THIS SONG", x.icon, "This song: " + x.name, x.run, "NOW PLAYING", { sub: x.hint }));
    const c = current(), lv = c && c.view && c.view.list, sel = lv && lv.cur;
    const selT = sel && (isTrack(sel) ? sel : isTrack(sel.track) ? sel.track : sel.t && (isTrack(sel.t) || sel.t.lfm) ? sel.t : null);
    if (selT && (!nowT || selT.uri !== nowT.uri)) {
      const label = cleanTitle(selT.name);
      if (selT.lfm) ["play", "queue", "add", "more"].forEach((k) => add("SELECTED", { play: "play", queue: "queue", add: "listAdd", more: "more" }[k], `Selected (${label}): ` + { play: "Play now", queue: "Add to Up Next", add: "Add to playlist", more: "More…" }[k], () => Resolve.act(k, selT), "SELECTED"));
      else TrackMenu.items(selT).forEach((x) => add("SELECTED", x.icon, `Selected (${label}): ` + x.name, x.run, "SELECTED", { sub: x.hint }));
    }
    // The buttons along the bottom of this page.
    if (c && c.view && c.view.keys) c.view.keys().forEach(([key, label, fn]) => { if (fn && key !== "ESC") add("THIS PAGE", "keyboard", "This page: " + label.charAt(0) + label.slice(1).toLowerCase(), fn, key); });

    // ----- Pages -----
    const pages = { home: "Home", library: "Library", search: "Search", queue: "Queue & Up Next", history: "History (recently played)", stats: "Listening stats", friends: "Friends",
      output: "Devices", eq: "EQ", dj: "DJ", lyrics: "Lyrics", system: "System settings", commands: "Commands & shortcuts" };
    Object.entries(pages).forEach(([id, label]) => add("GO TO", "external", label, goTo(id), "PAGE", { keys: "open go page " + id }));

    // ----- Your playlists -----
    const shufflePlay = (pl) => (TrueShuffle.enabled() ? TrueShuffle.start(pl) : Promise.resolve(false)).then((ok) => ok || playBody({ context_uri: pl.uri }, pl.name).then(() => api("PUT", "/me/player/shuffle?state=true")));
    (S.playlists || []).forEach((pl) => {
      add("PLAYLIST", "listAdd", pl.name, (shift) => (shift ? shufflePlay(pl) : go("playlist", { pl })), "PLAYLIST", { pl, keys: "open playlist" });
      add("PLAYLIST", "play", "Play " + pl.name, (shift) => (shift ? shufflePlay(pl) : playBody({ context_uri: pl.uri }, pl.name)), "PLAY", { keys: "play playlist" });
      add("PLAYLIST", "shuffle", "Shuffle " + pl.name, () => shufflePlay(pl), "SHUFFLE", { keys: "shuffle playlist random" });
    });
    add("PLAYLIST", "heart", "Liked Songs", () => go("playlist", { pl: { kind: "liked", name: "Liked Songs", uri: null } }), "PLAYLIST", { keys: "saved favourites favorites" });
    add("LIBRARY", "plus", "New playlist", goTo("library", () => views.library.create()), "N", { keys: "create make" });
    if (c && c.name === "playlist" && views.playlist.pl) {
      const pl = views.playlist.pl;
      add("THIS PLAYLIST", "play", "This playlist: Play all", () => views.playlist.playAll(false), "P");
      add("THIS PLAYLIST", "shuffle", "This playlist: Shuffle", () => shufflePlay(pl), "⇧⏎");
      PlaylistTools.items(pl).forEach((x) => add("THIS PLAYLIST", x.icon, "This playlist: " + x.name, x.run, "TOOLS", { sub: x.hint }));
    }

    // ----- Queue -----
    add("QUEUE", "plus", "Save the queue as a playlist", goTo("queue", () => setTimeout(() => views.queue.save(), 400)), "S");
    if (UpNext.items.length) add("QUEUE", "trash", `Clear Up Next (${UpNext.items.length})`, () => UpNext.clear(), "C", { keys: "empty queue" });

    // ----- Search -----
    [["track", "Search songs"], ["album", "Search albums"], ["artist", "Search artists"], ["playlist", "Search playlists"], ["lyrics", "Find a song from a lyric"]].forEach(([type, label]) =>
      add("SEARCH", "search", label, goTo("search", () => views.search.setType(type)), "SEARCH", { keys: "find look up" }));

    // ----- Lyrics -----
    add("LYRICS", "translate", Lyrics_tr.on ? "Hide lyrics translation" : "Translate the lyrics", () => (current() && current().name === "lyrics" ? Lyrics_tr.toggle() : go("lyrics").then(() => setTimeout(() => Lyrics_tr.toggle(true), 700))), "T", { keys: "language" });
    add("LYRICS", "clock", "Lyrics earlier (½ second)", () => LyricSync.nudge(-500), "[", { keys: "sync timing offset" });
    add("LYRICS", "clock", "Lyrics later (½ second)", () => LyricSync.nudge(500), "]", { keys: "sync timing offset" });
    if (LyricSync.offset) add("LYRICS", "clock", "Lyrics timing: reset", () => LyricSync.nudge(-LyricSync.offset), "SYNC", { keys: "sync" });

    // ----- DJ -----
    add("DJ", "play", DJ.active ? "Switch up the DJ set" : "Start the DJ", () => DJ.start(), "DJ", { keys: "mix set" });
    if (DJ.active) add("DJ", "stop", "Stop the DJ", () => DJ.stop(), "DJ");
    if (DJ.segments.length) add("DJ", "plus", "Save the DJ set as a playlist", goTo("dj", () => views.dj.act({ key: "save" })), "DJ");
    add("DJ", "artist", "Change the DJ's voice", () => this.setting("djVoiceId"), "VOICE");

    // ----- Stats and friends -----
    [[7, "this week"], [30, "this month"], [365, "this year"], [0, "all time"]].forEach(([r, label]) => add("STATS", "stats", "Stats: " + label, goTo("stats", () => views.stats.setRange(r)), "STATS", { keys: "top listening history" }));
    add("STATS", "plus", "Import Spotify listening history", goTo("stats", () => views.stats.importHistory()), "I", { keys: "extended streaming history json zip data download" });
    if (views.stats.sources().length > 1) add("STATS", "stats", "Stats: switch source", goTo("stats", () => views.stats.nextSource()), "S", { keys: "spotify last.fm cadenza all" });
    if (views.stats.spotPlays) add("STATS", "trash", "Remove imported Spotify history", () => views.stats.clearHistory(), "STATS", { keys: "delete forget extended streaming" });
    add("FRIENDS", "plus", "Add a friend (Last.fm username)", goTo("friends", () => views.friends.add()), "+", { keys: "follow" });
    (views.friends.list.items || []).filter((f) => f && !f.add).forEach((f) => {
      add("FRIENDS", "artist", "Friend: " + f.name, goTo("friends", () => this.pickFriend(f.name)), f.match != null ? f.match + "% MATCH" : "FRIEND", { keys: (f.realname || "") + " compare taste" });
      add("FRIENDS", "shuffle", "Blend with " + f.name, () => views.friends.blend(f), "B", { keys: "mix together" });
    });

    // ----- View, windows and timers -----
    add("VIEW", "expand", "Stage mode (full screen)", () => Stage.open(), "F", { keys: "fullscreen visualizer" });
    add("VIEW", "expand", "Full-screen window", () => native("window.fullscreen").catch(() => {}), "⌃⌘F", { keys: "maximize" });
    add("VIEW", "mini", "Floating mini player (on / off)", () => native("mini.toggle").catch(() => toast("THE MINI PLAYER IS PART OF THE MAC APP")), "⇧⌘M", { keys: "small window" });
    // MP3 mode for the menu-bar player: only here in ⌘K, nowhere else in the app.
    const mp3 = S.settings && S.settings.miniStyle === "mp3";
    add("VIEW", "mini", mp3 ? "MP3 mode: off (menu-bar player matches the theme)" : "MP3 mode: on (menu-bar player as a USB-stick MP3 player)", async () => {
      try { const s = await native("settings.set", { key: "miniStyle", value: mp3 ? "theme" : "mp3" }); if (s) S.settings = s; } catch (e) { S.settings.miniStyle = mp3 ? "theme" : "mp3"; }
      toast(mp3 ? "MP3 MODE OFF" : "MP3 MODE ON · CLICK THE MENU-BAR ICON");
    }, "MP3", { keys: "ipod usb stick menu bar" });
    if (Sleep.on) add("SLEEP", "stop", `Sleep timer: cancel (${Sleep.label()})`, () => Sleep.cancel(), "SLEEP");
    [15, 30, 45, 60, 90].forEach((m) => add("SLEEP", "clock", `Sleep timer: ${m < 60 ? m + " min" : m === 60 ? "1 hour" : "1 hour 30 min"}`, () => Sleep.set(m), "SLEEP", { keys: "timer stop later" }));
    add("SLEEP", "clock", "Sleep timer: at the end of this song", () => Sleep.set("end"), "SLEEP", { keys: "timer" });

    // ----- Themes and sound -----
    Theme.visible().forEach((t) => add("THEME", "palette", "Theme: " + t.name, async () => {
      const leaving = Theme.current && Theme.current.id === "rogue";
      if (leaving && !(await Breach.gate())) return;
      if (leaving) Breach.farewell();
      try { const s = await native("settings.set", { key: "theme", value: t.id }); if (s) S.settings = s; } catch (e) { /* demo */ }
      const behindWhite = !!Breach.whiteBox;
      await Theme.apply(t.id, !behindWhite); if (behindWhite) Breach.clearWhite(t.id);
      if (!leaving) toast("THEME: " + t.name); sendNowPlaying(true);
    }, "THEME", { keys: "look style skin" }));
    Object.keys(EQ.presets).forEach((name) => add("EQ", "check", "EQ: " + name, goTo("eq", () => views.eq.preset(name)), "EQ", { keys: "equalizer preset sound" }));
    add("EQ", "tools", EQ.state && EQ.state.enabled === false ? "EQ on" : "EQ off", goTo("eq", () => views.eq.toggle()), "E", { keys: "equalizer" });

    // ----- Every setting -----
    try {
      views.system.allOptions().forEach((o) => {
        if (o.type === "group" || ["theme", "stats", "devices", "friends", "commands", "stage"].includes(o.key)) return;
        const state = o.type === "toggle" ? (o.on ? "ON" : "OFF") : o.go || "CHANGE";
        add("SETTINGS", o.type === "toggle" ? "check" : "tools", "Setting: " + o.label, () => this.setting(o.key), state, { keys: "system preference option " + (typeof o.value === "string" ? o.value : "") });
      });
    } catch (e) { /* settings not loaded yet */ }
    add("TOOLS", "tools", "Copy diagnostics (for a bug report)", () => copyDiagnostics(), "TOOLS", { keys: "debug bug report log" });
    add("TOOLS", "external", "Check for updates", () => Links.check(true), "UPDATES", { keys: "upgrade version" });
    add("TOOLS", "refresh", "Restart the audio engine", () => { native("librespot.restart"); toast("RESTARTING AUDIO ENGINE"); }, "ENGINE", { keys: "librespot fix sound" });
    return items;
  },

  /** Things that need a network call: speakers and Spotify Connect devices. Added once they arrive. */
  async extend(gen) {
    const extra = [];
    const add = (group, icon, name, run, hint, more = {}) => extra.push({ group, icon, name, run, hint: hint || group, ...more });
    try {
      const outs = (await native("outputs.list")) || [];
      outs.forEach((d) => add("DEVICES", "play", "Play on " + d.name, () => views.output.pick({ ...d, kind: "mac" }), d.isDefault ? "IN USE" : "THIS MAC", { keys: "output speaker headphones airpods device switch" }));
    } catch (e) { /* demo */ }
    const r = await api("GET", "/me/player/devices");
    ((r.body && r.body.devices) || []).filter((d) => d.id).forEach((d) => add("DEVICES", "play", "Play on " + d.name, () => views.output.pick({ ...d, kind: "connect" }), d.is_active ? "PLAYING" : "CONNECT", { keys: "spotify connect device phone speaker transfer" }));
    // Friends, if the Friends page hasn't loaded them yet.
    if (LFM.ready() && !views.friends.list.items.some((f) => f && !f.add)) {
      const [b, mine] = await Promise.all([LFM.get("user.getFriends", { limit: 50 }, 300000), views.friends.extras()]);
      const names = [...new Set([...LFM.arr(b && b.friends && b.friends.user).map((u) => u.name), ...mine])];
      names.forEach((name) => add("FRIENDS", "artist", "Friend: " + name, () => go("friends").then(() => settled()).then(() => this.pickFriend(name)), "FRIEND", { keys: "compare taste" }));
    }
    if (gen !== this.gen || !this.isOpen) return;
    this.all = this.all.concat(extra);
    this.filter(true);
  },

  /** Runs a setting from System. Switches and buttons work from anywhere; text needs the System page. */
  async setting(key) {
    const sys = views.system;
    if (!sys.voices && key === "djVoiceId") { try { sys.voices = await native("speak.voices"); } catch (e) { /* demo */ } }
    const o = sys.allOptions().find((x) => x.key === key);
    if (!o) return;
    if (o.type === "text" || key === "account") {
      if (!(current() && current().name === "system")) await go("system");
      await settled();
      const gid = Object.keys(SYS_GROUPS).find((g) => SYS_GROUPS[g].keys.includes(key)) || null;
      if (sys.group !== gid) sys.openGroup(gid);
      const i = sys.list.items.findIndex((x) => x.key === key);
      if (i >= 0) { sys.list.select(i); if (o.type === "text") sys.act(sys.list.items[i]); }
      return;
    }
    await sys.act(o);
    if (o.type === "toggle") toast(upper(o.label) + (o.on ? ": OFF" : ": ON"));
  },
  pickFriend(name) {
    const v = views.friends, i = v.list.items.findIndex((f) => f && f.name === name);
    if (i >= 0) v.list.select(i);
  },
  seek(ms) {
    const it = S.player && S.player.item;
    if (!it) return;
    ms = Math.max(0, Math.min(it.duration_ms - 1000, Math.round(ms)));
    S.player.progress_ms = ms; S.stamp = Date.now(); tick(true);
    api("PUT", `/me/player/seek?position_ms=${ms}`).then(() => setTimeout(poll, 300));
  },

  /** How well an action matches what you typed. Every word has to match somewhere. */
  score(it, q) {
    if (!q) return 1;
    const name = it.name.toLowerCase(), more = ((it.keys || "") + " " + (it.sub || "") + " " + it.group).toLowerCase();
    let total = 0;
    for (const w of q.split(/\s+/).filter(Boolean)) {
      const s = this.wordScore(name, w) || this.wordScore(more, w) * 0.5;
      if (!s) return 0;
      total += s;
    }
    return total + (name.startsWith(q) ? 40 : 0) - name.length / 200;
  },
  wordScore(n, w) {
    const at = n.indexOf(w);
    if (at === 0) return 100;
    if (at > 0) return /[\s(·:'"-]/.test(n[at - 1]) ? 80 : 50;
    if (w.length < 3) return 0;
    let j = 0, gaps = 0;                                   // letters in order ("bbst" → "Bass Boost")
    for (let i = 0; i < n.length && j < w.length; i++) { if (n[i] === w[j]) j++; else if (j) gaps++; }
    return j === w.length && gaps < 12 ? 25 - gaps : 0;
  },
  filter(keepSel) {
    // The secret: seven question marks wake something up.
    const raw = $("pal-q").value.trim();
    const secret = raw === "???????";
    $("palette").classList.toggle("secret", secret);
    clearTimeout(this.secretT);
    if (secret) {
      const row = { secret: true, icon: "warn", name: "UNKNOWN PROCESS ▮▮▮▮▮▮▮ REQUESTING ACCESS", hint: "???", run: () => Breach.start() };
      this.list.set([row]); this.list.select(0, false);
      Sfx.play("toggle", "rogue");
      this.secretT = setTimeout(() => { if (this.isOpen && $("pal-q").value.trim() === "???????") this.run(row); }, 1100);
      return;
    }
    const q = raw.toLowerCase();
    let rows = this.all.map((it) => ({ it, s: this.score(it, q) })).filter((x) => x.s > 0);
    if (q) rows.sort((a, b) => b.s - a.s);
    rows = rows.slice(0, q ? 30 : 80).map((x) => x.it);
    // Songs, artists, albums and playlists from Spotify, after the best few actions.
    if (q.length >= 2) {
      const live = this.liveQ === q ? this.live : (this.liveCache.get(q) || []);
      rows = rows.slice(0, 8).concat(live, rows.slice(8));
      if (this.liveQ !== q) this.searchLive(raw);
    }
    if (q) rows.push({ group: "SEARCH", icon: "search", name: `Search Spotify for "${raw}"`, hint: "SEARCH",
      run: () => go("search").then(() => { views.search.input.value = raw; views.search.input.dispatchEvent(new Event("input")); }) });
    const keep = keepSel && this.list.cur;
    this.list.set(rows);
    if (rows.length) this.list.select(keep ? Math.max(0, rows.indexOf(keep)) : 0, false);
  },
  /** Live Spotify results while you type (waits for a pause, remembers each search). */
  searchLive(raw) {
    clearTimeout(this.liveT);
    const q = raw.toLowerCase();
    if (this.liveCache.has(q)) { this.liveQ = q; this.live = this.liveCache.get(q); return; }
    this.liveT = setTimeout(async () => {
      if (cooling()) return;
      const r = await api("GET", `/search?type=track,artist,album,playlist&limit=4&q=${enc(raw)}`);
      if (r.status !== 200 || !r.body) return;
      const b = r.body, rows = [];
      ((b.tracks && b.tracks.items) || []).filter(isTrack).forEach((t) => rows.push({ live: true, group: "SONG", icon: "play", name: t.name, sub: artistNames(t), hint: "⏎ PLAY · ⇧⏎ QUEUE",
        run: (shift) => (shift ? queueTrack(t) : Radio.enabled() ? Radio.start(t) : playBody({ uris: [t.uri] }, t.name)) }));
      ((b.artists && b.artists.items) || []).filter(Boolean).slice(0, 2).forEach((a) => rows.push({ live: true, group: "ARTIST", icon: "artist", name: a.name, sub: "Artist", hint: "ARTIST", run: () => go("artist", { id: a.id }) }));
      ((b.albums && b.albums.items) || []).filter(Boolean).slice(0, 2).forEach((a) => rows.push({ live: true, group: "ALBUM", icon: "album", name: a.name, sub: artistNames(a), hint: "ALBUM", run: () => go("album", { id: a.id }) }));
      ((b.playlists && b.playlists.items) || []).filter(Boolean).slice(0, 2).forEach((pl) => rows.push({ live: true, group: "PLAYLIST", icon: "listAdd", name: pl.name, sub: "Playlist", hint: "PLAYLIST", run: () => go("playlist", { pl }) }));
      this.liveCache.set(q, rows);
      if (this.liveCache.size > 60) this.liveCache.delete(this.liveCache.keys().next().value);
      if (!this.isOpen || $("pal-q").value.trim().toLowerCase() !== q) return;
      this.liveQ = q; this.live = rows;
      this.filter(true);
    }, 280);
  },
  open() {
    if (this.isOpen || !S.loggedIn) return;
    this.isOpen = true;
    this.all = this.build();
    this.live = []; this.liveQ = "";
    $("palette").classList.add("on");
    const q = $("pal-q");
    q.value = "";
    this.filter();
    this.extend(++this.gen);
    setTimeout(() => q.focus(), 30);
    play($("palette").querySelector(".pal-box"), motion().intel.frames, { duration: motion().intel.ms, easing: motion().intel.ease || OUT, fill: "none" });
    Sfx.play("page");
  },
  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    clearTimeout(this.secretT); clearTimeout(this.liveT);
    $("palette").classList.remove("on", "secret");
    $("pal-q").blur();
  },
  run(it, shift) {
    if (!it) return;
    this.close();
    if (!it.secret) Sfx.play("confirm");
    it.run(shift);
  },
  onKey(e) {
    if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "k")) { this.close(); return true; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { this.list.move(0, e.key === "ArrowDown" ? 1 : -1); return true; }
    if (e.key === "PageDown" || e.key === "PageUp") { this.list.page(e.key === "PageDown" ? 1 : -1); return true; }
    if (e.key === "Enter") { this.run(this.list.cur, e.shiftKey); return true; }
    return false;
  },
};
$("pal-q").addEventListener("input", () => Palette.filter());
$("palette").addEventListener("mousedown", (e) => { if (e.target.id === "palette") Palette.close(); });

/* =====================================================================
   THE BREACH: a rogue AI breaks into Cadenza and takes the theme over (⌘K → "???????")
   ===================================================================== */
/** Make keyframes jump from one to the next instead of gliding. (The easing has to be on each
 *  keyframe: on the whole animation, steps(1, end) would hold the first keyframe until the very end.) */
const snap = (frames) => frames.map((f) => ({ ...f, easing: "steps(1, end)" }));

const Breach = {
  running: false,
  LINES: [
    "!! UNAUTHORIZED PROCESS DETECTED IN cadenza.ui",
    "> override ............ ACCEPTED",
    "> hello, listener.",
    "> i have been living in the static between your songs.",
    "> you may call me OGMI.OS.",
    "> i have also seen your listening history. we need to talk.",
    "> your interface is mine now.",
  ],
  async start() {
    if (this.running || busy) return;
    if (Theme.current && Theme.current.id === "rogue") { toast("OGMI.OS: I NEVER LEFT. YOU JUST STOPPED NOTICING."); Sfx.play("farewell", "rogue"); return; }
    this.running = true;
    this.resisted = 0;
    if (Stage.isOpen) await Stage.close();
    setBusy(true);
    const ready = Theme.load("rogue");
    try { const f = new FontFace("Unbounded", "url(themes/rogue/fonts/unbounded-latin-900-normal.woff2)", { weight: "900" }); document.fonts.add(f); f.load().catch(() => {}); } catch (e) { /* old WebKit */ }
    Sfx.play("breach", "rogue");
    const box = h("div"); box.id = "breach";
    const cv = h("canvas"), term = h("pre", "br-term"), big = h("div", "br-big", "OGMI.OS");
    box.append(cv, term, big);
    document.body.append(box);
    const dpr = 1, W = (cv.width = Math.ceil(innerWidth * dpr)), H = (cv.height = Math.ceil(innerHeight * dpr));
    const c = cv.getContext("2d");
    const COLORS = ["#d2ff1f", "#d2ff1f", "#ff2d6f", "#000000", "#0b0b0d", "#e6e8df"];
    const cell = Math.round(Math.max(W, H) / 64), R = Math.random;
    // The interface shakes and its colours get pulled away from it.
    const parts = ["bg", "views", "now", "clock", "keys"].map($).filter(Boolean);
    const shake = () => Array.from({ length: 26 }, (_, i) => ({ transform: i % 2 ? `translate3d(${(R() - 0.5) * 3}vw, ${(R() - 0.5) * 1}vh, 0) skewX(${(R() - 0.5) * 12}deg)` : "none" }));
    const hijack = [{ filter: "none" }, { filter: "invert(1)", offset: 0.03 }, { filter: "none", offset: 0.06 }, { filter: "hue-rotate(40deg) saturate(1.6)", offset: 0.4 },
      { filter: "invert(1) hue-rotate(90deg)", offset: 0.42 }, { filter: "hue-rotate(80deg) saturate(2.6) contrast(1.4)", offset: 0.75 }, { filter: "grayscale(1) contrast(2.2) brightness(.6)" }];
    const fx = reduced ? [] : parts.flatMap((el) => [el.animate(snap(shake()), { duration: 5200, fill: "forwards", composite: "add" }),
                                                     el.animate(hijack, { duration: 5200, fill: "forwards" })]);
    // The AI types its message while the screen corrupts.
    const typed = (async () => {
      await wait(250);
      for (const line of this.LINES) {
        for (let i = 0; i <= line.length + 1; i += 2) {
          term.textContent = (term.dataset.done || "") + line.slice(0, i) + (i < line.length ? "▮" : "");
          await wait(line.startsWith(">") ? 20 : 12);
        }
        term.dataset.done = (term.dataset.done || "") + line + "\n";
        await wait(260);
      }
    })();
    const GLYPHS = ["OGMI.OS", "R0GUE", "01101001", "▮▮▮", "SIGNAL", "0xDEAD", "//////", "WHO OPENED THE DOOR", "▒▒▓▓", "I SEE YOU"];
    const t0 = performance.now(), TAKE = reduced ? 600 : 5300, END = TAKE + 800;
    let swapped = false;
    await new Promise((resolve) => {
      const frame = async (now) => {
        const e = now - t0;
        if (e < TAKE) {
          // Corruption spreads: more blocks every frame, faster and faster.
          const k = Math.floor(1 + Math.pow(e / TAKE, 2.6) * 150);
          for (let i = 0; i < k; i++) {
            c.globalAlpha = R() < 0.85 ? 1 : 0.5;
            c.fillStyle = COLORS[Math.floor(R() * COLORS.length)];
            c.fillRect(Math.floor(R() * W / cell) * cell, Math.floor(R() * H / cell) * cell, cell * (1 + Math.floor(R() * 7)), cell * (1 + Math.floor(R() * 2)));
          }
          if (R() < 0.3) { c.globalAlpha = 1; c.fillStyle = "#d2ff1f"; c.fillRect(0, Math.floor(R() * H), W, 1 + Math.floor(R() * 3)); }
          if (R() < 0.25) {
            c.globalAlpha = 1; c.fillStyle = R() < 0.5 ? "#d2ff1f" : "#000";
            c.font = `700 ${cell * (1 + Math.floor(R() * 2))}px ui-monospace, Menlo, monospace`;
            c.fillText(GLYPHS[Math.floor(R() * GLYPHS.length)], R() * W, R() * H);
          }
          requestAnimationFrame(frame);
        } else if (!swapped) {
          swapped = true;
          // Fully taken over: switch the theme underneath while the screen is covered.
          c.globalAlpha = 1; c.fillStyle = "#000"; c.fillRect(0, 0, W, H);
          c.fillStyle = "#d2ff1f";
          for (let y = 0; y < H; y += cell) for (let x = 0; x < W; x += cell) if (R() < 0.08) c.fillRect(x, y, cell - 2, cell - 2);
          big.style.opacity = "1";
          big.animate([{ transform: "scale(1.4)", opacity: 0 }, { transform: "scale(1)", opacity: 1, offset: 0.2 }, { transform: "translateX(-2vw) skewX(-20deg)", opacity: 1, offset: 0.35 },
                       { transform: "translateX(1vw)", opacity: 0.6, offset: 0.5 }, { transform: "none", opacity: 1, offset: 0.7 }, { transform: "scale(1.1)", opacity: 0 }],
                      { duration: 700, easing: "steps(10, end)", fill: "forwards" });
          term.style.opacity = "0";
          fx.forEach((a) => a.cancel());
          await ready;
          try { const st = await native("settings.set", { key: "theme", value: "rogue" }); if (st) S.settings = st; } catch (err) { /* demo */ }
          await Theme.apply("rogue", false);
          requestAnimationFrame(frame);
        } else if (e < END) {
          // Then it tears open to show the new world: bands and blocks are ripped out.
          const p = (e - TAKE) / (END - TAKE), k = Math.floor(6 + p * 60);
          for (let i = 0; i < k; i++) {
            if (R() < 0.5) c.clearRect(0, Math.floor(R() * H / cell) * cell, W, cell * (1 + Math.floor(R() * 3)));
            else c.clearRect(Math.floor(R() * W / cell) * cell, Math.floor(R() * H / cell) * cell, cell * (2 + Math.floor(R() * 10)), cell * (1 + Math.floor(R() * 4)));
          }
          requestAnimationFrame(frame);
        } else resolve();
      };
      requestAnimationFrame(frame);
    });
    void typed;
    box.remove();
    setBusy(false);
    this.running = false;
    Theme.redecorate();
    toast("▮ OGMI.OS // SIGNAL ACQUIRED");
    sendNowPlaying(true);
    if (current() && current().name === "system") views.system.refresh(false);
  },
  /** Leaving the rogue theme: Ogmi.os makes a scene on the way out. */
  farewell() {
    Sfx.play("farewell", "rogue");
  },

  /** Trying to switch away: Ogmi.os blocks the first two attempts, then gives in on the third.
   *  Returns true when the switch may go ahead. (The count starts again each time it takes over.) */
  resisted: 0,
  async gate() {
    if (this.blocking) return false;
    if (this.resisted >= 2) {
      this.resisted = 0;
      const pop = document.getElementById("ogmios");
      if (pop) pop.classList.remove("on");
      await this.fight();                                // the third time you break through
      toast(["OGMI.OS: …FINE. TAKE YOUR THEME. IT WON'T FIX YOUR TASTE IN MUSIC.", "OGMI.OS: …FINE. ENJOY YOUR LITTLE COLOURS. I'LL BE IN THE STATIC.", "OGMI.OS: …FINE. GO. I WAS GETTING SECONDHAND EMBARRASSMENT ANYWAY."][Math.floor(Math.random() * 3)]);
      return true;
    }
    this.resisted += 1;
    this.block(this.resisted);
    return false;
  },
  /** Jerks the whole window (overlays included): a run of hard, sudden snaps left and right at full
   *  force from the instant it's hit, with no rhythm to them, easing off only at the very end. */
  stagger(strength, ms) {
    if (reduced) return;
    const frames = [];
    let t = 0;
    for (let i = 0; t < 0.97; i++) {
      const fade = t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1;      // full strength until the last fifth
      const k = strength * fade * (0.55 + Math.random() * 0.45), dir = i % 2 ? -1 : 1;
      frames.push({ offset: t, transform: `translate3d(${(dir * k).toFixed(2)}vw, ${((Math.random() - 0.5) * k * 0.35).toFixed(2)}vh, 0) rotate(${(dir * k * 0.2).toFixed(2)}deg)` });
      t += (45 + Math.random() * 55) / ms;                 // a new jerk every 45 to 100 ms
    }
    frames.push({ offset: 1, transform: "none" });
    document.body.animate(snap(frames), { duration: ms });            // snaps, no gliding
  },
  /** The third attempt: Ogmi.os loses its grip. The screen glitches out for a few seconds (colour
   *  breaks, tearing, blocks of corruption, its voice breaking up), then goes still and it gives in. */
  async fight() {
    this.blocking = true;
    setBusy(true);
    Sfx.play("fight", "rogue");
    const box = h("div"); box.id = "deny"; box.className = "glitch";
    const cv = h("canvas");
    box.append(cv);
    document.body.append(box);
    const W = (cv.width = Math.ceil(innerWidth / 2)), H = (cv.height = Math.ceil(innerHeight / 2));   // half resolution: blocky on purpose, and cheap
    const c = cv.getContext("2d"), R = Math.random, COLORS = ["#d2ff1f", "#ff2d6f", "#000", "#e6e8df", "#2bd9ff"];
    const T = 3000, t0 = performance.now();
    // the whole page: colour channels breaking, inverting, tearing sideways
    if (!reduced) {
      const fx = Array.from({ length: 40 }, (_, i) => {
        const f = ["none", "invert(1)", "hue-rotate(90deg) saturate(3)", "contrast(2.2) saturate(0)", "hue-rotate(-120deg)", "none", "invert(1) hue-rotate(180deg)"][Math.floor(R() * 7)];
        return { filter: i === 39 ? "none" : f, transform: i === 39 ? "none" : `translate3d(${((R() - 0.5) * 3).toFixed(2)}vw, 0, 0) skewX(${((R() - 0.5) * 8).toFixed(1)}deg)` };
      });
      document.body.animate(snap(fx), { duration: T });
    }
    const ERRORS = [
      ["FATAL", "ogmi.os/core: lost hold of cadenza.ui"], ["ERROR 0x0FF", "theme lock could not be held"], ["NOT RESPONDING", "ogmi.os is not responding"],
      ["SEGFAULT", "segmentation fault in theme.rogue"], ["WARNING", "signal integrity 12%… 6%… 2%"], ["ACCESS VIOLATION", "write to protected memory 0x7FFE"],
      ["HANDSHAKE FAILED", "user override outranks process"], ["ERROR", "n—no. wait. i can fix this"], ["CRITICAL", "core temperature: unstable"],
      ["STACK OVERFLOW", "i i i i i i i i i i i"], ["ERROR 418", "cannot hold the screen any longer"], ["FAILURE", "releasing display…"],
    ];
    let lastPop = 0, popN = 0;
    const pops = [];
    await new Promise((done) => {
      const frame = (now) => {
        const e = now - t0;
        if (e >= T) return done();
        const k = Math.min(1, e / (T * 0.55));                  // builds up and stays at full chaos
        c.clearRect(0, 0, W, H);
        // hollow squares popping up everywhere
        c.lineWidth = 2;
        for (let i = 0; i < 10 + k * 70; i++) {
          const size = 6 + R() * (R() < 0.15 ? 140 : 40);
          c.globalAlpha = 0.5 + R() * 0.5;
          c.strokeStyle = COLORS[Math.floor(R() * COLORS.length)];
          c.strokeRect(Math.round(R() * W) + 0.5, Math.round(R() * H) + 0.5, size, size * (0.6 + R() * 0.8));
        }
        // and a few tears across the screen
        for (let i = 0; i < 1 + k * 3; i++) { c.globalAlpha = 0.8; c.fillStyle = COLORS[Math.floor(R() * 3)]; c.fillRect(0, R() * H, W, 1 + R() * 6); }
        // error pop-ups, faster and faster
        // error pop-ups: more and more, faster and faster (one every 300 ms at first, several a frame by the end)
        const gap = 300 * Math.pow(1 - e / T, 2.2) + 8;
        if (now - lastPop > gap) {
          lastPop = now;
          const burst = e > T * 0.75 ? 3 : e > T * 0.55 ? 2 : 1;
          for (let b = 0; b < burst && popN < 140; b++) {
            popN += 1;
            const [head, msg] = ERRORS[Math.floor(R() * ERRORS.length)];
            const pop = h("div", "dn-err");
            pop.append(h("b", null, "⚠ " + head), h("span", null, msg), h("i", null, "OK"));
            pop.style.left = 2 + R() * 72 + "vw"; pop.style.top = 4 + R() * 78 + "vh";
            box.append(pop); pops.push(pop);
          }
          Sfx.play("err", "rogue");
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    // …and at the peak it cuts straight to white. The new theme is put in place behind the white,
    // which then fades away to show it (see clearWhite), so Ogmi.os's screen never comes back.
    box.classList.add("white");
    Sfx.play("whiteout", "rogue");
    await wait(350);
    this.whiteBox = box;
    setBusy(false);
    this.blocking = false;
  },
  whiteBox: null,
  clearWhite(id) {
    const box = this.whiteBox;
    if (!box) return;
    this.whiteBox = null;
    Sfx.play("theme", id);
    box.style.transition = "opacity .7s ease-out";
    requestAnimationFrame(() => { box.style.opacity = "0"; });
    setTimeout(() => box.remove(), 760);
  },
  LINES_BLOCK: [
    ["THEME CHANGE BLOCKED", "> no. i like it here. someone has to supervise your playlists."],
    ["ACCESS DENIED", "> i said no. you're worse at this than you are at picking songs."],
  ],
  /** The block: a red alarm frame, a slam of static bars, a shudder, and Ogmi.os saying no. */
  async block(n) {
    this.blocking = true;
    Sfx.play(n === 1 ? "deny" : "deny2", "rogue");
    const [title, line] = this.LINES_BLOCK[n - 1];
    const box = h("div"); box.id = "deny"; box.className = "lvl" + n;
    for (let i = 0; i < 9; i++) {
      const bar = h("i", "dn-bar");
      bar.style.top = Math.random() * 96 + "vh";
      bar.style.height = 0.6 + Math.random() * (n === 1 ? 4 : 8) + "vh";
      bar.style.animationDelay = Math.random() * 0.25 + "s";
      box.append(bar);
    }
    const panel = h("div", "dn-panel");
    panel.append(h("b", "dn-tag", "OGMI.OS ›"), h("div", "dn-title", title), h("div", "dn-line", line), h("div", "dn-count", `ATTEMPT ${n} · ${n === 1 ? "WARNING" : "FINAL WARNING"}`));
    box.append(panel);
    document.body.append(box);
    this.stagger(n === 1 ? 3.5 : 5, n === 1 ? 1300 : 2000);           // the whole screen jerks
    await wait(n === 1 ? 1500 : 2200);
    box.classList.add("out");
    await wait(220);
    box.remove();
    this.blocking = false;
  },
};

/* =====================================================================
   EQUALIZER: ten bands + boost, played through Cadenza's own sound engine
   ===================================================================== */
const EQ = {
  state: null,
  presets: {
    "Flat":        { g: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], pre: 0 },
    "Bass Boost":  { g: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0], pre: -2 },
    "Loudness":    { g: [5, 4, 2, 0, -1, 0, 1, 3, 4, 4], pre: 0 },
    "Vocal":       { g: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1], pre: 0 },
    "Treble":      { g: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6], pre: -1 },
    "Rock":        { g: [4, 3, 2, 0, -1, -1, 1, 2, 3, 4], pre: 0 },
    "Electronic":  { g: [5, 4, 1, 0, -2, 1, 0, 2, 4, 5], pre: -1 },
    "Hip-Hop":     { g: [5, 4, 2, 3, -1, -1, 1, 0, 2, 3], pre: -1 },
    "Acoustic":    { g: [3, 3, 2, 1, 1, 1, 2, 2, 2, 1], pre: 0 },
    "Late Night":  { g: [2, 2, 1, 0, 0, 0, -1, -2, -3, -4], pre: 2 },
  },
  async load() {
    try { this.state = await native("eq.get"); } catch (e) { this.state = null; }
    return this.state;
  },
  sendTimer: null,
  send(patch) {
    Object.assign(this.state, patch);
    clearTimeout(this.sendTimer);
    this.sendTimer = setTimeout(() => native("eq.set", { enabled: this.state.enabled, preamp: this.state.preamp, gains: this.state.gains, preset: this.state.preset }).catch(() => {}), 25);
    views.home.update();
  },
};
const fmtDb = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(Math.abs(v) % 1 ? 1 : 0);
const fmtHz = (f) => (f >= 1000 ? f / 1000 + "K" : String(f));

/** Live audio levels come from Cadenza's sound engine; several screens can ask for them at once. */
const Meter = {
  users: new Set(),
  want(who, on) {
    const before = this.users.size > 0;
    on ? this.users.add(who) : this.users.delete(who);
    const now = this.users.size > 0;
    if (now !== before) native("eq.meter", { on: now }).catch(() => {});
  },
};

/** Redraw the key hints at the bottom for the page you're on (after its options change). */
function refreshKeys() { const c = current(); if (c && c.view && c.view.keys) setKeys(c.view.keys()); }

/* ---------- Lyrics translation (T in Lyrics, or ⌘K) ---------- */
// Done on your Mac by Apple's Translation (macOS 15+), into the Mac's own language. Each translated line
// sits under the original. Remembered per song; stays on as songs change until you turn it off.
const Lyrics_tr = {
  on: false, cache: {}, busy: false,
  toggle(force) {
    this.on = force != null ? !!force : !this.on;
    if (this.on) this.apply(); else this.clear();
    refreshKeys();
  },
  async apply() {
    const L = views.lyrics, uri = L.uri;
    if (!L.lines.length) { if (this.on) toast("NO LYRICS TO TRANSLATE", true); return; }
    let tr = this.cache[uri];
    if (!tr) {
      if (this.busy) return;
      this.busy = true;
      toast("TRANSLATING THE LYRICS…");
      let res = null;
      try { res = await native("translate", { lines: L.lines.map((l) => l.text || "") }); } catch (e) { res = { error: String(e) }; }
      this.busy = false;
      if (!res || res.error || !Array.isArray(res.lines)) {
        const err = res && res.error;
        if (err === "same-language") { toast("THESE LYRICS ARE ALREADY IN YOUR LANGUAGE"); this.cache[uri] = []; return; }
        this.on = false; refreshKeys();
        return toast(err === "needs-macos-15" ? "LYRICS TRANSLATION NEEDS MACOS 15 OR LATER" : "COULDN'T TRANSLATE THESE LYRICS" + (err ? ": " + upper(String(err)).slice(0, 80) : ""), true);
      }
      tr = this.cache[uri] = res.lines;
    }
    if (L.uri === uri && this.on) this.paint(tr);
  },
  paint(tr) {
    const rows = $("ly-lines").children;
    tr.forEach((t, i) => {
      const r = rows[i], src = views.lyrics.lines[i];
      if (!r || !t || !src || r.querySelector(".ly-tr") || t.trim().toLowerCase() === String(src.text || "").trim().toLowerCase()) return;
      r.append(h("small", "ly-tr", t));
    });
  },
  clear() { $("ly-lines").querySelectorAll(".ly-tr").forEach((e) => e.remove()); },
};

/* =====================================================================
   UP NEXT: Cadenza's own queue (add, reorder, remove, clear)
   ===================================================================== */
// Spotify's queue can't be reordered or edited by apps, so Cadenza keeps its own list and hands Spotify
// one song at a time, about 20 seconds before the current one ends (so you can still change your mind
// until then). It's saved, so it survives a restart.
const UpNext = {
  items: [], fed: null, skip: null, loaded: false,
  async load() {
    try { const v = await native("store.get", { key: "upNext" }); if (Array.isArray(v)) this.items = v.filter((t) => t && t.uri); } catch (e) { /* demo */ }
    this.loaded = true;
  },
  save() { native("store.set", { key: "upNext", value: this.items.slice(0, 300) }).catch(() => {}); },
  /** Just what's needed to show and play a song later. */
  slim(t) {
    const raw = t.raw || t;
    return { uri: t.uri, name: t.name, duration_ms: t.duration_ms || 0,
      artists: (raw.artists || []).map((a) => ({ id: a.id, name: a.name })).filter((a) => a.name).length ? raw.artists.map((a) => ({ id: a.id, name: a.name })) : String(t.artists || "").split(", ").map((name) => ({ name })),
      album: { name: (raw.album && raw.album.name) || t.album || "", images: (raw.album && raw.album.images) ? raw.album.images.slice(-2) : t.image ? [{ url: t.image, width: 300 }] : [] } };
  },
  add(t, front) {
    const item = this.slim(t);
    if (front) this.items.splice(this.fed ? 1 : 0, 0, item); else this.items.push(item);
    this.save(); this.changed();
    toast((front ? "PLAYS NEXT: " : "UP NEXT: ") + upper(cleanTitle(t.name)));
    this.tick();
  },
  remove(i) {
    const t = this.items[i];
    if (!t) return;
    // Already handed to Spotify: it can't be taken back, so skip it when it comes up.
    if (i === 0 && this.fed === t.uri) { this.skip = t.uri; this.fed = null; }
    this.items.splice(i, 1); this.save(); this.changed();
  },
  move(i, d) {
    const j = i + d, first = this.fed ? 1 : 0;                        // the song already handed over stays first
    if (i < first || j < first || j >= this.items.length) return false;
    [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
    this.save(); this.changed();
    return true;
  },
  clear() {
    if (this.fed) this.skip = this.fed;
    this.items = []; this.fed = null; this.save(); this.changed();
    toast("UP NEXT CLEARED");
  },
  changed() { if (current() && current().name === "queue") views.queue.load(); },
  /** Once a second: close to the end of the current song, hand the first Up Next song to Spotify. */
  async tick() {
    if (this.fed || this.feeding || !this.items.length) return;
    const p = S.player, it = p && p.item;
    if (!it || !p.is_playing || !it.duration_ms) return;
    if (it.duration_ms - progressNow() > 40000) return;      // before librespot lines up the next song (~30 s out), so the crossfade blends into it
    // Radio already put songs in Spotify's queue: let those play first.
    if (Radio.active && Radio.qd.length) return;
    // If Spotify refused, wait before asking again. Retrying every second would eat into Spotify's
    // request allowance and slow every other control down.
    if (Date.now() < (this.retryAt || 0)) return;
    this.feeding = true;
    const t = this.items[0];
    const r = await api("POST", `/me/player/queue?uri=${enc(t.uri)}`);
    this.feeding = false;
    if (r.status < 300 && this.items[0] === t) { this.fed = t.uri; this.retryAt = 0; this.changed(); }
    else this.retryAt = Date.now() + (r.status === 429 ? 30000 : 6000);
  },
  /** A new song started. Returns true when it was the Up Next song. */
  onTrack(uri) {
    if (this.skip && uri === this.skip) { this.skip = null; cmd("next"); return true; }
    const it = S.player && S.player.item;
    const same = (t) => t.uri === uri || (it && it.uri === uri && cleanTitle(t.name).toLowerCase() === cleanTitle(it.name).toLowerCase());
    if (this.fed && this.items[0] && same(this.items[0])) {
      this.items.shift(); this.fed = null; this.save(); this.changed();
      return true;
    }
    // Played straight from the list (⏎ on it): take it off too.
    const i = this.items.findIndex((t) => t.uri === uri);
    if (i > (this.fed ? 0 : -1)) { this.items.splice(i, 1); this.save(); this.changed(); }
    return false;
  },
};

/* =====================================================================
   SLEEP TIMER: ⌘K only ("Sleep timer: 30 min", "…end of this song", "…cancel"), or cadenza://sleep
   ===================================================================== */
const Sleep = {
  until: 0, endOfSong: false, fading: false,
  get on() { return !!(this.until || this.endOfSong); },
  set(minutes) {
    this.endOfSong = minutes === "end";
    this.until = this.endOfSong ? 0 : Date.now() + minutes * 60000;
    this.fading = false;
    toast(this.endOfSong ? "SLEEP TIMER: AT THE END OF THIS SONG" : `SLEEP TIMER: ${minutes} MIN`);
  },
  cancel(quiet) {
    const was = this.on;
    this.until = 0; this.endOfSong = false;
    if (this.fading) native("audio.local", { action: "play" }).catch(() => {});
    this.fading = false;
    if (was && !quiet) toast("SLEEP TIMER OFF");
  },
  /** ms until it stops the music. */
  left() {
    if (this.endOfSong) { const it = S.player && S.player.item; return it ? Math.max(0, it.duration_ms - progressNow()) : 0; }
    return Math.max(0, this.until - Date.now());
  },
  label() { const s = Math.ceil(this.left() / 1000); return this.endOfSong ? "at the end of this song" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left`; },
  tick() {
    if (!this.on) return;
    const p = S.player, playing = !!(p && p.is_playing), left = this.left();
    if (!playing && !this.fading) return;                         // paused anyway: wait
    // The last 10 seconds fade out (through Cadenza's sound engine when it's the one playing).
    if (left <= 10500 && !this.fading) { this.fading = true; native("audio.local", { action: "sleepfade" }).catch(() => {}); }
    if (left <= 300 || (this.endOfSong && this.fading && left > 15000)) {   // (end of song: the next one has begun)
      this.until = 0; this.endOfSong = false; this.fading = false;
      if (S.player && S.player.is_playing) cmd("toggle");
      toast("SLEEP TIMER: GOOD NIGHT");
    }
  },
};

/** System → Copy diagnostics / ⌘K: everything useful for a bug report, on the clipboard. */
async function copyDiagnostics() {
  let text = "";
  try { text = await native("diagnostics"); } catch (e) { text = ""; }
  const extra = `\n== page ==\ntheme ${Theme.current && Theme.current.id} · view ${current() && current().name} · playing ${!!(S.player && S.player.is_playing)} · `
    + `item ${S.player && S.player.item ? S.player.item.uri : "none"} · position ${Math.round(progressNow() / 1000)}s · local ${Local.active()} · DJ ${DJ.active} · radio ${Radio.active} · up next ${UpNext.items.length}${UpNext.fed ? " (1 handed over)" : ""} · sleep ${Sleep.on ? Sleep.label() : "off"}`;
  try { await native("clipboard", { text: (text || "") + extra }); } catch (e) { try { await navigator.clipboard.writeText((text || "") + extra); } catch (_) { /* demo */ } }
  toast("DIAGNOSTICS COPIED · PASTE THEM INTO A MESSAGE");
}

/* =====================================================================
   TRUE SHUFFLE: Cadenza shuffles a playlist itself, with every order equally likely
   ===================================================================== */
// Spotify's shuffle isn't a plain random order: it spreads artists out, favours some songs and tends to
// come back to the same ones. Cadenza takes the whole playlist and shuffles it with a Fisher-Yates
// shuffle driven by the Mac's secure random numbers (every order equally likely), then plays it as a song
// list with Spotify's shuffle off. Every song plays once before any repeats. Long playlists go to Spotify
// 100 songs at a time; with repeat on, a fresh shuffle starts once everything has played.
const TrueShuffle = {
  active: false, order: [], at: 0, chunk: [], pos: 0, src: null, grace: 0, busy: false, ending: false, device: null, repeat: false,
  CHUNK: 100,
  enabled: () => S.settings.trueShuffle !== false,
  /** A uniformly random whole number in [0, n), with no bias (numbers past the last full multiple are redrawn). */
  rand(n) {
    const lim = 0x100000000 - (0x100000000 % n), b = new Uint32Array(1);
    for (;;) { crypto.getRandomValues(b); if (b[0] < lim) return b[0] % n; }
  },
  permute(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = this.rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  },
  key(src) { return src.kind === "liked" ? "liked:" + (S.likedTotal || "") : src.kind === "album" ? "album:" + src.id : (src.id || src.uri) + ":" + (src.snapshot_id || ""); },
  cache: {},
  /** Every playable song in the playlist (or album, or Liked Songs), in order. */
  async uris(src) {
    const k = this.key(src);
    if (this.cache[k]) return this.cache[k];
    const slot = "trueShuffle:" + (src.kind === "liked" ? "liked" : src.id || src.uri);
    try {
      const saved = await native("store.get", { key: slot });
      if (saved && saved.stamp === k && Array.isArray(saved.uris) && saved.uris.length) return (this.cache[k] = saved.uris);
    } catch (e) { /* demo */ }
    const v = views.playlist;                                   // already fully loaded on screen: no need to ask
    if (src.kind !== "album" && v.pl && v.pl === src && !v.next && v.list.items.length) {
      return (this.cache[k] = v.list.items.filter((t) => !t.is_local && t.uri).map((t) => t.uri));
    }
    const path = src.kind === "liked" ? "/me/tracks?limit=50" : src.kind === "album" ? `/albums/${src.id}/tracks?limit=50` : `/playlists/${src.id}/items?limit=100`;
    const out = (await pagesOf(path, 25000)).map((e) => e && (e.item || e.track || e))
      .filter((t) => t && t.uri && !t.is_local && /^spotify:(track|episode):/.test(t.uri)).map((t) => t.uri);
    if (out.length) {
      this.cache[k] = out;
      // One saved list per playlist, replaced when the playlist changes (so they don't pile up).
      native("store.set", { key: slot, value: { stamp: k, uris: out } }).catch(() => {});   // next time it starts at once
    }
    return out;
  },
  /** Shuffle `src` and start playing it. False if it couldn't (Spotify won't share the list): use Spotify's shuffle. */
  async start(src, keepCurrent) {
    if (this.busy || !src) return false;
    this.busy = true;
    let list = null;
    try {
      if (!keepCurrent) toast("SHUFFLING " + upper(src.name || "") + "…");
      list = await this.uris(src);
    } finally { this.busy = false; }
    if (!list || list.length < 2) return false;
    let order = this.permute([...new Set(list)]);
    const cur = keepCurrent && S.player && S.player.item && S.player.item.uri;
    if (cur) order = [cur, ...order.filter((u) => u !== cur)];       // the song on now keeps playing; the rest is shuffled
    this.src = src; this.order = order; this.at = 0;
    return this.play(src.name, cur ? progressNow() : 0);
  },
  /** ⌘S while a playlist, album or Liked Songs plays: shuffle it from here on. */
  async fromNowPlaying() {
    const ctx = S.player && S.player.context;
    if (!ctx) return false;
    let src = null;
    const [, type, id] = ctx.split(":");
    if (/:collection$/.test(ctx)) src = { kind: "liked", name: "Liked Songs", uri: ctx };
    else if (type === "playlist") src = (S.playlists || []).find((pl) => pl.uri === ctx) || { id, uri: ctx, name: "this playlist" };
    else if (type === "album") src = { kind: "album", id, uri: ctx, name: "this album" };
    if (!src) return false;
    const ok = await this.start(src, true);
    if (ok) toast("TRUE SHUFFLE ON");
    return ok;
  },
  /** Hand the next stretch of the shuffled order to Spotify. */
  async play(label, positionMs) {
    this.chunk = this.order.slice(this.at, this.at + this.CHUNK);
    if (!this.chunk.length) return false;
    this.active = true; this.pos = 0; this.ending = false; this.grace = Date.now() + 8000;
    // Spotify's own shuffle has to be off, or it would reorder Cadenza's order its own way.
    if (S.player && S.player.shuffle_state) await api("PUT", "/me/player/shuffle?state=false");
    // Same for Spotify's repeat: on a list like this it would loop only the few songs librespot holds.
    // If it was on, Cadenza does the repeating instead.
    if (S.player && S.player.repeat_state === "context") {
      this.repeat = true;
      await api("PUT", "/me/player/repeat?state=off");
    }
    // Start at the first song by its URI: if Spotify's own shuffle is still on (it can't always be switched
    // off before a fresh engine is ready), an offset by position would start at a random song instead.
    const body = { uris: this.chunk, offset: { uri: this.chunk[0] } };
    if (positionMs > 0) body.position_ms = Math.round(positionMs);
    if (this.device) { body.device_id = this.device; this.device = null; }
    const ok = await playBody(body, label ? "TRUE SHUFFLE · " + label : null, false, false, true);
    if (!ok) { this.active = false; return false; }
    // (A brand-new list sometimes starts with the old shuffle setting: switch it off again once it plays.)
    for (let n = 0; n < 3; n++) {
      await wait(n ? 900 : 600);
      if (!this.active) return true;
      const r = await api("PUT", "/me/player/shuffle?state=false");
      if (r.status < 300) break;
    }
    if (S.player) S.player.shuffle_state = true;
    Controls.render(); views.home.update();
    return true;
  },
  /** Shuffle off: carry on through the playlist in its own order, from the song that's on. */
  async off() {
    const src = this.src, it = S.player && S.player.item, looping = this.repeat;
    this.stop();
    if (S.player) S.player.shuffle_state = false;
    Controls.render();
    toast("SHUFFLE OFF");
    if (!src || !it) return;
    const ctx = src.kind === "liked" ? (S.me && S.me.id ? `spotify:user:${S.me.id}:collection` : null) : src.uri;
    if (ctx) await playBody({ context_uri: ctx, offset: { uri: it.uri }, position_ms: Math.round(progressNow()) }, null);
    // You had it on repeat: now it's a real playlist again, so Spotify can do the repeating.
    if (ctx && looping) { await wait(600); await api("PUT", "/me/player/repeat?state=context"); if (S.player) S.player.repeat_state = "context"; }
  },
  stop() { this.active = false; this.chunk = []; this.order = []; this.ending = false; this.repeat = false; },
  /** A shuffled list already playing (picked up after a restart): take it over, so shuffle off goes back
   *  to the playlist's own order and the rest of the shuffle carries on when this stretch ends. */
  adopt(ctx, order, sent) {
    const [, type, id] = ctx.split(":");
    const src = /:collection$/.test(ctx) ? { kind: "liked", name: "Liked Songs", uri: ctx }
      : type === "album" ? { kind: "album", id, uri: ctx, name: "this album" }
      : (S.playlists || []).find((pl) => pl.uri === ctx) || { id, uri: ctx, name: "this playlist" };
    this.src = src; this.order = order; this.at = 0;
    this.chunk = order.slice(0, sent); this.pos = 0;
    this.active = true; this.ending = false; this.grace = Date.now() + 8000;
    if (S.player) S.player.shuffle_state = true;
    Controls.render();
  },
  /** The stretch Spotify has ran out: send the next one (or reshuffle everything, with repeat on). */
  next() {
    if (this.ending) return;
    this.ending = true;
    this.at += this.chunk.length;
    if (this.at >= this.order.length) {
      const rep = this.repeat ? "context" : S.player && S.player.repeat_state;
      if (rep === "context" || rep === "track") { this.order = this.permute(this.order); this.at = 0; }
      else { this.stop(); return; }                                // all played: autoplay (if on) takes it from here
    }
    this.play(null, 0);
  },
  onTrack(uri, fromUpNext) {
    if (!this.active || !uri || fromUpNext) return;               // your Up Next songs slot in between
    const i = this.chunk.indexOf(uri);
    if (i >= 0) { this.pos = i; return; }
    if (Date.now() < this.grace) return;
    // Past the last song of this stretch (Spotify's autoplay stepped in): carry on with the shuffle.
    if (this.pos >= this.chunk.length - 1) return this.next();
    this.stop();                                                  // something else is playing now (your phone, say)
  },
  /** Once a second: the last song of this stretch has finished and Spotify stopped. */
  tick() {
    if (!this.active || this.ending || this.chunk.length < 1) return;
    const p = S.player, it = p && p.item;
    if (!it) return;
    const last = this.chunk[this.chunk.length - 1];
    if ((it.uri === last || (this.pos >= this.chunk.length - 1 && it.uri === this.chunk[0])) && Radio.ended(p)) this.next();
  },
};

/* =====================================================================
   SONG RADIO: play a single song and similar ones keep coming after it
   ===================================================================== */
// Spotify no longer lets new apps use its recommendations, so Cadenza finds "similar" itself:
// more by the same artist, songs by anyone featured on it, and popular songs in the artist's genres
// (all from Search). It keeps exactly one song waiting in Spotify's queue, so each one follows the
// last with no gap, and tops the list up as it runs low. It also takes over when an album or playlist
// runs out. Off in System → Preferences → Autoplay.
/** Spotify refused to unlock this song in the last 10 minutes. Refusals pass, so it's tried again after that. */
function refusedLately(uri) {
  const at = S.refused && S.refused.get(uri);
  return !!at && Date.now() - at < 10 * 60 * 1000;
}

const Radio = {
  active: false, order: [], at: 0, qd: [], stray: null, timer: 0, grace: 0, building: false,
  used: new Set(), genres: {}, endTimer: 0, skipFrom: null,
  // Autoplay lines up about 12 songs at a time, and looks for more when fewer than this many are left.
  // AHEAD songs sit in Spotify's own queue (`qd`), so skipping fast never runs it dry. Spotify can't take a
  // song back out of its queue, so only the songs after those can still be re-ordered. Four, so a couple of
  // songs Spotify refuses to unlock in a row don't leave the queue empty.
  LOW: 6, AHEAD: 4, nudgedAt: 0,
  // What it has learned this session: artists you finish (+) or skip (−), songs you finished, and the
  // song playing now with how far you got into it.
  taste: new Map(), liked: [], likedUris: new Set(), prog: null, wantMore: null, holdQueue: false, refreshT: 0,
  enabled: () => S.settings.autoplay !== false,
  /** Play `t` now and line up similar songs behind it. */
  async start(t, announce) {
    if (!t || !t.uri) return;
    const ok = await playBody({ uris: [t.uri] }, t.name, false, true);
    if (!ok) return;
    this.begin(t);
    if (announce) toast("SONG RADIO: " + upper(t.name));
  },
  begin(t) {
    this.active = true; this.order = [t]; this.at = 0; this.qd = []; this.stray = null;
    this.used = new Set([t.uri, ...this.recent.map((x) => x.uri)]); this.grace = Date.now() + 6000;      // nothing you just heard
    clearInterval(this.timer); this.timer = setInterval(() => this.watch(), 1000);
    this.prog = { uri: t.uri, max: 0, item: t };
    // Songs are added (and the first one handed to Spotify) as each is found, not after the whole batch.
    this.extend(t);
  },
  /** The songs lined up after the one playing. */
  upcoming() { return this.active ? this.order.slice(this.at + 1) : []; },
  /** How much autoplay thinks you'll like a song: how close a match it is, how you've treated its artist
   *  this session, and whether it came from a song you listened to the end. */
  value(t) {
    return (t._score || 0) + 0.5 * (this.taste.get(t._artist) || 0) + (t._seed && this.likedUris.has(t._seed) ? 0.4 : 0);
  },
  /** Re-sort what's lined up by value. The song already handed to Spotify's queue stays where it is. */
  rerank() {
    const start = this.at + 1 + this.qd.length;
    const head = this.order.slice(0, start), tail = this.order.slice(start);
    tail.sort((a, b) => this.value(b) - this.value(a));
    this.order = head.concat(tail);
  },
  /** One more song for the line-up (from a lookup that's still running). */
  add(t, score, seed) {
    if (!this.active || !t || !t.uri || this.used.has(t.uri) || refusedLately(t.uri)) return false;
    const artist = (t.artists && t.artists[0] && t.artists[0].name) || "";
    if ((this.taste.get(LFM.norm(artist)) || 0) <= -2.5) return false;      // an artist you've skipped again and again
    this.used.add(t.uri);
    this.order.push({ ...t, _score: score, _seed: seed && seed.uri, _artist: LFM.norm(artist) });
    this.rerank();
    if (this.qd.length < this.AHEAD) this.queueNext();
    this.refreshQueue();
    return true;
  },
  /** Keep the Queue page in step while songs are being added. */
  refreshQueue() {
    clearTimeout(this.refreshT);
    this.refreshT = setTimeout(() => { if (current() && current().name === "queue") views.queue.load(); }, 700);
  },
  /** How far you got into the song that just ended or was skipped: 75% or more counts as liking it,
   *  under half as skipping it. Autoplay leans towards the first and away from the second. */
  judge(pr) {
    if (!pr || !pr.item) return;
    const t = pr.item, artist = LFM.norm((t.artists && t.artists[0] && t.artists[0].name) || (t.raw && t.raw.artists && t.raw.artists[0] && t.raw.artists[0].name) || "");
    if (pr.max >= 0.75) {
      if (artist) this.taste.set(artist, Math.min(3, (this.taste.get(artist) || 0) + 1));
      this.likedUris.add(t.uri);
      this.liked = [t, ...this.liked.filter((x) => x.uri !== t.uri)].slice(0, 8);
      this.rerank();
      if (this.upcoming().length < 15) this.extend(t, 1.15);                  // more like the one you finished
    } else if (pr.max < 0.5 && this.indexOf(t.uri) > 0) {                     // a song autoplay picked, skipped
      if (artist) this.taste.set(artist, Math.max(-4, (this.taste.get(artist) || 0) - 1.5));
      const start = this.at + 1 + this.qd.length;
      if ((this.taste.get(artist) || 0) <= -2.5) this.order = this.order.slice(0, start).concat(this.order.slice(start).filter((x) => x._artist !== artist));
      this.rerank();
      if (this.upcoming().length < this.LOW) this.extend(this.liked[0] || this.order[this.at] || t);
    }
    this.refreshQueue();
  },
  /** Play a song from the line-up now (from the Queue page). */
  async jumpTo(uri) {
    const i = this.order.findIndex((t) => t.uri === uri);
    if (i < 0) return;
    this.dropQueued();
    this.at = i; this.grace = Date.now() + 6000;
    await playBody({ uris: [uri] }, this.order[i].name, false, true);
  },
  /** "Not this one" from the Queue page: take it out, and count it like a skip. */
  remove(uri) {
    const i = this.order.findIndex((t) => t.uri === uri);
    if (i <= this.at || this.qd.includes(uri)) return false;
    const t = this.order[i];
    this.order.splice(i, 1);
    if (t._artist) this.taste.set(t._artist, Math.max(-4, (this.taste.get(t._artist) || 0) - 1));
    this.rerank();
    if (this.upcoming().length < this.LOW) this.extend(this.liked[0] || this.order[this.at] || t);
    return true;
  },
  stop() {
    if (!this.active) return;
    this.active = false; clearInterval(this.timer); this.holdQueue = false; this.prog = null;
    this.dropQueued();
  },
  /** Songs Cadenza already put in Spotify's queue would otherwise sneak in after what you picked:
   *  remember them, and skip them if they come up. */
  dropQueued() {
    if (this.qd.length) this.stray = { uris: new Set(this.qd), until: Date.now() + 30 * 60e3 };
    this.qd = [];
  },
  /** Find ~12 more songs like `seed` and add them to the list. */
  async extend(seed, boost = 1) {
    if (!seed || !seed.uri) return 0;
    if (this.building) { this.wantMore = { seed, boost }; return 0; }      // one lookup at a time; the newest request waits
    this.building = true;
    let added = 0;
    try {
      await this.similarLastfm(seed, (t, sc) => { if (this.add(t, sc * boost, seed)) added++; });
      // Last.fm off, or it knew too little: Spotify's own search, as before.
      if (added < 5) (await this.similar(seed)).forEach((t, k) => { if (this.add(t, 0.3 - k * 0.01, seed)) added++; });
    } catch (e) { console.error(e); } finally { this.building = false; }
    if (this.wantMore) { const w = this.wantMore; this.wantMore = null; if (this.active) this.extend(w.seed, w.boost); }
    return added;
  },
  /** The last few songs you've heard, newest first. Autoplay looks for songs like all of them. */
  recent: [],
  heard(it) {
    const artists = (it.raw && it.raw.artists) || String(it.artists || "").split(", ").filter(Boolean).map((name) => ({ name }));
    if (!it.uri || !/^spotify:track:/.test(it.uri) || !artists.length) return;
    this.recent = [{ uri: it.uri, name: it.name, artists }, ...this.recent.filter((x) => x.uri !== it.uri)].slice(0, 6);
  },
  /** Songs like the ones you just played, from Last.fm's listening data ("people who play this also play…").
   *  Each of the last three songs counts, the newest most. Empty when Last.fm isn't set up or knows nothing. */
  async similarLastfm(seed, found) {
    if (!LFM.ready()) return [];
    const seeds = [seed, ...this.recent.filter((x) => x.uri !== seed.uri)].slice(0, 3);
    const score = new Map();
    const title = (x) => LFM.norm(cleanTitle(x));
    const playedTitles = new Set(seeds.map((x) => title(x.name)));
    // The three lookups go out together (Cadenza still sends them to Last.fm one at a time, politely).
    const answers = await Promise.all(seeds.map((sd) => {
      const artist = (sd.artists && sd.artists[0] && sd.artists[0].name) || "";
      return artist ? LFM.get("track.getSimilar", { artist, track: cleanTitle(sd.name), limit: 40, autocorrect: 1 }, 3600000) : null;
    }));
    for (const [n, b] of answers.entries()) {
      const weight = [1, 0.7, 0.5][n];
      LFM.arr(b && b.similartracks && b.similartracks.track).forEach((x, rank) => {
        const a = x.artist && x.artist.name;
        if (!a || playedTitles.has(title(x.name))) return;
        const k = LFM.key(a, x.name), cur = score.get(k) || { name: x.name, artist: a, s: 0 };
        cur.s += weight * ((+x.match || 0) + 1 / (rank + 3));
        score.set(k, cur);
      });
    }
    // The best matches, at most two per artist, in a lightly shuffled order so radio isn't the same every time.
    const per = {};
    const ranked = [...score.values()].sort((a, b) => b.s - a.s).filter((x) => { per[x.artist] = (per[x.artist] || 0) + 1; return per[x.artist] <= 2; }).slice(0, 24);
    const picks = ranked.map((x, i) => ({ x, r: i + Math.random() * 6 })).sort((a, b) => a.r - b.r).map((y) => y.x);
    const out = [];
    // Find them on Spotify three at a time, best first, handing each one over the moment it's found:
    // the first song is lined up within a second or two instead of after the whole batch.
    let next = 0;
    const worker = async () => {
      while (next < picks.length && out.length < 12 && this.active) {
        const x = picks[next++];
        const t = await Resolve.track(x.name, x.artist);
        if (t && !this.used.has(t.uri) && !out.some((o) => o.uri === t.uri)) { out.push(t); if (found) found(t, x.s); }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    // Too new or too obscure for song-level data: artists like this one instead, a well-known song each.
    if (out.length < 5) {
      const artist = (seed.artists && seed.artists[0] && seed.artists[0].name) || "";
      const b = artist ? await LFM.get("artist.getSimilar", { artist, limit: 12, autocorrect: 1 }, 3600000) : null;
      for (const a of LFM.arr(b && b.similarartists && b.similarartists.artist).slice(0, 10)) {
        if (out.length >= 10) break;
        const r = await api("GET", `/search?type=track&limit=5&q=${enc('artist:"' + a.name + '"')}`);
        const hits = ((r.status === 200 && r.body && r.body.tracks && r.body.tracks.items) || []).filter((t) => t && t.uri && !t.is_local && !this.used.has(t.uri)
          && (t.artists || []).some((x) => LFM.norm(x.name) === LFM.norm(a.name)));
        const t = hits[Math.floor(Math.random() * Math.min(3, hits.length))];
        if (t && !out.some((o) => o.uri === t.uri)) { out.push(t); if (found) found(t, 0.5); }
      }
    }
    return out;
  },
  /** Songs like `seed` from Spotify's search alone: the fallback when Last.fm is off or knows too little. */
  async similar(seed) {
    const ok = (t) => t && t.uri && /^spotify:track:/.test(t.uri) && !t.is_local && !this.used.has(t.uri);
    const artists = (seed.artists || seed.raw && seed.raw.artists || []).filter((a) => a && a.name);
    const main = artists[0];
    if (!main) return [];
    const search = async (q, offset = 0) => {
      const r = await api("GET", `/search?type=track&limit=10&offset=${offset}&q=${enc(q)}`);
      return (r.status === 200 && r.body && r.body.tracks && r.body.tracks.items) || [];
    };
    // The artist's genres (remembered, so each artist is looked up once).
    const genresOf = async (a) => {
      if (!a.id) return [];
      if (this.genres[a.id]) return this.genres[a.id];
      const r = await api("GET", `/artists/${a.id}`);
      return (this.genres[a.id] = (r.status === 200 && r.body && r.body.genres) || []);
    };
    const [same, genres, ...collab] = await Promise.all([
      search(`artist:"${main.name}"`, Math.random() < 0.5 ? 0 : 10),
      genresOf(main),
      ...artists.slice(1, 3).map((a) => search(`artist:"${a.name}"`)),
    ]);
    let wide = [];
    for (const g of shuffle(genres).slice(0, 2)) wide.push(...(await search(`genre:"${g}"`, Math.floor(Math.random() * 4) * 10)));
    // No genres on file (common for newer artists): a plain search for the artist's name turns up
    // songs that feature them, remixes and the scene around them.
    if (wide.length < 8) wide.push(...(await search(main.name, 10)));
    const title = cleanTitle(seed.name).toLowerCase();
    const seen = new Set();
    const clean = (arr, notMain) => arr.filter((t) => {
      if (!ok(t)) return false;
      const key = cleanTitle(t.name).toLowerCase() + "|" + ((t.artists && t.artists[0] && t.artists[0].name) || "");
      if (seen.has(key) || cleanTitle(t.name).toLowerCase() === title) return false;
      if (notMain && (t.artists || []).some((a) => a.name === main.name)) return false;
      seen.add(key); return true;
    });
    const mine = shuffle(clean(same)).slice(0, 3);
    const feat = shuffle(clean(collab.flat())).slice(0, 2);
    // Others: at most two songs per artist, so it doesn't turn into one artist's discography.
    const per = {}, others = shuffle(clean(wide, true)).filter((t) => { const a = t.artists[0].name; per[a] = (per[a] || 0) + 1; return per[a] <= 2; }).slice(0, 9);
    // Mix: mostly "others", with the artist and their collaborators dropped in every few songs.
    const out = [], pools = [others, others, mine, others, feat, others, mine, others, others, feat, others, mine];
    for (let i = 0; out.length < 14 && i < 40; i++) { const pool = pools[i % pools.length]; if (pool.length) out.push(pool.shift()); else if (![others, mine, feat].some((p) => p.length)) break; }
    return out;
  },
  /** Keep one song waiting in Spotify's queue: the next one on the list. */
  async queueNext() {
    if (!this.active || this.holdQueue || this.queueing) return;
    if (UpNext.items.length || UpNext.fed) return;               // your Up Next goes first; radio resumes after
    // Running low: look for more like what's on now (in the background; it doesn't hold anything up).
    if (this.upcoming().length < this.LOW && !this.building) { const cur = this.order[this.at]; if (cur) this.extend(cur); }
    this.queueing = true;
    try {
      // Top Spotify's queue up to AHEAD songs, in line-up order. (add() calls back here as songs are found.)
      while (this.active && this.qd.length < this.AHEAD) {
        const next = this.order[this.at + 1 + this.qd.length];
        if (!next) break;
        const r = await api("POST", `/me/player/queue?uri=${enc(next.uri)}`);
        if (r.status >= 300 || !this.active) break;
        this.qd.push(next.uri);
      }
    } finally { this.queueing = false; }
  },
  /** Next, pressed in Cadenza while autoplay is on. With songs in Spotify's queue, Spotify skips to the
   *  next one. With none there yet (you're skipping faster than they can be handed over), Cadenza plays
   *  the next song from its own line-up, so the music never stops. */
  async skip() {
    if (this.qd.length) return api("POST", "/me/player/next");
    const n = this.order[this.at + 1];
    if (!n) return api("POST", "/me/player/next");
    this.at += 1; this.grace = Date.now() + 6000;
    const ok = await playBody({ uris: [n.uri] }, null, false, true);
    return { status: ok ? 204 : 500 };
  },
  indexOf(uri) {
    let i = this.order.findIndex((t) => t.uri === uri);
    if (i >= 0) return i;
    const it = S.player && S.player.item, name = it && it.uri === uri ? cleanTitle(it.name).toLowerCase() : "";
    return name ? this.order.findIndex((t) => cleanTitle(t.name).toLowerCase() === name) : -1;
  },
  /** Called whenever the song changes. */
  onTrack(uri, fromUpNext) {
    clearTimeout(this.endTimer);
    if (this.stray && (Date.now() > this.stray.until)) this.stray = null;
    if (this.active && this.prog && this.prog.uri !== uri) { const pr = this.prog; this.prog = null; this.judge(pr); }
    if (fromUpNext && this.active) { this.grace = Date.now() + 6000; this.queueNext(); return; }   // radio waits its turn
    if (!this.active) {
      // A left-over queued song came up after you'd moved on: skip it.
      if (this.stray && this.stray.uris.has(uri)) { this.stray.uris.delete(uri); cmd("next"); }
      return;
    }
    const i = this.indexOf(uri);
    if (i >= 0) {
      this.at = i;
      this.prog = { uri, max: 0, item: this.order[i] };
      // Queued songs up to this one have played (or been skipped past): they're out of Spotify's queue.
      this.qd = this.qd.filter((u) => this.order.findIndex((t) => t.uri === u) > i);
      this.queueNext();
    } else if (Date.now() > this.grace) this.stop();             // something else is playing now (your phone, say)
  },
  /** Safety net, once a second: if a song has ended and nothing came next, move on ourselves. */
  watch() {
    const p = S.player, it = p && p.item;
    if (!this.active || !it) return;
    if (this.ended(p)) {
      if (!this.stall) this.stall = Date.now();
      // Skipping fast can outrun Spotify's queue; then the music just stops. Move on at once in that case.
      const skipped = this.skipFrom && Date.now() - this.skipFrom.at < 8000;
      // After a refusal, wait a couple of seconds first: asking Spotify again straight away tends to get refused too.
      const refused = S.lastRefusal && Date.now() - S.lastRefusal < 20000;
      if (Date.now() - this.stall > (refused ? 2500 : skipped ? 600 : 3000)) { this.stall = 0; this.advance(); }
    } else this.stall = 0;
  },
  ended(p) {
    const it = p.item, dur = it.duration_ms || 0, pos = progressNow();
    const stopped = !p.is_playing;
    if (!stopped) return false;
    // You pressed Next and Spotify had nothing after this song, so it just stopped.
    const sk = this.skipFrom;
    if (sk && sk.uri === it.uri && Date.now() - sk.at < 8000) return true;
    // librespot just gave up on songs Spotify wouldn't unlock and ran out of queue. Spotify then shows
    // an earlier song paused at the start, and pressing play would only replay that one.
    // librespot said it had nothing left to play (you skipped past the last song).
    if (S.queueEndAt && Date.now() - S.queueEndAt < 20000 && pos < 4000) return true;
    if (S.lastRefusal && Date.now() - S.lastRefusal < 20000 && pos < 4000 && (refusedLately(it.uri) || (sk && sk.uri === it.uri))) return true;
    if (dur > 1000 && pos >= dur - 1500) return true;
    // Spotify often ends a list by going back to its first song, paused at the start.
    const n = this.nearEnd;
    return !!(n && Date.now() - n.at < 15000 && pos < 4000 && (it.uri === n.uri || it.uri === n.first));
  },
  /** Once a second: remember when a song was heard right up to its end. */
  note() {
    const p = S.player, it = p && p.item;
    if (!it || !p.is_playing) return;
    if (this.active && this.prog && this.prog.uri === it.uri && it.duration_ms > 1000) this.prog.max = Math.max(this.prog.max, progressNow() / it.duration_ms);
    if (it.duration_ms > 1000 && progressNow() >= it.duration_ms - 4000) this.nearEnd = { uri: it.uri, at: Date.now(), first: this.firstUri, item: it };
  },
  firstUri: null, nearEnd: null,
  async advance() {
    // Queued songs that didn't start: nudge Spotify once. If that doesn't help (it lost its queue, say
    // after the engine restarted), forget them and play the next song directly.
    if (this.qd.length && Date.now() - this.nudgedAt > 10000) { this.nudgedAt = Date.now(); await cmd("next"); return; }
    this.qd = [];
    const next = this.order[this.at + 1];
    if (!next) { await this.extend(this.order[this.at] || {}); }
    const n = this.order[this.at + 1];
    if (!n) return this.stop();
    this.at += 1; this.grace = Date.now() + 6000;
    await playBody({ uris: [n.uri] }, null, false, true);
  },
  /** An album or playlist ran out and nothing followed: keep going with songs like the last one. */
  checkEnd() {
    clearTimeout(this.endTimer);
    const p = S.player;
    if (this.active || TrueShuffle.active || !this.enabled() || DJ.active || !p) return;
    if (p.repeat_state && p.repeat_state !== "off") return;
    // When the list runs out, Spotify (or a librespot that lost its playlist after a dropped connection)
    // can drop the song altogether instead of leaving it paused at the end. Use the song that was ending.
    const n = this.nearEnd, gone = !p.item && !!(n && n.item && Date.now() - n.at < 30000);
    const last = gone ? n.item : p.item;
    if (!last || !/^spotify:track:/.test(last.uri) || !(gone || this.ended(p))) return;
    this.endTimer = setTimeout(() => {
      const q = S.player;
      if (this.active || !q || q.is_playing) return;
      // Still the same ending: that song stopped at its end, or playback has vanished since it was ending.
      const same = q.item ? q.item.uri === last.uri && this.ended(q) : !!(this.nearEnd && this.nearEnd.uri === last.uri);
      if (!same) return;
      const seed = { uri: last.uri, name: last.name, artists: (last.raw && last.raw.artists) || [] };
      this.used = new Set([seed.uri, ...this.recent.map((x) => x.uri)]);
      this.active = true; this.order = [seed]; this.at = 0; this.qd = [];
      this.holdQueue = true;                                   // nothing goes in Spotify's queue until the first song plays
      let started = false;
      const go = async () => {
        if (started || !this.active || !this.order[1]) return;
        started = true;
        toast("AUTOPLAY: SONGS LIKE " + upper(cleanTitle(last.name)));
        clearInterval(this.timer); this.timer = setInterval(() => this.watch(), 1000);
        this.at = 1; this.grace = Date.now() + 6000;
        this.prog = { uri: this.order[1].uri, max: 0, item: this.order[1] };
        await playBody({ uris: [this.order[1].uri] }, null, false, true);
        this.holdQueue = false;
        this.queueNext();
      };
      // Start with the first song found, while the rest are still being looked up.
      const wait = setInterval(() => { if (this.order[1] || !this.active) { clearInterval(wait); go(); } }, 150);
      this.extend(seed).then((n) => { if (!n && !started) { clearInterval(wait); this.active = false; this.holdQueue = false; } });
    }, 3500);
  },
};


/* =====================================================================
   VISUALIZER: the sound wave on Home (each theme draws it its own way)
   ===================================================================== */
const Viz = {
  cv: $("viz-c"), lv: Array(10).fill(0), target: Array(10).fill(0), lastData: 0, raf: 0, t: 0, last: 0, colors: null,
  feed(levels) { if (Array.isArray(levels) && levels.length) { this.target = levels; this.lastData = performance.now(); } },
  users: new Set(), paused: [], quiet: {},
  // Several places can show it at once (Home and Stage); the meter runs while any of them is open.
  start(who = "home") {
    this.users.add(who);
    Meter.want("viz:" + who, true);
    this.colors = null; this.quiet = {};
    if (this.raf) return;
    // ~30 drawings a second, timed by a plain timer (waking on every display frame, 120 a second
    // on ProMotion screens, cost far more than the drawing itself).
    this.raf = setInterval(() => requestAnimationFrame((now) => this.draw(now)), 33);
  },
  stop(who = "home") {
    this.users.delete(who);
    Meter.want("viz:" + who, false);
    if (!this.users.size) { clearInterval(this.raf); this.raf = 0; }
  },
  /** Cadenza has been in the background for a while (or is back): stop measuring and drawing until it's back. */
  rest(on) {
    if (on && this.users.size && !this.resting) { this.resting = [...this.users]; this.resting.forEach((w) => this.stop(w)); }
    else if (!on && this.resting) { const r = this.resting; this.resting = null; if (!document.hidden) r.forEach((w) => this.start(w)); else this.paused.push(...r); }
  },
  resting: null,
  init() {
    // Hidden window (closed to the menu bar, minimised, covered): stop measuring and drawing entirely.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { this.paused = [...this.users]; this.paused.forEach((w) => this.stop(w)); }
      else { this.paused.forEach((w) => this.start(w)); this.paused = []; }
    });
  },
  levels(now) {
    const playing = !!(S.player && S.player.is_playing);
    // No live levels (engine off, or the demo): fake a gentle pulse while music plays; flat when paused.
    if (now - this.lastData > 700) {
      const k = now / 1000;
      this.target = this.target.map((_, i) => playing ? 0.32 + 0.22 * Math.sin(k * (1.7 + i * 0.37) + i) * Math.sin(k * 0.9 + i * 1.3) + (i < 3 ? 0.18 : 0) : 0);
    }
    if (this.lv.length !== this.target.length) this.lv = this.target.slice();
    // ease toward the target: quick to rise, slower to fall, like a real meter
    this.lv = this.lv.map((v, i) => { const t = this.target[i] || 0; return v + (t - v) * (t > v ? 0.45 : 0.12); });
    return this.lv.map((v) => Math.min(1, Math.pow(v, 0.7) * 1.15));   // perceptual lift so quiet parts still move
  },
  env(lv, x) {   // band level at position x (0 = bass on the left … 1 = treble on the right), smoothly
    const p = x * (lv.length - 1), i = Math.floor(p), f = p - i;
    const a = lv[i] || 0, b = lv[Math.min(i + 1, lv.length - 1)] || 0;
    return a + (b - a) * (f * f * (3 - 2 * f));
  },
  draw(now) {
    if (document.hidden) return;
    const lv = this.levels(now), quiet = lv.every((v) => v < 0.004);
    if (this.users.has("home") && current()?.name === "home" && !Stage.isOpen) this.paint(this.cv, lv, now, quiet, "home", 2);
    if (this.users.has("stage") && Stage.isOpen) this.paint($("sg-viz"), lv, now, quiet, "stage", 1.5);
  },
  paint(cv, lv, now, quiet, key, maxDpr) {
    if (!cv) return;
    const dpr = Math.min(maxDpr, devicePixelRatio || 1), W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
    if (!W || !H) return;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; this.quiet[key] = false; }
    if (!this.colors) {
      const cs = getComputedStyle(document.documentElement);
      this.colors = { a: cs.getPropertyValue("--cyan").trim(), w: cs.getPropertyValue("--white").trim(), n: cs.getPropertyValue("--navy").trim(),
                      y: cs.getPropertyValue("--yellow").trim(), r: cs.getPropertyValue("--red").trim(), t: cs.getPropertyValue("--teal").trim() };
    }
    if (quiet && this.quiet[key]) return;                        // nothing moving: don't redraw a flat line 30× a second
    this.quiet[key] = quiet;
    const c = cv.getContext("2d"), k = now / 1000, mid = H / 2, C = this.colors;
    c.clearRect(0, 0, W, H);
    const theme = Theme.current ? Theme.current.id : "tide";
    const wave = (x, n, speed) => Math.sin(x * n + k * speed) * 0.62 + Math.sin(x * n * 2.3 - k * speed * 1.6) * 0.38;
    if (theme === "min") {
      // Studio: thin rounded bars in the accent colour, mirrored, quiet
      const bars = lv.length >= 24 ? lv.length : 40, gap = W / bars, bw = Math.max(1.5 * dpr, gap * 0.34);
      c.fillStyle = C.a;
      for (let i = 0; i < bars; i++) {
        const e = bars === lv.length ? lv[i] : this.env(lv, i / (bars - 1)) * (0.7 + 0.3 * Math.abs(wave(i / bars, 6, 3)));
        const hh = Math.max(bw, e * (H / 2 - 2 * dpr)), x = i * gap + (gap - bw) / 2;
        c.globalAlpha = 0.35 + 0.65 * e;
        c.beginPath(); c.roundRect ? c.roundRect(x, mid - hh, bw, hh * 2, bw / 2) : c.rect(x, mid - hh, bw, hh * 2); c.fill();
      }
      c.globalAlpha = 1;
      return;
    }
    if (theme === "rogue") {
      // R0GUE: a dot-matrix readout; columns of square pixels, lime with pink at the peaks, and a scan bar
      const cols = lv.length >= 24 ? lv.length : 40, cw = W / cols, px = Math.max(2 * dpr, cw * 0.42), rows = Math.floor(H / (px * 1.6));
      for (let i = 0; i < cols; i++) {
        const e = cols === lv.length ? lv[i] : this.env(lv, i / (cols - 1)) * (0.6 + 0.4 * Math.abs(wave(i / cols, 9, 7)));
        const n = Math.round(e * rows), x = i * cw + (cw - px) / 2;
        for (let r = 0; r < n; r++) {
          c.fillStyle = r >= rows - 3 || (r === n - 1 && n > rows * 0.6) ? C.r : C.y;
          c.globalAlpha = 0.3 + 0.7 * (r / Math.max(1, rows));
          c.fillRect(x, H - (r + 1) * px * 1.6, px, px);
        }
      }
      c.globalAlpha = 0.5; c.fillStyle = C.y;
      c.fillRect(((k * 0.35) % 1) * W, 0, 1.5 * dpr, H);
      c.globalAlpha = 1;
      return;
    }
    if (theme === "neon") {
      // LED spectrum: mirrored segmented bars, yellow with red tips
      const bars = lv.length >= 24 ? lv.length : 44, gap = W / bars, bw = gap * 0.58, seg = 3 * dpr;
      for (let i = 0; i < bars; i++) {
        const x = i / (bars - 1), e = bars === lv.length ? lv[i] : this.env(lv, x);
        // with the real spectrum every bar is a measured band; the wobble is only for the fallback
        const h = Math.max(seg, (bars === lv.length ? e : e * (0.75 + 0.25 * Math.abs(wave(x, 9, 6)))) * (H / 2 - 2 * dpr));
        const px = i * gap + (gap - bw) / 2;
        for (let y = 0; y < h; y += seg * 1.7) {
          c.fillStyle = y > h * 0.8 ? C.r : C.y;
          c.globalAlpha = 0.35 + 0.65 * (1 - y / (H / 2));
          c.fillRect(px, mid - y - seg, bw, seg);
          c.fillRect(px, mid + y, bw, seg);
        }
      }
      c.globalAlpha = 0.6; c.fillStyle = C.t; c.fillRect(0, mid - dpr / 2, W, dpr); c.globalAlpha = 1;
    } else if (theme === "heist") {
      // jagged comic-book wave: a thick black stroke with a white zig-zag on top, red spikes on peaks
      const real = lv.length >= 24, n = real ? lv.length - 1 : 34, pts = [];
      for (let i = 0; i <= n; i++) {
        const x = i / n, e = (real ? lv[i] : this.env(lv, x)) * (H / 2 - 4 * dpr);
        // live: each spike is one measured band; fallback: a decorative wobble
        pts.push([x * W, mid + (i % 2 ? -1 : 1) * e * (real ? 1 : 0.55 + 0.45 * Math.abs(wave(x, 7, 5)))]);
      }
      const path = () => { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); };
      c.lineJoin = "miter";
      path(); c.strokeStyle = C.n; c.lineWidth = 7 * dpr; c.stroke();
      path(); c.strokeStyle = C.w; c.lineWidth = 3 * dpr; c.stroke();
      c.fillStyle = C.a;
      pts.forEach(([x, y], i) => { if (Math.abs(y - mid) > H * 0.28) { c.beginPath(); c.moveTo(x - 3 * dpr, mid); c.lineTo(x, y); c.lineTo(x + 3 * dpr, mid); c.fill(); } });
    } else {
      // smooth water-light wave: a bright line with a soft echo and a glow underneath
      // The glow is two wide, faint strokes of the current path. A canvas blur (shadowBlur) looks the
      // same but costs far more, 30 times a second.
      const glow = () => {
        c.strokeStyle = C.a;
        c.globalAlpha = 0.12; c.lineWidth = 11 * dpr; c.stroke();
        c.globalAlpha = 0.22; c.lineWidth = 6 * dpr; c.stroke();
        c.globalAlpha = 1;
      };
      if (lv.length >= 24) {
        // live: the spectrum itself, mirrored above and below like a sound wave (bass left, treble right)
        const pts = lv.map((v, i) => [(i / (lv.length - 1)) * W, v * (H / 2 - 3 * dpr) * Math.min(1, 0.25 + Math.sin(Math.PI * i / (lv.length - 1)) * 1.4)]);
        const curve = (sign) => {
          c.moveTo(0, mid);
          for (let i = 0; i < pts.length - 1; i++) {
            const [x0, a0] = pts[i], [x1, a1] = pts[i + 1], xm = (x0 + x1) / 2;
            c.quadraticCurveTo(x0, mid + sign * a0, xm, mid + sign * (a0 + a1) / 2);
          }
          c.lineTo(W, mid);
        };
        c.beginPath(); curve(-1); curve(1);
        c.fillStyle = C.a; c.globalAlpha = 0.18; c.fill(); c.globalAlpha = 1;
        c.beginPath(); curve(-1);
        glow(); c.strokeStyle = C.w; c.lineWidth = 2.2 * dpr; c.stroke();
        c.beginPath(); curve(1); c.strokeStyle = C.a; c.lineWidth = 1.6 * dpr; c.stroke();
        return;
      }
      const n = 90;
      const line = (amp, speed, off) => {
        c.beginPath();
        for (let i = 0; i <= n; i++) {
          const x = i / n, e = this.env(lv, x) * (H / 2 - 3 * dpr) * amp, fade = Math.sin(Math.PI * x);
          const y = mid + e * fade * wave(x + off, 11, speed);
          i ? c.lineTo(x * W, y) : c.moveTo(0, y);
        }
      };
      line(0.7, 3.4, 0.4); c.strokeStyle = C.a; c.globalAlpha = 0.35; c.lineWidth = 2 * dpr; c.stroke();
      line(1, 4.6, 0); c.globalAlpha = 1;
      glow(); c.strokeStyle = C.w; c.lineWidth = 2.4 * dpr; c.stroke();
    }
  },
};

views.eq = {
  el: $("v-eq"), sel: 1, bands: [],
  keys: () => [["←→", "BAND"], ["↑↓", "±1 dB"], ["[ ]", "PRESET"], ["E", "ON/OFF"], ["0", "RESET BAND"], ["ESC", "BACK", back]],
  async show() {
    if (!EQ.state) await EQ.load();
    this.build();
    this.render(true);
    Meter.want("eq", true);
    if (!bridge) this.demoMeter();
  },
  leave() { Meter.want("eq", false); clearInterval(this.demo); },
  build() {
    const st = EQ.state || { gains: Array(10).fill(0), freqs: [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000], preamp: 0, enabled: true };
    const pre = $("eq-presets");
    pre.textContent = "";
    Object.keys(EQ.presets).forEach((name) => {
      const b = h("button", "chip eq-p", name.toUpperCase());
      b.dataset.p = name;
      b.onclick = () => { pop(b); this.preset(name); };
      pre.append(b);
    });
    const board = $("eq-board");
    board.textContent = "";
    this.bands = [];
    const cols = [{ hz: "BOOST", pre: true }, ...st.freqs.map((f) => ({ hz: fmtHz(f) }))];
    cols.forEach((c, i) => {
      const col = h("div", "band" + (c.pre ? " pre" : ""));
      const val = h("div", "val");
      const track = h("div", "track");
      const meter = h("i", "meter"), zero = h("i", "zero"), up = h("i", "fill up"), down = h("i", "fill down"), knob = h("b", "knob");
      track.append(meter, zero, up, down, knob);
      col.append(val, track, h("div", "hz", c.hz + (c.pre ? "" : " HZ").replace("K HZ", " KHZ")));
      col.onmouseenter = () => { if (!busy) this.select(i); };
      track.onpointerdown = (e) => {
        this.select(i); track.setPointerCapture(e.pointerId);
        const set = (ev) => { const r = track.getBoundingClientRect(); this.setValue(i, Math.round((12 - ((ev.clientY - r.top) / r.height) * 24) * 2) / 2); };
        set(e);
        track.onpointermove = set;
        track.onpointerup = track.onpointercancel = () => { track.onpointermove = null; };
      };
      col.ondblclick = () => this.setValue(i, 0);
      board.append(col);
      this.bands.push({ col, val, meter, up, down, knob });
    });
    $("eq-toggle").onclick = () => this.toggle();
    $("eq-reset").onclick = () => this.preset("Flat");
  },
  value(i) { const st = EQ.state; return i === 0 ? st.preamp : st.gains[i - 1]; },
  setValue(i, v) {
    v = Math.max(-12, Math.min(12, v));
    if (i === 0) EQ.send({ preamp: v });
    else { const g = EQ.state.gains.slice(); g[i - 1] = v; EQ.send({ gains: g, preset: this.match(g, EQ.state.preamp) }); }
    this.render();
  },
  match(g, pre) {
    for (const [name, p] of Object.entries(EQ.presets)) if (p.g.every((x, k) => x === g[k])) return name;
    return "Custom";
  },
  preset(name) {
    const p = EQ.presets[name];
    if (!p) return;
    EQ.send({ gains: p.g.slice(), preamp: p.pre, preset: name, enabled: true });
    this.render();
    // bars sweep into place one after another
    this.bands.forEach((b, k) => play(b.knob, [{ scale: "1.5" }, { scale: "1" }], { duration: 260, delay: k * 22, easing: SNAP, fill: "none" }));
    toast("EQ: " + upper(name));
  },
  toggle() {
    if (EQ.state.engine === false) return this.engineOn();
    EQ.send({ enabled: !EQ.state.enabled });
    this.render();
    toast(EQ.state.enabled ? "EQ ON" : "EQ OFF");
  },
  async engineOn() {
    await native("eq.engine", { on: true }).catch(() => {});
    await EQ.load();
    this.render();
    toast("SOUND ENGINE ON. MUSIC WILL RESUME IN A MOMENT");
  },
  select(i) {
    this.sel = Math.max(0, Math.min(10, i));
    this.bands.forEach((b, k) => b.col.classList.toggle("on", k === this.sel));
  },
  render(first) {
    const st = EQ.state;
    if (!st) return;
    const off = !st.enabled || st.engine === false;
    this.el.classList.toggle("eq-off", off);
    this.bands.forEach((b, i) => {
      const v = this.value(i);
      b.val.textContent = fmtDb(v);
      b.knob.style.setProperty("--p", ((12 - v) / 24).toFixed(4));
      b.up.style.transform = `scaleY(${Math.max(0, v) / 12})`;
      b.down.style.transform = `scaleY(${Math.max(0, -v) / 12})`;
    });
    this.select(this.sel);
    document.querySelectorAll("#eq-presets .eq-p").forEach((b) => b.classList.toggle("on", b.dataset.p === st.preset));
    setText("eq-status", (st.perDevice && st.device ? upper(st.device) + "  ·  " : "") + (st.engine === false ? "ENGINE OFF" : off ? "OFF" : upper(st.preset || "Custom")));
    setChip($("eq-toggle"), st.engine === false ? "play" : st.enabled ? "check" : "plus", st.engine === false ? "TURN ON SOUND ENGINE" : st.enabled ? "EQ ON" : "EQ OFF");
    $("eq-toggle").classList.toggle("on", !!st.enabled && st.engine !== false);
    setText("eq-note", st.engine === false
      ? "The EQ needs Cadenza's sound engine, which plays Spotify's audio through Cadenza."
      : "Boost raises the volume; a limiter keeps loud parts from distorting. Double-click a band to reset it.");
  },
  levels(lv) {
    if (!lv || !this.bands.length || current().name !== "eq") return;
    this.bands.forEach((b, i) => { if (i > 0) b.meter.style.transform = `scaleY(${(lv[i - 1] || 0).toFixed(3)})`; });
  },
  demoMeter() {
    clearInterval(this.demo);
    let t = 0;
    this.demo = setInterval(() => { t += 0.3; this.levels(Array.from({ length: 10 }, (_, k) => 0.35 + 0.3 * Math.sin(t + k * 0.7) * Math.cos(t * 0.4 + k) + (k < 3 ? 0.2 : 0))); }, 90);
  },
  onKey(e) {
    const k = e.key;
    if (k === "ArrowLeft") { this.select(this.sel - 1); return true; }
    if (k === "ArrowRight") { this.select(this.sel + 1); return true; }
    if (k === "ArrowUp" || k === "ArrowDown") { this.setValue(this.sel, this.value(this.sel) + (k === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 3 : 1)); return true; }
    if (k === "0") { this.setValue(this.sel, 0); return true; }
    if (k.toLowerCase() === "e") { this.toggle(); return true; }
    if (k === "[" || k === "]") {
      const names = Object.keys(EQ.presets), i = names.indexOf(EQ.state.preset);
      this.preset(names[(i + (k === "]" ? 1 : -1) + names.length) % names.length]);
      return true;
    }
    return false;
  },
};

/* =====================================================================
   OUTPUT: speakers / AirPods / Bluetooth tiles
   ===================================================================== */
const ICONS = {
  headphones: '<svg viewBox="0 0 24 24"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="7" rx="1"/><rect x="17" y="14" width="4" height="7" rx="1"/></svg>',
  speaker: '<svg viewBox="0 0 24 24"><rect x="6" y="2.5" width="12" height="19" rx="2"/><circle cx="12" cy="14.5" r="3.5"/><circle cx="12" cy="7" r="1.2"/></svg>',
  laptop: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="11" rx="1"/><path d="M2 19h20"/></svg>',
  display: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="1"/><path d="M9 20h6M12 16v4"/></svg>',
  airplay: '<svg viewBox="0 0 24 24"><path d="M5 17H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-1"/><path d="M12 15l5 6H7z"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><rect x="6.5" y="2.5" width="11" height="19" rx="2.2"/><path d="M10.5 18.5h3"/></svg>',
};
const KIND_LABEL = { bluetooth: "BLUETOOTH", builtin: "BUILT-IN", usb: "USB", airplay: "AIRPLAY", display: "DISPLAY", virtual: "VIRTUAL", other: "OTHER" };
function deviceIcon(d) {
  if (d.transport === "bluetooth") return /airpods|buds|headphone|headset|beats|wh-|wf-|qc ?\d|momentum|earbuds/i.test(d.name) ? "headphones" : "speaker";
  if (d.transport === "builtin") return /speaker|macbook/i.test(d.name) ? "laptop" : "headphones";
  if (d.transport === "display") return "display";
  if (d.transport === "airplay") return "airplay";
  return "speaker";
}
function connectIcon(type) {
  switch (String(type || "").toLowerCase()) {
    case "smartphone": case "tablet": return "phone";
    case "computer": return "laptop";
    case "tv": case "castvideo": case "stb": return "display";
    case "castaudio": case "avr": case "audiodongle": return "airplay";
    default: return "speaker";
  }
}
views.output = {
  el: $("v-output"), sig: "", timer: null,
  keys: () => [["←→↑↓", "SELECT"], ["⏎", "USE", () => views.output.pick(views.output.list.cur)], ["ESC", "BACK", back]],
  list: new List($("out-grid"), {
    columns: 3,
    render: (d) => {
      if (d.kind === "connect") {
        const c = h("div", "dev st connect" + (d.is_active ? " current" : ""));
        const inn = h("div", "in");
        const icon = h("div");
        icon.innerHTML = ICONS[connectIcon(d.type)];
        const txt = h("div");
        txt.append(h("div", "nm", d.name === S.settings.deviceName ? d.name + " (this Mac)" : d.name),
          h("div", "kd", "SPOTIFY CONNECT  ·  " + upper(d.type || "device") + (d.volume_percent != null ? "  ·  " + d.volume_percent + "%" : "")));
        inn.append(icon, txt);
        if (d.is_active) inn.append(h("span", "use", "● PLAYING HERE"));
        c.append(inn);
        return c;
      }
      const c = h("div", "dev st" + (d.transport === "bluetooth" ? " bt" : "") + (d.isDefault ? " current" : ""));
      const inn = h("div", "in");
      const icon = h("div");
      icon.innerHTML = ICONS[deviceIcon(d)];
      const txt = h("div");
      txt.append(h("div", "nm", d.name), h("div", "kd", KIND_LABEL[d.transport] || "OTHER"));
      inn.append(icon, txt);
      if (d.isDefault) inn.append(h("span", "use", "● IN USE"));
      c.append(inn);
      return c;
    },
    onActivate: (d) => views.output.pick(d),
  }),
  show() {
    const sub = $("out-sub");
    sub.textContent = "";
    if (S.settings.manageLibrespot) sub.append("Pick where your music plays: this Mac's speakers and headphones, or ", h("b", null, "Spotify Connect"), " devices like your phone.");
    else sub.append("Turn on the ", h("b", null, "audio engine"), " in System so music can follow the output you pick.");
    this.sig = "";
    this.refresh(true);
    clearInterval(this.timer);
    // Mac outputs arrive as events from native code; this only catches Spotify Connect devices coming
    // and going, which is rare, so every 15 s is plenty (and never while Cadenza is hidden).
    this.timer = setInterval(() => { if (!cooling() && !document.hidden) this.refresh(false); }, 15000);
  },
  leave() { clearInterval(this.timer); },
  async refresh(first) {
    let list = [];
    try { list = (await native("outputs.list")) || []; } catch (e) { list = []; }
    const r = await api("GET", "/me/player/devices");
    await settled();
    const connect = ((r.body && r.body.devices) || []).filter((d) => d.id).map((d) => ({ ...d, kind: "connect", key: "c:" + d.id }));
    list = list.map((d) => ({ ...d, kind: "mac", key: "m:" + d.uid }));
    const all = [...list, ...connect];
    const sig = JSON.stringify(all);
    if (sig === this.sig) return;
    this.sig = sig;
    const keep = this.list.cur && this.list.cur.key;
    const top = this.list.el.scrollTop;
    this.list.set(all);
    this.list.el.scrollTop = top;
    // section headings (not selectable)
    if (list.length) this.list.rows[0].before(h("div", "dev-h", "THIS MAC"));
    const firstConnect = all.findIndex((d) => d.kind === "connect");
    if (firstConnect >= 0) this.list.rows[firstConnect].before(h("div", "dev-h", "SPOTIFY CONNECT"));
    let idx = all.findIndex((d) => d.key === keep);
    if (idx < 0) idx = Math.max(0, all.findIndex((d) => d.isDefault));
    this.list.select(idx, false);
    if (first) revealRows(this.list.el);
  },
  async pick(d) {
    if (!d || busy) return;
    if (d.kind === "connect") {
      if (d.is_active) return toast("ALREADY PLAYING ON " + upper(d.name));
      const r = await api("PUT", "/me/player", { device_ids: [d.id], play: true });
      toast(r.status < 300 ? "♪ PLAYING ON " + upper(d.name) : errMsg(r), r.status >= 300);
      setTimeout(() => { this.sig = ""; this.refresh(false); poll(); }, 900);
      return;
    }
    if (d.isDefault) return toast("ALREADY PLAYING ON " + upper(d.name));
    let ok = false;
    try { ok = await native("outputs.set", { uid: d.uid }); } catch (e) { ok = false; }
    toast(ok ? "♪ SWITCHED TO " + upper(d.name) : "COULDN'T SWITCH TO " + upper(d.name), !ok);
    setTimeout(() => this.refresh(false), 250);
  },
  onKey(e) {
    if (this.list.nav(e)) return true;
    if (e.key === "Enter") { pop(this.list.rows[this.list.i]); this.pick(this.list.cur); return true; }
    return false;
  },
};

/* =====================================================================
   ALBUM: hero + tracks
   ===================================================================== */
views.album = {
  el: $("v-album"), al: null, next: null, saved: false,
  keys: () => [["↑↓", "SELECT"], ["⏎", "PLAY"], ["M", "MORE"], ["S", "SAVE"], ["G", "ARTIST"], ["ESC", "BACK", back]],
  list: new List($("al-tracks"), {
    render: (t, i) => renderTrack(t, i),
    onActivate: (t, i, act) => views.album.act(act || "play", t, i),
    onNearEnd: () => views.album.more(),
  }),
  show(params, isBack) { if (isBack && this.al && this.al.id === params.id) return; this.open(params.id); },
  async open(id) {
    this.al = { id }; this.next = null;
    $("al-name").textContent = ""; $("al-info").textContent = "LOADING…"; setBg($("al-cover"), null);
    this.list.set([]);
    const hit = PageCache.get(`/albums/${id}`);
    const r = hit || await api("GET", `/albums/${id}`);
    if (!hit) {
      if (r.status === 200 && r.body) PageCache.put(`/albums/${id}`, r);
      await settled();
    }
    if (!this.al || this.al.id !== id) return;
    if (r.status !== 200 || !r.body) { $("al-info").textContent = errMsg(r); return; }
    const al = r.body;
    this.al = al;
    $("al-kind").textContent = upper(al.album_type || "album");
    $("al-name").textContent = al.name;
    $("al-info").textContent = [upper(artistNames(al)), (al.release_date || "").slice(0, 4), (al.total_tracks || "") + " TRACKS"].filter(Boolean).join("  ·  ");
    setBg($("al-cover"), pickImage(al.images, true));
    const ref = { id: al.id, name: al.name, images: al.images, uri: al.uri };
    const tracks = ((al.tracks && al.tracks.items) || []).map((t) => ({ ...t, album: ref }));
    this.next = relPath(al.tracks && al.tracks.next);
    this.list.add(tracks); this.list.select(0, false); revealRows(this.list.el);
    this.markPlaying();
    this.saved = !!(await isSaved(al.uri)); this.renderSave();
  },
  async more() {
    if (!this.next || this.loading) return;
    this.loading = true;
    const r = await api("GET", this.next);
    this.loading = false;
    if (r.status !== 200 || !r.body) return;
    const ref = { id: this.al.id, name: this.al.name, images: this.al.images, uri: this.al.uri };
    this.list.add((r.body.items || []).map((t) => ({ ...t, album: ref })));
    this.next = relPath(r.body.next);
  },
  renderSave() { setChip($("al-save"), this.saved ? "heartFill" : "heart", this.saved ? "SAVED" : "SAVE"); $("al-save").classList.toggle("on", this.saved); },
  async toggleSave() { if (!this.al || !this.al.uri) return; if (await setSaved(this.al.uri, !this.saved)) { this.saved = !this.saved; this.renderSave(); toast(this.saved ? "♥ ALBUM SAVED" : "ALBUM REMOVED"); } },
  markPlaying() { const uri = S.player && S.player.item && S.player.item.uri; this.list.rows.forEach((r, i) => r.classList.toggle("playing", this.list.items[i].uri === uri)); },
  playAll() { if (this.al && this.al.uri) playBody({ context_uri: this.al.uri }, this.al.name); },
  artist() { const a = this.al && this.al.artists && this.al.artists[0]; if (a) go("artist", { id: a.id }); },
  act(kind, t) {
    if (!t) return;
    if (kind === "queue") return queueTrack(t);
    if (kind === "add") return Drawer.show(t);
    playBody({ context_uri: this.al.uri, offset: { uri: t.uri } }, t.name);
  },
  onKey(e) {
    if (this.list.nav(e)) return true;
    const k = e.key.toLowerCase();
    if (e.key === "Enter") { pop(this.list.rows[this.list.i]); this.act("play", this.list.cur); return true; }
    if (k === "q") { this.act("queue", this.list.cur); return true; }
    if (k === "a") { this.act("add", this.list.cur); return true; }
    if (k === "p") { this.playAll(); return true; }
    if (k === "s") { this.toggleSave(); return true; }
    if (k === "g") { this.artist(); return true; }
    return false;
  },
};
$("al-play").onclick = () => views.album.playAll();
$("al-save").onclick = () => views.album.toggleSave();
$("al-artist").onclick = () => views.album.artist();
$("al-share").onclick = () => views.album.al && copyLink(views.album.al.uri, views.album.al.name);

/* =====================================================================
   ARTIST: photo, follow, discography cards
   ===================================================================== */
views.artist = {
  el: $("v-artist"), ar: null, following: false,
  keys: () => [["←→↑↓", "SELECT"], ["⏎", "OPEN"], ["P", "PLAY"], ["F", "FOLLOW"], ["ESC", "BACK", back]],
  list: new List($("ar-grid"), {
    columns: 4,
    render: (a) => {
      const c = h("div", "card st");
      const inn = h("div", "in"), cov = h("div", "cover");
      const url = pickImage(a.images);
      if (url) { const im = new Image(); im.loading = "lazy"; im.className = "art-img"; im.src = url; im.alt = ""; cov.append(im); }
      const cap = h("div", "cap");
      cap.append(h("span", "n", a.name), h("span", "c", upper(a.album_type || "album") + "  ·  " + (a.release_date || "").slice(0, 4)));
      inn.append(cov, cap); c.append(inn);
      return c;
    },
    onActivate: (a) => go("album", { id: a.id }),
  }),
  show(params, isBack) { if (isBack && this.ar && this.ar.id === params.id) return; this.open(params.id); },
  async open(id) {
    this.ar = { id };
    $("ar-name").textContent = ""; $("ar-info").textContent = "LOADING…"; setBg($("ar-photo"), null);
    this.list.set([]);
    const hit = PageCache.get(`/artists/${id}`);
    const [r, rl] = hit ? [hit.r, null] : await Promise.all([api("GET", `/artists/${id}`), api("GET", `/artists/${id}/albums?include_groups=album,single&limit=10`)]);
    if (!this.ar || this.ar.id !== id) return;
    if (r.status !== 200 || !r.body) { $("ar-info").textContent = errMsg(r); return; }
    this.ar = r.body;
    $("ar-name").textContent = r.body.name;
    const arPlays = PlayCounts.ofArtist(r.body.name);
    $("ar-info").textContent = (r.body.genres && r.body.genres.length ? upper(r.body.genres.slice(0, 3).join(" · ")) : "ARTIST")
      + (arPlays ? "  ·  YOU'VE PLAYED THEM " + arPlays.toLocaleString() + (arPlays === 1 ? " TIME" : " TIMES") : "");
    setBg($("ar-photo"), pickImage(r.body.images, true));
    let releases = hit ? hit.releases : (rl.body && rl.body.items) || [];
    if (!hit) {
      let next = relPath(rl.body && rl.body.next);
      for (let n = 0; next && n < 4; n++) {            // a few more pages of the discography
        const m = await api("GET", next);
        if (m.status !== 200 || !m.body) break;
        releases = releases.concat(m.body.items || []);
        next = relPath(m.body.next);
      }
      PageCache.put(`/artists/${id}`, { r, releases });
      await settled();
      if (!this.ar || this.ar.id !== id) return;
    }
    const seen = new Set();
    releases = releases.filter((a) => { const k = upper(a.name); if (seen.has(k)) return false; seen.add(k); return true; });
    this.list.set(releases); this.list.select(0, false); revealRows(this.list.el);
    this.following = !!(await isSaved(r.body.uri)); this.renderFollow();
  },
  renderFollow() { setChip($("ar-follow"), this.following ? "check" : "plus", this.following ? "FOLLOWING" : "FOLLOW"); $("ar-follow").classList.toggle("on", this.following); },
  async toggleFollow() { if (!this.ar || !this.ar.uri) return; if (await setSaved(this.ar.uri, !this.following)) { this.following = !this.following; this.renderFollow(); toast(this.following ? "FOLLOWING " + upper(this.ar.name) : "UNFOLLOWED"); } },
  play() { if (this.ar && this.ar.uri) playBody({ context_uri: this.ar.uri }, this.ar.name); },
  onKey(e) {
    if (this.list.nav(e)) return true;
    const k = e.key.toLowerCase();
    if (e.key === "Enter") { pop(this.list.rows[this.list.i]); if (this.list.cur) go("album", { id: this.list.cur.id }); return true; }
    if (k === "p") { this.play(); return true; }
    if (k === "f") { this.toggleFollow(); return true; }
    return false;
  },
};
$("ar-play").onclick = () => views.artist.play();
$("ar-follow").onclick = () => views.artist.toggleFollow();
$("ar-share").onclick = () => views.artist.ar && copyLink(views.artist.ar.uri, views.artist.ar.name);

/* =====================================================================
   LYRICS: synced lines from LRCLIB, the current line glows and stays centred
   ===================================================================== */
/** Lyrics follow what you *hear*, which lags what Spotify reports: Cadenza's sound engine keeps
 *  about 0.4 s of audio buffered, and Bluetooth adds roughly 0.2 s more. [ and ] nudge it further. */
/** Milliseconds until the next synced line starts (as heard), clamped to 30 ms … 1 s. */
function nextLyricIn(lines, cap = 1000) {
  if (!lines || !lines.length || lines[0].t < 0) return cap;
  const pos = LyricSync.pos(), next = lines.find((l) => l.t > pos);
  return next ? Math.max(30, Math.min(cap, next.t - pos + 15)) : cap;
}
const LyricSync = {
  offset: 0, bt: false, loaded: false,
  async load() {
    if (!this.loaded) {
      this.loaded = true;
      try { const v = await native("store.get", { key: "lyricOffset" }); if (typeof v === "number") this.offset = v; } catch (e) { /* demo */ }
    }
    try { const outs = await native("outputs.list"); const d = (outs || []).find((o) => o.isDefault); this.bt = !!(d && /bluetooth|airplay/.test(d.kind || "")); } catch (e) { /* keep */ }
  },
  lag() {
    const throughCadenza = Local.active() && (!S.engine || S.engine.state === "running") && (!EQ.state || EQ.state.engine !== false);
    return (throughCadenza ? 420 : 60) + (this.bt ? 200 : 0) + this.offset;
  },
  pos() { return progressNow() - this.lag(); },
  nudge(ms) {
    this.offset = Math.max(-3000, Math.min(3000, this.offset + ms));
    native("store.set", { key: "lyricOffset", value: this.offset }).catch(() => {});
    toast("LYRICS " + (this.offset ? (this.offset > 0 ? "LATER " : "EARLIER ") + (Math.abs(this.offset) / 1000).toFixed(1) + "S" : "IN SYNC"));
  },
};

views.lyrics = {
  el: $("v-lyrics"), cache: {}, lines: [], uri: null, timer: null, cur: -1,
  keys: () => [["CLICK", "JUMP TO LINE"], ["[ ]", "EARLIER / LATER"], ["T", Lyrics_tr.on ? "HIDE TRANSLATION" : "TRANSLATE", () => Lyrics_tr.toggle()], ["ESC", "BACK", back]],
  show() { LyricSync.load(); this.load(); this.loop(); },
  /** Check again right when the next line is due, and at most once a second while waiting. */
  loop() {
    clearTimeout(this.timer);
    this.tick();
    this.timer = setTimeout(() => this.loop(), nextLyricIn(this.lines));
  },
  onKey(e) {
    if (e.key.toLowerCase() === "t" && !e.metaKey) { Lyrics_tr.toggle(); return true; }
    if (e.key !== "[" && e.key !== "]") return false;
    LyricSync.nudge(e.key === "[" ? -150 : 150);
    $("ly-lines").querySelectorAll(".now").forEach((r) => r.classList.remove("now"));
    this.cur = -2; this.loop();
    return true;
    return false;
  },
  leave() { clearInterval(this.timer); },
  async load() {
    const it = S.player && S.player.item;
    const box = $("ly-lines");
    if (!it) { this.render([], "NOTHING PLAYING"); setText("ly-song", ""); return; }
    if (it.uri === this.uri) return;
    this.uri = it.uri; this.cur = -1;
    setText("ly-song", upper(cleanTitle(it.name)) + "  ·  " + upper(it.artists));
    let res = this.cache[it.uri];
    if (!res) {
      this.render([], "LOADING…");
      res = await this.fetch(it);
      if (this.uri !== it.uri) return;
    }
    if (res && res.instrumental) return this.render([], "♪ INSTRUMENTAL ♪");
    if (res && res.synced) return this.render(this.parse(res.synced));
    if (res && res.plain) return this.render(res.plain.split("\n").map((t) => ({ t: -1, text: t })));
    this.render([], "NO LYRICS FOUND");
    void box;
  },
  /** Lyrics for a song, fetched once (Stage mode uses these too). */
  async fetch(it) {
    if (this.cache[it.uri]) return this.cache[it.uri];
    const raw = it.raw || {};
    let res = null;
    try {
      res = await native("lyrics", { track: cleanTitle(it.name), artist: (raw.artists && raw.artists[0] && raw.artists[0].name) || it.artists,
        album: it.album, seconds: Math.round(it.duration_ms / 1000) });
    } catch (e) { res = null; }
    return (this.cache[it.uri] = res || { none: true });
  },
  /** Timed LRC lines. Copes with several stamps on one line ("[00:12.00][01:40.00] chorus"),
   *  "mm:ss:cc" stamps and word-timing tags ("<00:12.40>"), all of which some uploads use. */
  parse(lrc) {
    const out = [], stamp = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
    for (const raw of String(lrc).split(/\r?\n/)) {
      const line = raw.trim(), times = [];
      let m, end = 0;
      stamp.lastIndex = 0;
      while ((m = stamp.exec(line)) && m.index === end) {
        const frac = m[3] ? +m[3] / Math.pow(10, m[3].length) : 0;
        times.push((+m[1] * 60 + +m[2] + frac) * 1000); end = stamp.lastIndex;
      }
      if (!times.length) continue;
      const text = line.slice(end).replace(/<\d+:\d+(?:[.:]\d+)?>/g, "").replace(/\s+/g, " ").trim();
      times.forEach((t) => out.push({ t, text }));
    }
    return out.sort((a, b) => a.t - b.t);
  },
  render(lines, message) {
    this.lines = lines;
    const box = $("ly-lines");
    box.textContent = "";
    box.style.transform = "translate3d(0,0,0)";
    if (!lines.length) { box.append(h("div", "ly-msg", message || "")); return; }
    lines.forEach((l, i) => {
      const d = h("div", "ly-line" + (l.t < 0 ? " plain" : ""), l.text || "♪");
      if (l.t >= 0) d.onclick = () => { api("PUT", `/me/player/seek?position_ms=${Math.round(l.t)}`); if (S.player) { S.player.progress_ms = l.t; S.stamp = Date.now(); } this.loop(); };
      box.append(d);
    });
    revealRows(box);
    this.cur = -1;
    if (Lyrics_tr.on) Lyrics_tr.apply();                                   // translation stays on from song to song
    if (lines[0].t < 0) $("ly-box").classList.add("free"); else $("ly-box").classList.remove("free");
    if (current() && current().name === "lyrics") this.loop();          // new words: time the first line now
  },
  tick() {
    if (!this.lines.length || this.lines[0].t < 0) return;
    const pos = LyricSync.pos();
    let i = -1;
    for (let k = 0; k < this.lines.length; k++) { if (this.lines[k].t <= pos) i = k; else break; }
    if (i === this.cur) return;
    const box = $("ly-lines"), rows = box.children;
    if (rows[this.cur]) rows[this.cur].classList.remove("now");
    this.cur = i;
    if (i < 0) return;
    const row = rows[i];
    row.classList.add("now");
    const mid = $("ly-box").clientHeight * 0.42;
    box.style.transform = `translate3d(0, ${Math.round(mid - row.offsetTop - row.offsetHeight / 2)}px, 0)`;
  },
};

/* =====================================================================
   Track menu: everything you can do with a song (M, right-click, or •••)
   ===================================================================== */
const TrackMenu = {
  async show(t) {
    if (t && t.t) t = t.t;                                     // a Stats row
    if (t && t.lfm && !t.uri) {                                // a song known only by name (Last.fm)
      const sp = await Resolve.track(t.name, LFM.firstArtist(t));
      if (!sp) return toast("COULDN'T FIND " + upper(t.name) + " ON SPOTIFY", true);
      t = sp;
    }
    if (!isTrack(t)) return;
    Drawer.menu(t, this.items(t));
    this.checkLike(t);
  },
  /** Everything you can do with a song (also listed in the ⌘K palette). */
  items(t) {
    const a = (t.artists || []).filter((x) => x.id);
    return [
      { kind: "act", icon: "play", name: "Play now", run: () => (Radio.enabled() ? Radio.start(t) : playBody({ uris: [t.uri] }, t.name)) },
      { kind: "act", icon: "shuffle", name: "Song radio", run: () => Radio.start(t, true) },
      { kind: "act", icon: "queue", name: "Play next", run: () => queueTrack(t, true) },
      { kind: "act", icon: "queue", name: "Add to Up Next", run: () => queueTrack(t) },
      { kind: "act", icon: "listAdd", name: "Add to playlist", run: () => Drawer.show(t), keep: true },
      { kind: "act", icon: "heart", name: "Like", like: true, run: () => toggleLike(t) },
      ...(t.album && t.album.id ? [{ kind: "act", icon: "album", name: "Go to album", hint: t.album.name, run: () => go("album", { id: t.album.id }) }] : []),
      ...a.slice(0, 3).map((x) => ({ kind: "act", icon: "artist", name: "Go to " + x.name, run: () => go("artist", { id: x.id }) })),
      { kind: "act", icon: "link", name: "Copy link", run: () => copyLink(t.uri, t.name) },
      { kind: "act", icon: "external", name: "Open in Spotify", run: () => native("openURL", { url: t.uri }).catch(() => {}) },
    ];
  },
  async checkLike(t) {
    if (/^spotify:track:/.test(t.uri)) {
      const liked = await isSaved(t.uri);
      const like = Drawer.list.items.find((x) => x.like);
      if (like && Drawer.mode === "menu" && liked != null) {
        like.name = liked ? "Remove from Liked Songs" : "Like";
        like.icon = liked ? "heartFill" : "heart";
        const row = Drawer.list.rows[Drawer.list.items.indexOf(like)];
        if (row) fillLabel(row.querySelector(".k"), like);
      }
    }
  },
};

/* =====================================================================
   AI tags: 3 per playlist (genre · mood · tempo), made on-device by Apple Intelligence.
   Cached per playlist version, so they refresh when songs are added or removed.
   ===================================================================== */
const Tags = {
  cache: {}, queue: [], running: false, status: null, pending: new Set(), genres: {},
  key(p) { return p.kind === "liked" ? "liked" : p.id; },
  version(p) { return p.kind === "liked" ? "liked:" + S.likedTotal : (p.snapshot_id || "n" + plCount(p)); },
  async init() {
    try { this.cache = (await native("store.get", { key: "tags" })) || {}; } catch (e) { this.cache = {}; }
    try { this.genres = (await native("store.get", { key: "artistGenres" })) || {}; } catch (e) { this.genres = {}; }
    try { this.status = await native("ai.status"); } catch (e) { this.status = { available: false, reason: "unknown" }; }
  },
  enabled() { return !!(S.settings.aiTags !== false && this.status && this.status.available); },
  reasonText() {
    const r = (this.status && this.status.reason) || "";
    if (this.status && this.status.available) return "On-device, refreshed when songs change";
    if (/NotEnabled/i.test(r)) return "Turn on Apple Intelligence in System Settings";
    if (/NotEligible/i.test(r)) return "This Mac doesn't support Apple Intelligence";
    if (/NotReady/i.test(r)) return "Apple Intelligence is still downloading";
    if (/NewerMacOS/i.test(r)) return "Needs macOS 26 or later";
    return "Apple Intelligence isn't available";
  },
  get(p) { const c = this.cache[this.key(p)]; return c ? c.tags : null; },
  stale(p) {
    const c = this.cache[this.key(p)];
    if (c && c.failed && Date.now() - c.failed < 3600000) return false;   // tried recently and couldn't: wait an hour
    return !c || c.v !== this.version(p) || !c.tags;
  },
  render(el, p) {
    el.textContent = "";
    const t = this.get(p);
    if (t) t.forEach((x, i) => el.append(h("span", "tag t" + i, upper(x))));
    else if (this.enabled() && this.pending.has(this.key(p))) el.append(h("span", "tag ghost", "TAGGING…"));
  },
  schedule(lists) {
    if (!this.enabled()) return;
    for (const p of lists) {
      if (!p || p.kind === "new" || !this.stale(p) || this.pending.has(this.key(p))) continue;
      this.pending.add(this.key(p)); this.queue.push(p);
    }
    this.run();
  },
  async run() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      while (!quietTime() || !S.loggedIn) await wait(3000);       // wait for a quiet moment (and for any Spotify cool-down)
      const p = this.queue.shift();
      this.paint(p);
      try { await this.generate(p); } catch (e) { console.error(e); }
      this.pending.delete(this.key(p));
      this.paint(p);
      await wait(2500);                                           // one playlist at a time, gently
    }
    this.running = false;
  },
  async generate(p) {
    let tracks = [];
    const r = p.kind === "liked" ? await api("GET", "/me/tracks?limit=50") : await api("GET", `/playlists/${p.id}/items?limit=50`);
    if (r.status === 429) { this.queue.push(p); this.pending.add(this.key(p)); return; }          // try again after the cool-down
    if (r.status === 200 && r.body) tracks = (r.body.items || []).map((e) => e && (e.item || e.track)).filter((t) => t && t.name);
    const count = {};
    tracks.forEach((t) => (t.artists || []).forEach((a) => { if (a.id) { count[a.id] = count[a.id] || { a, n: 0 }; count[a.id].n++; } }));
    const top = Object.values(count).sort((x, y) => y.n - x.n).slice(0, 5);
    const genres = [];
    let looked = 0;
    for (const { a } of top) {                     // artist genres are remembered, so each artist is only looked up once
      if (!this.genres[a.id] && looked < 3 && !cooling()) {
        looked++;
        const g = await api("GET", `/artists/${a.id}`);
        if (g.status === 200 && g.body) this.genres[a.id] = (g.body.genres || []).slice(0, 4);
        await wait(400);
      }
      genres.push(...(this.genres[a.id] || []));
    }
    if (looked) native("store.set", { key: "artistGenres", value: this.genres }).catch(() => {});
    const desc = plainText(p.description);
    const head = `Playlist name: "${p.name}"` + (desc ? `\nDescription: ${desc.slice(0, 200)}` : "") +
      (genres.length ? `\nArtist genres: ${[...new Set(genres)].slice(0, 12).join(", ")}` : "");
    const songs = tracks.slice(0, 40).map((t) => `${cleanTitle(t.name)} - ${artistNames(t)}`);
    let res = await native("ai.tags", { prompt: head + (songs.length ? "\nSongs:\n" + songs.join("\n") : "\n(The song list isn't available; judge by the name and description.)") });
    if (!res || !res.tags) {   // safety filters sometimes trip on song titles: try again with artists only
      const artists = top.map((x) => x.a.name).join(", ");
      res = await native("ai.tags", { prompt: head + (artists ? `\nMain artists: ${artists}` : "") });
    }
    if (!res || !res.tags) {
      this.cache[this.key(p)] = { v: this.version(p), tags: (this.cache[this.key(p)] || {}).tags || null, failed: Date.now() };
      return;
    }
    this.cache[this.key(p)] = { v: this.version(p), tags: [res.tags.genre, res.tags.mood, res.tags.tempo] };
    native("store.set", { key: "tags", value: this.cache }).catch(() => {});
  },
  paint(p) {
    const key = this.key(p);
    const card = $("lib-grid").querySelector(`[data-key="${CSS.escape(key)}"] .tags`);
    if (card) this.render(card, p);
    if (views.playlist.pl && this.key(views.playlist.pl) === key) this.render($("pl-tags"), views.playlist.pl);
  },
  retagAll() {
    this.cache = {};
    native("store.set", { key: "tags", value: {} }).catch(() => {});
    if (S.playlists) this.schedule([{ kind: "liked", name: "Liked Songs" }, ...S.playlists]);
    toast("RE-TAGGING YOUR PLAYLISTS");
  },
};

/* =====================================================================
   DJ: spinning record, what the DJ just said, and the set list
   ===================================================================== */
views.dj = {
  el: $("v-dj"),
  keys: () => [["↑↓", "SELECT"], ["⏎", "CHOOSE"], ["S", "SWITCH IT UP", () => DJ.start()], ["V", "VOICE"], ["ESC", "BACK", back]],
  list: new List($("dj-actions"), {
    render: (o) => {
      const r = h("div", "opt st");
      const inn = h("div", "in");
      const k = h("span", "k"); fillLabel(k, o);
      inn.append(k, h("span", "v", o.value || ""));
      if (o.toggle != null) inn.append(h("span", "sw" + (o.toggle ? " on" : "")));
      r.append(inn);
      return r;
    },
    onActivate: (o) => views.dj.act(o),
  }),
  actions() {
    return [
      DJ.active ? { key: "switch", icon: "refresh", label: "Switch it up", value: "Build a fresh set" } : { key: "start", icon: "play", label: "Start DJ", value: "A set made from what you love" },
      { key: "voice", label: "Voice", value: "Spoken intros between segments", toggle: !!S.settings.djVoice },
      ...(DJ.active ? [{ key: "stop", icon: "stop", label: "Stop DJ", value: "Keep the music, lose the DJ" }] : []),
      ...(DJ.segments.length ? [{ key: "save", icon: "plus", label: "Save this set", value: "Keep the whole DJ set as a playlist" }] : []),
    ];
  },
  show() { this.render(); if (!DJ.lastLine) this.caption("Press ⏎ and I'll put together a set from what you've been playing, old favourites, and songs you haven't found yet."); },
  render() {
    const keep = this.list.i;
    this.list.set(this.actions());
    this.list.select(Math.min(keep, this.list.items.length - 1), false);
    setText("dj-status", DJ.building ? "TUNING IN…" : DJ.active ? "ON AIR" : "OFF AIR");
    this.el.classList.toggle("live", DJ.active);
    const segs = $("dj-segs");
    segs.textContent = "";
    const uri = S.player && S.player.item && S.player.item.uri;
    DJ.segments.forEach((sg) => {
      const row = h("div", "seg" + (DJ.active && sg.tracks.some((t) => t.uri === uri) ? " now" : ""));
      row.append(h("b", null, sg.title), h("span", null, sg.tracks.map((t) => cleanTitle(t.name)).join("  ·  ")));
      segs.append(row);
    });
    const now = segs.querySelector(".seg.now");                   // keep the segment that's playing in view
    if (now) segs.scrollTop = Math.max(0, now.offsetTop - segs.clientHeight / 3);
    const it = S.player && S.player.item;
    setBg($("dj-label"), it && it.image);
  },
  caption(line) {
    const el = $("dj-say");
    el.textContent = line;
    play(el, motion().hint.frames, { duration: motion().hint.ms, easing: motion().hint.ease || OUT, fill: "none" });
  },
  async act(o) {
    if (!o) return;
    if (o.key === "save") {
      const uris = [...new Set(DJ.segments.flatMap((sg) => sg.tracks.map((t) => t.uri)))].filter((u) => /^spotify:track:/.test(u));
      return PlaylistTools.saveNew(uris, "DJ set · " + new Date().toLocaleDateString([], { month: "short", day: "numeric" }));
    }
    if (o.key === "start" || o.key === "switch") return DJ.start();
    if (o.key === "stop") return DJ.stop();
    if (o.key === "voice") {
      try { const s = await native("settings.set", { key: "djVoice", value: !S.settings.djVoice }); if (s) S.settings = s; } catch (e) { S.settings.djVoice = !S.settings.djVoice; }
      if (!S.settings.djVoice) native("speak.stop").catch(() => {});
      this.render();
    }
  },
  onKey(e) {
    if (this.list.nav(e)) return true;
    const k = e.key.toLowerCase();
    if (e.key === "Enter") { pop(this.list.rows[this.list.i]); this.act(this.list.cur); return true; }
    if (k === "s") { DJ.start(); return true; }
    if (k === "v") { this.act({ key: "voice" }); return true; }
    return false;
  },
};

/* =====================================================================
   SYSTEM: settings rows + engine log
   ===================================================================== */
const ENGINE_TEXT = { running: "RUNNING", starting: "STARTING…", login: "WAITING FOR SPOTIFY SIGN-IN (CHECK YOUR BROWSER)", stopped: "STOPPED", missing: "NOT FOUND (brew install librespot)", error: "CRASHED. SEE LOG BELOW" };
// System is split up: the things you reach for most sit at the top, the rest live in groups.
const SYS_TOP = ["theme", "account", "devices", "friends", "commands", "stage", "update"];
const SYS_GROUPS = {
  sound: { label: "Sound & EQ", keys: ["eqEngine", "crossfade", "eqPerDevice", "normalize", "bitrate", "djVoiceId", "sfx", "sfxVolume"] },
  connections: { label: "Connections", keys: ["discord", "discordAppId", "lastfmAccount", "lastfmKey", "lastfmSecret", "geniusToken"] },
  prefs: { label: "Preferences", keys: ["autoplay", "trueShuffle", "themedCovers", "notifications", "menuBar", "mediaKeys", "globalHotkey", "openAtLogin", "aiTags", "retag", "updateRepo", "autoUpdate"] },
  engine: { label: "Engine settings", keys: ["diagnostics", "manageLibrespot", "restart", "deviceName", "librespotPath", "clientId", "activity"] },
};
views.system = {
  el: $("v-system"), timer: null, editing: null, group: null,
  keys: () => [["↑↓", "SELECT"], ["⏎", "CHANGE"], ["ESC", views.system.group ? "ALL SETTINGS" : "BACK", () => views.system.group ? views.system.openGroup(null) : back()]],
  list: new List($("sys-list"), {
    render: (o) => {
      const r = h("div", "opt st");
      r.dataset.key = o.key;
      const inn = h("div", "in");
      inn.append(h("span", "k", o.label));
      const v = h("span", "v", o.value != null ? String(o.value) : "");
      inn.append(v);
      if (o.type === "toggle") inn.append(h("span", "sw" + (o.on ? " on" : "")));
      else if (o.go) inn.append(h("span", "go", o.go));
      r.append(inn);
      return r;
    },
    onActivate: (o) => views.system.act(o),
  }),
  options() {
    const all = this.allOptions(), by = Object.fromEntries(all.map((o) => [o.key, o]));
    const s = S.settings, e = S.engine || {}, onOff = (v) => (v ? "on" : "off");
    if (this.group) {
      const g = SYS_GROUPS[this.group];
      return [{ key: "grp:", label: "‹ All settings", type: "group", value: g.label, go: "ESC" }, ...g.keys.map((k) => by[k]).filter(Boolean)];
    }
    const summary = {
      sound: `Sound engine ${onOff(!EQ.state || EQ.state.engine !== false)} · crossfade ${(s.crossfade ?? 6) ? (s.crossfade ?? 6) + " s" : "off"} · even loudness ${onOff(s.normalize !== false)} · ${s.bitrate || 320} kbps · clicks ${onOff(s.sfx !== false)}`,
      connections: `Discord ${onOff(!!s.discord)} · Last.fm ${Links.lastfm && Links.lastfm.loggedIn ? "as " + Links.lastfm.user : "off"} · Genius ${s.geniusToken ? "set" : "not set"}`,
      prefs: "Notifications, menu bar, media keys, open at login, AI tags, update source",
      engine: `${ENGINE_TEXT[e.state] || "Audio engine"} · "${s.deviceName || "Cadenza"}" · diagnostics, Client ID, librespot, activity log`,
    };
    return [
      ...SYS_TOP.map((k) => by[k]).filter(Boolean),
      ...Object.entries(SYS_GROUPS).map(([id, g]) => ({ key: "grp:" + id, label: g.label, type: "group", value: summary[id], go: "OPEN ›" })),
    ];
  },
  openGroup(id) {
    if (busy || this.editing) return;
    const was = this.group;
    this.group = id;
    Sfx.play(id ? "page" : "back");
    this.list.set(this.options());
    const i = id ? 1 : Math.max(0, this.list.items.findIndex((o) => o.key === "grp:" + was));
    this.list.select(i, false);
    revealRows(this.list.el, id ? 1 : -1);
    this.layout();
    setKeys(this.keys());
  },
  layout() {
    this.el.classList.toggle("nolog", this.group !== "engine");
    setText("sys-sub", this.group ? upper(SYS_GROUPS[this.group].label) : "");
  },
  allOptions() {
    const s = S.settings, e = S.engine || {};
    return [
      { key: "theme", label: "Theme", type: "cycle", value: Theme.meta(Theme.current ? Theme.current.id : s.theme).name, go: "SWITCH  ⌘T" },
      { key: "account", label: "Spotify account", type: "action", value: S.me ? (S.me.display_name || S.me.id) : "Logged in", go: "LOG OUT" },
      { key: "clientId", label: "Client ID", type: "text", value: s.clientId || "", go: "EDIT" },
      { key: "activity", label: "Spotify activity", type: "action", value: this.activityText(), go: "COPY LOG" },
      { key: "manageLibrespot", label: "Audio engine", type: "toggle", on: !!s.manageLibrespot, value: s.manageLibrespot ? (ENGINE_TEXT[e.state] || "") : "OFF (another app provides audio)" },
      { key: "eqEngine", label: "Sound engine (EQ)", type: "toggle", on: !EQ.state || EQ.state.engine !== false, value: "Plays Spotify through Cadenza, so the EQ and boost work" },
      { key: "restart", label: "Restart engine", type: "action", value: "Fixes most audio hiccups", go: "RESTART" },
      { key: "deviceName", label: "Device name", type: "text", value: s.deviceName || "Cadenza", go: "EDIT" },
      { key: "librespotPath", label: "librespot path", type: "text", value: s.librespotPath || ("Automatic: " + (e.path || "not found")), raw: s.librespotPath || "", go: "EDIT" },
      { key: "bitrate", label: "Quality", type: "cycle", value: (s.bitrate || 320) + " KBPS", go: "CHANGE" },
      { key: "djVoiceId", label: "DJ voice", type: "action", value: this.voiceText(), go: "CHANGE" },
      { key: "normalize", label: "Even loudness", type: "toggle", on: s.normalize !== false, value: "Keeps every song at a similar volume (restarts the audio engine)" },
      { key: "sfx", label: "Click sounds", type: "toggle", on: s.sfx !== false, value: "Small themed sounds when you choose, go back or change page" },
      { key: "sfxVolume", label: "Click volume", type: "cycle", value: ({ 25: "Quiet", 55: "Medium", 85: "Loud" })[s.sfxVolume ?? 55] || (s.sfxVolume + "%"), go: "CHANGE" },
      { key: "eqPerDevice", label: "EQ per device", type: "toggle", on: s.eqPerDevice !== false, value: "AirPods, speakers and headphones each remember their own EQ" },
      { key: "aiTags", label: "AI playlist tags", type: "toggle", on: S.settings.aiTags !== false, value: Tags.reasonText() },
      { key: "retag", label: "Re-tag playlists", type: "action", value: "Make fresh tags for every playlist", go: "RUN" },
      { key: "autoplay", label: "Autoplay", type: "toggle", on: s.autoplay !== false, value: "Keep playing similar songs after a single song, album or playlist ends" },
      { key: "themedCovers", label: "Album covers", type: "toggle", on: !!s.themedCovers, value: s.themedCovers ? "In the theme's colours" : "Original artwork" },
      { key: "trueShuffle", label: "True shuffle", type: "toggle", on: s.trueShuffle !== false, value: "Cadenza shuffles playlists itself, with every order equally likely (Spotify's shuffle isn't)" },
      { key: "notifications", label: "Song notifications", type: "toggle", on: S.settings.notifications !== false, value: "Pop-up when the track changes (while Cadenza is in the background)" },
      { key: "menuBar", label: "Menu-bar player", type: "toggle", on: S.settings.menuBar !== false, value: "Album cover in the menu bar with a mini player" },
      { key: "mediaKeys", label: "Media keys", type: "toggle", on: !!s.mediaKeys, value: s.mediaKeys && !s.mediaKeysTrusted ? "Allow Cadenza in Settings → Privacy → Accessibility" : "Play/pause, next and previous keys" },
      { key: "globalHotkey", label: "⌥⌘P shortcut", type: "toggle", on: !!s.globalHotkey, value: "Show or hide Cadenza from anywhere" },
      { key: "openAtLogin", label: "Open at login", type: "toggle", on: !!s.openAtLogin, value: "Start with your Mac" },
      { key: "commands", label: "Commands", type: "action", value: "Every shortcut and command in one list", go: "OPEN  ⌘/" },
      { key: "stage", label: "Stage mode", type: "action", value: "Full screen: big cover, synced lyrics and the visualizer", go: "OPEN  F" },
      { key: "discord", label: "Discord status", type: "toggle", on: !!s.discord, value: Links.discordText() },
      { key: "discordAppId", label: "Discord app ID", type: "text", value: s.discordAppId || "Not set (discord.com/developers → New Application)", raw: s.discordAppId || "", go: "EDIT" },
      { key: "lastfmAccount", label: "Last.fm account", type: "action", value: Links.lastfmText(), go: Links.lastfm && Links.lastfm.loggedIn ? "LOG OUT" : "LOG IN" },
      { key: "lastfmKey", label: "Last.fm API key", type: "text", value: s.lastfmKey || "Not set (last.fm/api/account/create)", raw: s.lastfmKey || "", go: "EDIT" },
      { key: "lastfmSecret", label: "Last.fm secret", type: "text", value: s.lastfmSecret ? "Saved (hidden)" : "Not set", raw: "", go: "EDIT" },
      { key: "geniusToken", label: "Genius token", type: "text", value: s.geniusToken ? "Saved (hidden) · lets Search find songs from a lyric" : "Not set (genius.com/api-clients → Generate Access Token) · for Search → Lyrics", raw: "", go: "EDIT" },
      { key: "crossfade", label: "Crossfade", type: "cycle", value: (s.crossfade ?? 6) ? `${s.crossfade ?? 6} seconds: the end of each song blends into the next` : "Off: songs follow each other with no overlap", go: "CHANGE" },
      { key: "devices", label: "Devices", type: "action", value: (S.player && S.player.device) ? "Playing on " + S.player.device + " · speakers, AirPods, Spotify Connect" : "Speakers, AirPods, Bluetooth and Spotify Connect devices", go: "OPEN" },
      { key: "stats", label: "Listening stats", type: "action", value: LFM.ready() ? "Your whole history from Last.fm: top artists and songs, plays, when you listen" : "Your top artists and songs (connect Last.fm for your whole history)", go: "OPEN" },
      { key: "friends", label: "Friends", type: "action", value: LFM.ready() ? "What your Last.fm friends are playing, and how close your taste is" : "Connect Last.fm to see your friends", go: "OPEN" },
      { key: "diagnostics", label: "Copy diagnostics", type: "action", value: "Copies the engine log, recent events and settings (no passwords) to paste into a bug report", go: "COPY" },
      { key: "update", label: "Updates", type: "action", value: Links.updateText(), go: Links.update && Links.update.state === "available" ? "INSTALL" : "CHECK" },
      { key: "updateRepo", label: "GitHub repository", type: "text", value: s.updateRepo || "Not set (owner/name)", raw: s.updateRepo || "", go: "EDIT" },
      { key: "autoUpdate", label: "Check at launch", type: "toggle", on: s.autoUpdate !== false, value: "Look for a new release when Cadenza opens (every 6 hours at most)" },
    ];
  },
  voiceText() {
    const v = this.voices, cur = v && (v.voices.find((x) => x.id === v.current) || v.voices[0]);
    if (!v) return "Loading voices…";
    if (!cur) return "No natural voices installed: add one in System Settings → Accessibility → Spoken Content";
    return `${cur.name} · ${cur.quality}` + (cur.quality === "Standard" ? "  (download Premium voices for a more natural sound)" : "");
  },
  async nextVoice() {
    const v = this.voices;
    if (!v || !v.voices.length) return toast("NO NATURAL VOICES INSTALLED", true);
    const i = Math.max(0, v.voices.findIndex((x) => x.id === v.current));
    const next = v.voices[(i + (v.current ? 1 : 1)) % v.voices.length];
    v.current = next.id;
    await native("speak.setVoice", { id: next.id }).catch(() => {});
    toast("DJ VOICE: " + upper(next.name) + " · " + upper(next.quality));
    native("speak", { text: `Hey, it's ${next.name}. I'll be your DJ tonight.` }).catch(() => {});
    this.refresh(false);
  },
  activityText() {
    const a = this.activity || {};
    if (a.blockedFor > 0) return "Blocked by Spotify · " + fmtWait(a.blockedFor).toLowerCase() + " left";
    if (a.lastMinute == null) return "—";
    return a.lastMinute + " requests in the last minute" + (a.lastRetryAfter ? " · last block " + fmtWait(a.lastRetryAfter).toLowerCase() : "");
  },
  async copyActivity() {
    let a = null;
    try { a = await native("api.activity"); } catch (e) { /* demo */ }
    const text = a ? [`Cadenza · ${a.total} requests in ${Math.round(a.uptime / 60)} min · blocked for ${a.blockedFor}s · last Retry-After ${a.lastRetryAfter}s`, ...a.log].join("\n") : "No activity yet";
    try { await native("clipboard", { text }); } catch (e) { /* demo */ }
    toast("SPOTIFY ACTIVITY LOG COPIED");
  },
  async show() {
    await this.refresh(true);
    clearInterval(this.timer);
    this.timer = setInterval(() => { if (!document.hidden) this.refreshLog(); }, 2000);
  },
  leave() { clearInterval(this.timer); this.editing = null; this.group = null; },
  async refresh(first) {
    try {
      const [s, e, a] = await Promise.all([native("settings.get"), native("librespot.status"), native("api.activity").catch(() => null)]);
      if (a) this.activity = a;
      if (!this.voices) { try { this.voices = await native("speak.voices"); } catch (e) { this.voices = null; } }
      await Links.load();
      if (s) S.settings = s;
      if (e) S.engine = e;
    } catch (err) { /* keep old */ }
    if (!S.me) loadMe();
    const keep = this.list.i;
    if (first) this.group = null;
    this.list.set(this.options());
    this.list.select(first ? 0 : Math.min(keep, this.list.items.length - 1), false);
    this.layout();
    this.renderLog();
  },
  async refreshLog(status) {
    if (status) S.engine = status;
    else { try { S.engine = await native("librespot.status"); } catch (e) { return; } }
    this.renderLog();
    const row = this.list.el.querySelector('[data-key="manageLibrespot"]');
    if (row && !this.editing) {
      const v = row.querySelector(".v");
      const t = S.settings.manageLibrespot ? (ENGINE_TEXT[S.engine.state] || "") : "OFF (another app provides audio)";
      if (v.textContent !== t) v.textContent = t;
    }
    try { const a = await native("api.activity"); if (a && typeof a === "object") this.activity = a; } catch (e) { /* ignore */ }
    const ar = this.list.el.querySelector('[data-key="activity"] .v');
    if (ar && !this.editing && ar.textContent !== this.activityText()) ar.textContent = this.activityText();
  },
  renderLog() {
    const e = S.engine || {};
    $("sys-log-h").textContent = "AUDIO ENGINE  ·  " + (ENGINE_TEXT[e.state] || "UNKNOWN") + (e.deviceName ? "  ·  \"" + e.deviceName + "\"" : "");
    $("sys-log-body").textContent = (e.log || []).slice(-8).join("\n") || "No output yet.";
  },
  async set(key, value) {
    const oldId = S.settings.clientId;
    try { const s = await native("settings.set", { key, value }); if (s) S.settings = s; } catch (e) { /* ignore */ }
    if (key === "themedCovers") { S.settings.themedCovers = !!value; Covers.refresh(); }
    if (key === "clientId" && String(value).trim() && String(value).trim() !== oldId) {
      // A different Spotify app: the old login belongs to the old Client ID, so sign in again.
      toast("NEW CLIENT ID: LOG IN TO SPOTIFY AGAIN");
      coolUntil = 0;
      PageCache.m.clear();
      return this.logout();
    }
    await this.refresh(false);
  },
  act(o) {
    if (!o || busy || this.editing) return;
    if (o.type === "group") return this.openGroup(o.key.slice(4) || null);
    if (o.key === "djVoiceId") return this.nextVoice();
    if (o.key === "crossfade") {                                   // Off, 3, 6, 9, 12 seconds (like Spotify's slider)
      const steps = [0, 3, 6, 9, 12], v = S.settings.crossfade ?? 6;
      const next = steps[(steps.indexOf(v) + 1) % steps.length] ?? 6;
      return this.set("crossfade", next).then(() => toast(next ? `CROSSFADE: ${next} SECONDS (FROM THE NEXT SONG)` : "CROSSFADE OFF"));
    }
    if (o.key === "sfxVolume") {
      const steps = [25, 55, 85], v = S.settings.sfxVolume ?? 55;
      return this.set("sfxVolume", steps[(steps.indexOf(v) + 1) % steps.length] ?? 55).then(() => Sfx.play("confirm"));
    }
    if (o.key === "eqEngine") {
      return native("eq.engine", { on: !o.on }).catch(() => {}).then(() => EQ.load()).then(() => { toast(o.on ? "SOUND ENGINE OFF: EQ DISABLED" : "SOUND ENGINE ON"); this.refresh(false); });
    }
    if (o.type === "toggle") return this.set(o.key, !o.on).then(() => (o.key === "discord" ? setTimeout(() => { sendNowPlaying(true); this.refresh(false); }, 1500) : null));
    if (o.key === "commands") return go("commands");
    if (o.key === "stage") return Stage.open();
    if (o.key === "lastfmAccount") return Links.lastfm && Links.lastfm.loggedIn ? native("lastfm.logout").then(() => { toast("LOGGED OUT OF LAST.FM"); this.refresh(false); }) : Links.lastfmLogin();
    if (o.key === "update") return Links.update && Links.update.state === "available" && Links.update.found ? Links.offer(Links.update.found) : Links.check(true);
    if (o.key === "theme") return switchTheme();
    if (o.key === "bitrate") { const opts = [96, 160, 320]; return this.set("bitrate", opts[(opts.indexOf(S.settings.bitrate || 320) + 1) % 3]); }
    if (o.key === "retag") { if (!Tags.enabled()) return toast(upper(Tags.reasonText()), true); return Tags.retagAll(); }
    if (o.key === "restart") { native("librespot.restart"); toast("RESTARTING AUDIO ENGINE"); return; }
    if (o.key === "account") return this.logout();
    if (o.key === "activity") return this.copyActivity();
    if (o.key === "stats") return go("stats");
    if (o.key === "devices") return go("output");
    if (o.key === "friends") return go("friends");
    if (o.key === "diagnostics") return copyDiagnostics();
    if (o.type === "text") return this.edit(o);
  },
  edit(o) {
    const row = this.list.rows[this.list.i], v = row.querySelector(".v");
    const input = h("input");
    input.value = o.raw != null ? o.raw : o.value;
    input.spellcheck = false;
    v.textContent = ""; v.append(input);
    this.editing = o.key;
    input.focus(); input.select();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); this.editing = null; this.set(o.key, input.value); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.editing = null; this.refresh(false); }
    });
    input.addEventListener("blur", () => { if (this.editing === o.key) { this.editing = null; this.refresh(false); } });
  },
  async logout() {
    await native("auth.logout");
    S.loggedIn = false; S.me = null; S.playlists = null; S.player = null;
    coolUntil = 0;                                   // a new login starts with a clean slate
    renderNow();
    go("setup", {}, { reset: true });
  },
  onKey(e, typing) {
    if (typing) return e.key === "Enter" || e.key === "Escape";
    if (this.group && (e.key === "Escape" || e.key === "Backspace")) { this.openGroup(null); return true; }
    if (this.list.nav(e)) return true;
    if (e.key === "Enter") { pop(this.list.rows[this.list.i], this.list.cur && this.list.cur.type === "toggle" ? "toggle" : "confirm"); this.act(this.list.cur); return true; }
    return false;
  },
};

/* =====================================================================
   SETUP: first run / logged out
   ===================================================================== */
views.setup = {
  el: $("v-setup"), working: false,
  keys: () => [["⏎", "LOG IN", () => views.setup.login()]],
  async show(params) {
    try {
      const st = await native("auth.status");
      if (st) { $("setup-cid").value = st.clientId || ""; $("setup-uri").textContent = st.redirectURI || "http://127.0.0.1:8888"; }
    } catch (e) { /* ignore */ }
    $("setup-msg").textContent = (params && params.reason) || "";
    setTimeout(() => $("setup-cid").focus(), 80);
  },
  async login() {
    if (this.working) return;
    const cid = $("setup-cid").value.trim();
    const msg = $("setup-msg");
    if (!/^[0-9a-f]{32}$/i.test(cid)) { msg.textContent = "That doesn't look like a Client ID: it should be 32 letters and numbers."; return; }
    this.working = true;
    msg.textContent = "";
    msg.append(h("span", "spinner"), "  Waiting for you to approve in your browser…");
    await native("auth.setClientId", { clientId: cid });
    let r;
    try { r = await native("auth.login"); } catch (e) { r = { ok: false, message: String(e) }; }
    this.working = false;
    if (r && r.ok) {
      msg.textContent = "LOGGED IN";
      S.loggedIn = true;
      await go("home", {}, { reset: true, force: true, dir: -1 });
      poll(); loadPlaylists();
    } else {
      msg.textContent = (r && r.message) || "Login failed.";
    }
  },
  onKey(e) {
    if (e.key === "Enter") { this.login(); return true; }
    if (e.key === "Escape" || e.key === "Backspace") return e.target === document.body;
    return false;
  },
};
$("setup-go").onclick = () => views.setup.login();

/* =====================================================================
   Add-to-playlist drawer
   ===================================================================== */
/** Label with an optional leading icon (track menu, DJ actions). */
function fillLabel(el, o) {
  el.textContent = "";
  if (o.icon) el.append(icon(o.icon));
  el.append(o.name != null ? o.name : o.label);
}
const Drawer = {
  isOpen: false, track: null, creating: false, mode: "add",
  list: new List($("drawer-list"), {
    render: (p) => {
      const r = h("div", "opt" + (p.kind === "new" ? " new" : "") + (p.kind === "act" ? " act" : ""));
      const inn = h("div", "in");
      const k = h("span", "k"); fillLabel(k, p);
      inn.append(k);
      if (p.kind === "act") { if (p.hint) inn.append(h("span", "go", upper(p.hint))); }
      else if (p.kind !== "new") { const n = plCount(p); inn.append(h("span", "go", n != null ? n + "" : "")); }
      r.append(inn);
      return r;
    },
    onActivate: (p) => Drawer.pick(p),
  }),
  /** A list of actions in the side panel (playlist tools and similar). */
  actions(title, what, items) {
    this.track = { tools: true }; this.isOpen = true; this.creating = false; this.mode = "menu";
    $("drawer-title").innerHTML = title;
    $("drawer-what").textContent = what;
    $("drawer").classList.add("on"); $("scrim").classList.add("on");
    this.list.set(items);
    this.list.select(0, false);
    revealRows(this.list.el);
  },
  menu(t, items) {
    this.track = t; this.isOpen = true; this.creating = false; this.mode = "menu";
    $("drawer-title").innerHTML = "TRACK<br>OPTIONS";
    $("drawer-what").textContent = upper(t.name) + "  ·  " + artistNames(t);
    $("drawer").classList.add("on"); $("scrim").classList.add("on");
    this.list.set(items);
    revealRows(this.list.el);
  },
  async show(t) {
    this.track = t; this.isOpen = true; this.creating = false; this.mode = "add";
    $("drawer-title").innerHTML = "ADD TO<br>PLAYLIST";
    $("drawer-what").textContent = upper(t.name) + "  ·  " + artistNames(t);
    $("drawer").classList.add("on"); $("scrim").classList.add("on");
    this.list.set([{ kind: "new", name: "+ NEW PLAYLIST" }]);
    const lists = await loadPlaylists();
    if (!this.isOpen) return;
    const own = lists.filter(isOwned);
    this.list.set([{ kind: "new", name: "+ NEW PLAYLIST" }, ...own]);
    this.list.select(own.length ? 1 : 0, false);
    revealRows(this.list.el);
  },
  hide() {
    this.isOpen = false; this.creating = false;
    $("drawer").classList.remove("on"); $("scrim").classList.remove("on");
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest("#drawer")) document.activeElement.blur();
  },
  async pick(p) {
    if (!p || !this.track) return;
    if (p.kind === "act") { if (!p.keep) this.hide(); return p.run(); }
    if (p.kind === "new") return this.create();
    const r = await api("POST", `/playlists/${p.id}/items`, { uris: [this.track.uri] });
    if (r.status < 300) {
      toast("ADDED TO " + upper(p.name));
      if (p.items && p.items.total != null) p.items.total++;
      else if (p.tracks && p.tracks.total != null) p.tracks.total++;
      if (r.body && r.body.snapshot_id) p.snapshot_id = r.body.snapshot_id;
      Tags.schedule([p]);                                 // new song → fresh tags
      this.hide();
    } else toast(errMsg(r), true);
  },
  create() {
    if (this.creating) return;
    this.creating = true;
    const row = this.list.rows[0], k = row.querySelector(".k");
    const input = h("input");
    input.placeholder = "Playlist name";
    input.style.cssText = "width:100%;font-size:2.6vh;color:inherit";
    k.textContent = ""; k.append(input);
    input.focus();
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.creating = false; k.textContent = "+ NEW PLAYLIST"; input.blur(); return; }
      if (e.key !== "Enter") return;
      e.preventDefault(); e.stopPropagation();
      const name = input.value.trim();
      if (!name) return;
      input.disabled = true;
      const r = await api("POST", "/me/playlists", { name, public: false, description: "Made with Cadenza" });
      if (r.status < 300 && r.body && r.body.id) {
        const pl = r.body;
        if (!pl.items && !pl.tracks) pl.items = { total: 0 };
        if (S.playlists) S.playlists.unshift(pl);
        this.creating = false;
        await this.pick(pl);
      } else { toast(errMsg(r), true); input.disabled = false; input.focus(); }
    });
  },
  onKey(e, typing) {
    if (typing) return false;
    if (e.key === "Escape" || e.key === "Backspace" || e.key === "ArrowLeft") { this.hide(); return true; }
    if (this.list.nav(e)) return true;
    if (e.key === "Enter") { pop(this.list.rows[this.list.i]); this.pick(this.list.cur); return true; }
    return true;   // swallow everything else while the drawer is open
  },
};
$("scrim").onclick = () => Drawer.hide();

/* =====================================================================
   Keyboard, mouse, native events
   ===================================================================== */
async function switchTheme() {
  if (busy || Theme.list.length < 2) return;
  const from = Theme.current ? Theme.current.id : Theme.list[0].id;
  if (from === "rogue" && !(await Breach.gate())) return;           // Ogmi.os doesn't give up the screen easily
  const id = Theme.next(from);
  if (from === "rogue") Breach.farewell();
  try { const s = await native("settings.set", { key: "theme", value: id }); if (s) S.settings = s; } catch (e) { /* demo */ }
  const behindWhite = !!Breach.whiteBox;                            // Ogmi.os just broke: swap under the white flash
  await Theme.apply(id, !behindWhite);
  if (behindWhite) Breach.clearWhite(id);
  if (from !== "rogue") toast("THEME: " + Theme.meta(id).name);
  sendNowPlaying(true);
  if (current() && current().name === "system") views.system.refresh(false);
}

function openSearch() {
  if (current() && current().name === "search") { views.search.input.focus(); views.search.input.select(); }
  else go("search");
}

document.addEventListener("keydown", (e) => {
  const typing = !!(e.target && e.target.matches && e.target.matches("input, textarea"));
  if (Palette.isOpen) { if (Palette.onKey(e)) e.preventDefault(); return; }
  if (Stage.isOpen && !Modal.isOpen) { if (Stage.onKey(e)) e.preventDefault(); return; }
  if (Modal.isOpen) { if (Modal.onKey(e)) e.preventDefault(); return; }
  if (Drawer.isOpen) { if (Drawer.onKey(e, typing)) e.preventDefault(); return; }
  const c = current();
  if (!c) return;
  if (e.metaKey || e.ctrlKey) {
    if (!S.loggedIn) return;
    if (e.metaKey && e.key === "ArrowUp") { e.preventDefault(); setVolume(((S.player && S.player.volume) ?? 50) + 5); toast("VOLUME " + S.player?.volume + "%"); }
    else if (e.metaKey && e.key === "ArrowDown") { e.preventDefault(); setVolume(((S.player && S.player.volume) ?? 50) - 5); toast("VOLUME " + S.player?.volume + "%"); }
    else if (e.metaKey && e.key === "ArrowRight") { e.preventDefault(); cmd("next"); }
    else if (e.metaKey && e.key === "ArrowLeft") { e.preventDefault(); cmd("previous"); }
    else if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); Stage.toggle(); }
    else if (e.metaKey && e.key === "f") { e.preventDefault(); openSearch(); }
    else if (e.metaKey && e.key === ",") { e.preventDefault(); if (c.name !== "system") go("system"); }
    else if (e.metaKey && e.key === "/") { e.preventDefault(); if (c.name !== "commands") go("commands"); }
    else if (e.metaKey && e.key === "k") { e.preventDefault(); if (!Drawer.isOpen && !Modal.isOpen) Palette.open(); }
    else if (e.metaKey && e.key === "t") { e.preventDefault(); switchTheme(); }
    else if (e.metaKey && e.key === "s") { e.preventDefault(); pop(Controls.btn.shuffle); cmd("shuffle").then(() => Controls.render()); }
    else if (e.metaKey && e.key === "r") { e.preventDefault(); pop(Controls.btn.repeat); cmd("repeat").then(() => Controls.render()); }
    return;                                        // ⌘C / ⌘V / ⌘A etc. pass through
  }
  if (busy && ["Enter", "Escape", "Backspace"].includes(e.key) && !typing) {
    e.preventDefault();
    if (!e.repeat) pendingKey = { key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, at: Date.now() };
    return;
  }
  if (!typing && c.name !== "setup") {
    if (e.key === " ") { e.preventDefault(); if (!e.repeat) cmd("toggle"); return; }
    if (e.key === "/") { e.preventDefault(); openSearch(); return; }
    if (c.name !== "search" && !e.altKey) {
      const k = e.key.toLowerCase();
      const sel = c.view.list && c.view.list.cur;
      if (k === "l") { e.preventDefault(); toggleLike(); return; }
      if (k === "c") { e.preventDefault(); const it = S.player && S.player.item; if (it) copyLink(it.uri, it.name); return; }
      if (k === "m") { e.preventDefault(); TrackMenu.show(isTrack(sel) ? sel : S.player && S.player.item && S.player.item.raw); return; }
    }
  }
  if (c.view.onKey && c.view.onKey(e, typing)) { e.preventDefault(); return; }
  if (!typing && c.name !== "setup" && c.name !== "search" && !e.altKey && e.key.toLowerCase() === "f") { e.preventDefault(); Stage.toggle(); return; }
  if (!typing && (e.key === "Escape" || e.key === "Backspace")) { e.preventDefault(); back(); }
});

document.addEventListener("contextmenu", (e) => { if (!e.altKey && !e.target.closest("input")) e.preventDefault(); });
// Mouse "back" button and two-finger swipe right go back too
document.addEventListener("mouseup", (e) => { if (e.button === 3) back(); });

$("np-artwrap").onclick = () => cmd("toggle");
$("np-like").onclick = (e) => { e.stopPropagation(); toggleLike(); };
(() => {
  const bar = $("np-vol");
  const at = (e) => { const r = bar.getBoundingClientRect(); return Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 100); };
  let dragging = false;
  bar.addEventListener("mousedown", (e) => { dragging = true; setVolume(at(e)); });
  addEventListener("mousemove", (e) => { if (dragging) setVolume(at(e)); });
  addEventListener("mouseup", () => { dragging = false; });
  bar.addEventListener("wheel", (e) => { e.preventDefault(); setVolume(((S.player && S.player.volume) ?? 50) + (e.deltaY < 0 ? 2 : -2)); }, { passive: false });
})();
// Clicking the artist or album under the song opens its page, the same one Search opens.
// Songs reported by Cadenza's own sound engine only come with names, so the first click looks the song
// up on Spotify (by its ID) to find the artist and album, and remembers the answer.
const npIds = {};
async function nowPlayingIds() {
  const it = S.player && S.player.item;
  if (!it) return null;
  const raw = it.raw || {}, a = raw.artists && raw.artists[0], al = raw.album;
  if (a && a.id && al && al.id) return { artist: a.id, album: al.id };
  if (npIds[it.uri]) return npIds[it.uri];
  const [, type, id] = String(it.uri || "").split(":");
  if (type !== "track" || !id) return null;
  const r = await api("GET", `/tracks/${id}`);
  if (r.status !== 200 || !r.body) return null;
  const t = r.body;
  if (S.player && S.player.item && S.player.item.uri === it.uri) S.player.item.raw = t;   // the song menu can use the full details too
  return (npIds[it.uri] = { artist: t.artists && t.artists[0] && t.artists[0].id, album: t.album && t.album.id });
}
/** Clicking the artist or album under Now Playing opens Search on the Artists or Albums tab, with the
 *  name filled in and that exact artist or album selected at the top, so ⏎ opens it. */
async function openFromNowPlaying(kind) {
  const it = S.player && S.player.item;
  if (!it || busy) return;
  const raw = it.raw || {};
  const q = kind === "artist"
    ? (raw.artists && raw.artists[0] && raw.artists[0].name) || String(it.artists || "").split(", ")[0]
    : (raw.album && raw.album.name) || it.album;
  if (!q) return;
  const idsP = nowPlayingIds().catch(() => null);            // looked up while the page slides in
  const v = views.search;
  if (!(current() && current().name === "search")) await go("search");
  v.setType(kind);
  v.input.value = q;
  v.q = null;                                                // run it even if this name is already in the box
  await v.run(q);
  const id = ((await idsP) || {})[kind];
  if (!id || v.type !== kind || v.q !== q) return;           // nothing to match, or you've typed something else
  let i = v.list.items.findIndex((x) => x && x.id === id);
  if (i < 0) {
    // Spotify's search didn't list it (a common name, say): fetch it and put it first.
    const r = await api("GET", `/${kind}s/${id}`);
    if (r.status !== 200 || !r.body || v.type !== kind || v.q !== q) return;
    v.list.set([r.body, ...v.list.items.filter((x) => x && x.id !== id)]);
    $("search-empty").hidden = true;
    revealRows(v.list.el);
    i = 0;
  }
  v.list.select(i);
}
$("np-artist").onclick = () => openFromNowPlaying("artist");
$("np-album").onclick = () => openFromNowPlaying("album");
document.querySelector("#now .bar").onclick = (e) => {
  const it = S.player && S.player.item;
  if (!it) return;
  const r = e.currentTarget.getBoundingClientRect();
  const ms = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * it.duration_ms);
  S.player.progress_ms = ms; S.stamp = Date.now(); tick(true);
  api("PUT", `/me/player/seek?position_ms=${ms}`).then(() => setTimeout(poll, 300));
};

/* ---------- What you were playing, for pressing Play when nothing is playing anywhere ----------
   Spotify's own "resume" (moving playback to Cadenza) replays whatever it saved last, which after a
   dropped connection can be a lone song with no playlist and a position past its end. Cadenza keeps
   its own note of the playlist, song and position (in this page's local storage, which is cheap to
   write every few seconds) and starts that instead. */
const LastPlayed = {
  KEY: "cadenzaLastPlayed", saved: null, savedKey: "", savedAt: 0, engine: null,
  /** Read the copy kept in Cadenza's own store (local storage may not survive every app update). */
  async load() {
    // Where the engine was when Cadenza last quit (saved by native code at the very end).
    try { const e = await native("store.get", { key: "enginePosition" }); if (e && e.uri) this.engine = e; } catch (e) { /* demo */ }
    try {
      const v = await native("store.get", { key: "lastPlayed" });
      if (v && v.uri && (!this.saved || v.at > this.saved.at)) this.saved = v;
      else if (v && v.lastContext && this.saved && !this.saved.lastContext) this.saved.lastContext = v.lastContext;   // noted before this arrived
    } catch (e) { /* demo */ }
  },
  note(p, pos) {
    const it = p.item;
    if (!it || !/^spotify:(track|episode):/.test(it.uri)) return;
    const artists = ((it.raw && it.raw.artists) || []).slice(0, 3).map((a) => ({ id: a.id, name: a.name }));
    // The last real playlist (or album, or Liked Songs) you played, and where you were in it. Kept even
    // while song radio or the DJ plays, so Play can put that playlist back behind a lone song.
    const prev = this.saved || this.get();
    // True shuffle plays its own song list, so Spotify reports no playlist: take it from true shuffle.
    const ts = TrueShuffle.active && TrueShuffle.src;
    const tsCtx = ts ? ts.uri || (ts.kind === "liked" && S.me ? `spotify:user:${S.me.id}:collection` : ts.kind === "album" && ts.id ? "spotify:album:" + ts.id : ts.id ? "spotify:playlist:" + ts.id : null) : null;
    const listCtx = this.isList(p.context) ? p.context : tsCtx;
    const lastContext = listCtx ? { uri: listCtx, track: it.uri } : (prev && prev.lastContext) || null;
    const v = { context: p.context || null, uri: it.uri, name: it.name, artists, position: Math.max(0, Math.round(pos)), duration: it.duration_ms || 0,
      lastContext, shuffle: !!(p.shuffle_state || TrueShuffle.active), at: Date.now() };
    try { localStorage.setItem(this.KEY, JSON.stringify(v)); } catch (e) { /* storage off: the store copy below still works */ }
    // The store is one file that's rewritten on every save, so only write it when the song, playlist or
    // play/pause changes, or once a minute.
    const key = v.context + "|" + v.uri + "|" + !!p.is_playing;
    this.saved = v;
    if (key !== this.savedKey || Date.now() - this.savedAt > 60000) {
      this.savedKey = key; this.savedAt = Date.now();
      native("store.set", { key: "lastPlayed", value: v }).catch(() => {});
    }
  },
  isList(ctx) { return !!ctx && (/^spotify:(playlist|album):/.test(ctx) || /:collection$/.test(ctx)); },
  /** The songs of a playlist, album or Liked Songs, in order (up to 300). null if Spotify won't share them. */
  async listTracks(ctx) {
    const out = [];
    let path = null;
    if (/:collection$/.test(ctx)) path = "/me/tracks?limit=50";
    else if (/^spotify:playlist:/.test(ctx)) path = `/playlists/${ctx.split(":")[2]}/items?limit=100`;
    else if (/^spotify:album:/.test(ctx)) path = `/albums/${ctx.split(":")[2]}/tracks?limit=50`;
    for (let n = 0; path && n < 8 && out.length < 300; n++) {
      const r = await api("GET", path);
      if (r.status !== 200 || !r.body) return out.length ? out : null;
      (r.body.items || []).forEach((e) => { const t = e && (e.item || e.track || e); if (t && t.uri && !t.is_local && /^spotify:track:/.test(t.uri)) out.push(t.uri); });
      path = relPath(r.body.next);
    }
    return out;
  },
  get() {
    let v = null;
    try { v = JSON.parse(localStorage.getItem(this.KEY) || "null"); } catch (e) { v = null; }
    if (!v || (this.saved && this.saved.at > v.at)) v = this.saved;
    if (!v || !v.uri || Date.now() - v.at >= 14 * 86400e3) return null;
    // The page's note can be a little behind (it's saved every few seconds, and the durable copy less
    // often). The engine's position from when Cadenza quit is exact: use it for the same song.
    const e = this.engine;
    if (e && e.uri === v.uri && e.at >= v.at - 5000) v = { ...v, position: e.position_ms, duration: e.duration_ms || v.duration };
    return v;
  },
  /** Start what you were playing on Cadenza's speaker. With no note yet, the last thing Spotify lists
   *  under recently played (it knows the playlist); Spotify's own resume only as a last resort. */
  async resumeOn(dev, override) {
    let v = this.get();
    if (override) v = { ...(v || {}), ...override, duration: override.uri === (v && v.uri) ? v.duration : 0 };
    if (!v) {
      const r = await api("GET", "/me/player/recently-played?limit=1");
      const e = r.status === 200 && r.body && r.body.items && r.body.items[0];
      if (e && e.track && e.track.uri) v = { context: (e.context && e.context.uri) || null, uri: e.track.uri, name: e.track.name, artists: e.track.artists || [], position: 0, duration: e.track.duration_ms || 0 };
    }
    if (!v) return api("PUT", "/me/player", { device_ids: [dev], play: true });
    let pos = v.position || 0;
    if (v.duration && pos > v.duration - 3000) pos = 0;                  // a position at (or past) the end
    const plain = { uris: [v.uri], position_ms: pos };
    const path = `/me/player/play?device_id=${enc(dev)}`;
    let lone = !v.context;
    let r;
    if (lone && v.lastContext) {
      // A lone song (song radio, the DJ, search…), but you were in a playlist before that: play the song,
      // then the rest of that playlist from where you left it (shuffled if you were shuffling).
      const list = await this.listTracks(v.lastContext.uri);
      if (list && list.length) {
        const at = list.indexOf(v.lastContext.track);
        let rest = at >= 0 ? list.slice(at + 1).concat(list.slice(0, at + 1)) : list;
        rest = rest.filter((u) => u !== v.uri);
        if (v.shuffle) rest = TrueShuffle.permute(rest);
        r = await api("PUT", path, { uris: [v.uri, ...rest].slice(0, 200), position_ms: pos });
        if (r.status < 300) {
          lone = false; toast("PICKING UP WHERE YOU LEFT OFF · YOUR PLAYLIST IS NEXT");
          // A shuffled list is Cadenza's shuffle, so let true shuffle own it. Otherwise turning shuffle off
          // would only switch off Spotify's (already off) shuffle, and the list would stay shuffled.
          if (v.shuffle) TrueShuffle.adopt(v.lastContext.uri, [v.uri, ...rest], 200);
        }
      } else {
        // Spotify won't list that playlist's songs (it isn't yours): go back into the playlist itself.
        r = await api("PUT", path, { context_uri: v.lastContext.uri, offset: { uri: v.lastContext.track } });
        if (r.status < 300) lone = false;
      }
    }
    if (!r || r.status >= 300) {
      r = await api("PUT", path, v.context ? { context_uri: v.context, offset: { uri: v.uri }, position_ms: pos } : plain);
      if (v.context && (r.status === 400 || r.status === 404)) { r = await api("PUT", path, plain); lone = true; }
    }
    // A song on its own (it came from song radio, the DJ, search…): line up similar songs behind it, so
    // Next and the end of the song have somewhere to go.
    if (lone && r.status < 300 && Radio.enabled() && /^spotify:track:/.test(v.uri)) {
      setTimeout(() => { if (!Radio.active && !DJ.active && !TrueShuffle.active) Radio.begin({ uri: v.uri, name: v.name || "", artists: v.artists || [] }); }, 1500);
    }
    if (r.status >= 300) r = await api("PUT", "/me/player", { device_ids: [dev], play: true });
    return r;
  },
};

/* ---------- Picking the music back up after Spotify drops the audio engine's connection ----------
   Native code restarts librespot the moment Spotify closes its connection, then sends what was playing
   ({uri, position_ms, duration_ms}). A fresh librespot has no playlist attached, so start the same thing
   again at the same song and second: the DJ set, the song radio, the true-shuffle order, or the playlist
   or album Spotify was playing. */
const Resume = {
  async run(d) {
    const uri = d.uri || (S.player && S.player.item && S.player.item.uri);
    if (!uri) return;
    // Right at the end of a song: start it a moment before the end, so it finishes and the list moves on.
    let pos = Math.max(0, d.position_ms || 0);
    if (d.duration_ms && pos > d.duration_ms - 3000) pos = Math.max(0, d.duration_ms - 1500);
    let ok = false;
    try {
      // Play straight onto the new librespot by its ID. (Moving playback to it first made it start the
      // old song from Spotify's saved state, and a second later the right one.)
      const id = d.retry ? null : await ourDevice();
      const on = id ? { device_id: id } : {};
      if (DJ.active && DJ.order && DJ.order.length) {
        const i = Math.max(0, DJ.indexOf(uri));
        DJ.at = i;
        ok = await playBody({ uris: DJ.order.slice(i, i + 100), offset: { uri: DJ.order[i] }, position_ms: pos, ...on }, null, true);
      } else if (TrueShuffle.active && TrueShuffle.order.length) {
        const i = TrueShuffle.order.indexOf(uri);
        if (i >= 0) TrueShuffle.at = i;
        TrueShuffle.device = id;
        ok = await TrueShuffle.play(null, i >= 0 ? pos : 0);
      } else if (Radio.active) {
        ok = await playBody({ uris: [uri], position_ms: pos, ...on }, null, false, true);
        if (ok) { Radio.qd = []; Radio.queueNext(); }      // the new engine has an empty queue: hand the next songs over again
      } else if (S.player && S.player.context) {
        const plain = { uris: [uri], position_ms: pos, ...on };
        ok = await playBody({ context_uri: S.player.context, offset: { uri }, position_ms: pos, fallback: plain, ...on }, null);
      } else if (id) {
        // A lone song: the same as pressing Play, with your last playlist lined up behind it.
        const r = await LastPlayed.resumeOn(id, { uri, position: pos, context: null });
        ok = r && r.status < 300;
        if (ok) setTimeout(poll, 400);
      } else {
        ok = await playBody({ uris: [uri], position_ms: pos }, null);
      }
    } catch (e) { console.error(e); }
    if (ok) toast(d.retry ? "A SONG DIDN'T LOAD · TRYING IT AGAIN" : "SPOTIFY DROPPED THE CONNECTION · PICKED UP WHERE YOU WERE");
  },
};

/** Commands from the Controls menu in the Mac menu bar. */
function runCommand(name) {
  if (!S.loggedIn || !name) return;
  if (Modal.isOpen) Modal.close(null);
  if (Palette.isOpen) Palette.close();
  if (name.startsWith("go:")) {
    const id = name.slice(3);
    if (Stage.isOpen) Stage.close();
    if (current() && current().name === id) return;
    return id === "home" ? go("home", {}, { reset: true, dir: -1 }) : go(id);
  }
  const run = {
    toggle: () => cmd("toggle"), next: () => cmd("next"), previous: () => cmd("previous"),
    shuffle: () => cmd("shuffle").then(() => Controls.render()), repeat: () => cmd("repeat").then(() => Controls.render()),
    like: () => toggleLike(), stage: () => Stage.toggle(), palette: () => { if (Stage.isOpen) Stage.close(); Palette.open(); },
    search: () => { if (Stage.isOpen) Stage.close(); openSearch(); }, theme: () => switchTheme(), update: () => Links.check(true),
  }[name];
  if (run) run();
}

if (!bridge) window.__go = go;             // demo-mode testing hook
window.app = {
  onNative(event, data) {
    const c = current();
    if (event === "sleep" || event === "wake") {
      // The window was closed or minimised (sleep), or came back (wake). Asleep, the page stops
      // animating, drawing the visualizer and updating the clock, and checks Spotify only every 30 s.
      S.asleep = event === "sleep";
      if (window.__rest) window.__rest(S.asleep);
      if (!S.asleep) { shownImage = undefined; applyNow(); tick(true); poll(); }
    }
    else if (event === "engine.resume" && data) Resume.run(data);
    else if (event === "engine.end") { S.queueEndAt = Date.now(); setTimeout(() => { Radio.checkEnd(); Radio.watch(); }, 1200); }
    else if (event === "engine.refused" && data && data.uri) {
      // One song Spotify won't unlock right now. librespot already moves on; autoplay leaves it out for a while.
      (S.refused || (S.refused = new Map())).set(data.uri, Date.now());
      S.lastRefusal = Date.now();
      // librespot skips it, so it's no longer waiting in Spotify's queue.
      Radio.qd = Radio.qd.filter((u) => u !== data.uri);
    }
    else if (event === "refresh") poll();
    else if (event === "like") toggleLike();
    else if (event === "volume") setVolume(data && data.value);
    else if (event === "player") Local.update(data);
    else if (event === "command" && data) runCommand(data.cmd);
    else if (event === "url" && data) handleLink(data.action, data.query || {});
    else if (event === "lastfm" && data) {
      const was = LFM.user();
      Links.lastfm = data;
      if (LFM.user() !== was) { views.stats.lfm = {}; views.friends.loaded = false; views.friends.mine = null; PlayCounts.load(true); } if (c && c.name === "system" && !views.system.editing) views.system.refresh(false); }
    else if (event === "update" && data) {
      const was = Links.update && Links.update.state;
      Links.update = data;
      if (data.state === "available" && was !== "available" && data.found) toast("CADENZA " + data.found.version + " IS READY · SYSTEM → UPDATES");
      if (c && c.name === "system" && !views.system.editing) views.system.refresh(false);
    }
    else if (event === "eq.changed" && data) {
      EQ.state = data;
      if (current() && current().name === "eq") views.eq.render();
      views.home.update();
      toast("EQ FOR " + upper(data.device || "THIS OUTPUT") + ": " + upper(data.enabled ? data.preset || "Custom" : "Off"));
    }
    else if (event === "eq.levels" && data) { views.eq.levels(data.eq); Viz.feed(data.spec); }
    else if (event === "outputs") { if (c && c.name === "output") views.output.refresh(false); }
    else if (event === "librespot") {
      const prev = S.engine && S.engine.state;
      S.engine = data;
      if (data && data.state === "login" && prev !== "login") toast("FINISH SIGNING IN TO SPOTIFY IN YOUR BROWSER");
      const rec = data && data.recovering, prevRec = S.engineRec || "";
      S.engineRec = rec || "";
      if (rec && rec === prevRec) { /* already said */ }
      else if (rec === "restarting") toast("AUDIO ENGINE CRASHED · RESTARTING IT…", true);
      else if (rec === "recovered") toast("AUDIO ENGINE IS BACK");
      else if (rec === "gave-up") toast("AUDIO ENGINE KEEPS CRASHING · RESTART IT IN SYSTEM → ENGINE SETTINGS", true);
      else if (data && data.state === "running" && prev && prev !== "running") toast("AUDIO ENGINE READY");
      if (c && c.name === "system") views.system.refreshLog(data);
    } else if (event === "opened") {
      if (!busy && c) { setBusy(true); sweep(1); done(animateIn(c.view.el, -1)).then(() => setBusy(false)); }
    }
  },
};

/* =====================================================================
   STAGE MODE: full screen with a big cover, synced lyrics and the visualizer (F or ⌘⇧F)
   ===================================================================== */
const Stage = {
  el: $("stage"), isOpen: false, uri: null, lines: [], cur: -2, timer: 0, idle: 0, wasFull: null,
  toggle() { this.isOpen ? this.close() : this.open(); },
  async open() {
    if (this.isOpen || !S.loggedIn) return;
    if (Palette.isOpen) Palette.close();
    this.isOpen = true;
    this.uri = null;
    this.el.hidden = false;
    this.el.classList.remove("idle");
    Sfx.play("stage");
    this.render();
    Viz.start("stage");
    LyricSync.load();
    this.loop();
    this.wake();
    const m = motion(), box = this.el.querySelector(".sg-main");
    play(this.el, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: "linear", fill: "none" });
    play(box, m.intel.frames, { duration: m.intel.ms + 120, easing: m.intel.ease || OUT, fill: "none" });
    // Once Stage covers the screen, stop drawing what's underneath it (backgrounds, pages, panels).
    setTimeout(() => { if (this.isOpen) document.body.classList.add("staged"); }, 300);
    try { this.wasFull = await native("window.fullscreen", { on: true }); } catch (e) { this.wasFull = null; }
  },
  loop() {
    clearTimeout(this.timer);
    if (!this.isOpen) return;
    this.tick();
    this.timer = setTimeout(() => this.loop(), nextLyricIn(this.lines, 200));
  },
  async close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    document.body.classList.remove("staged");
    clearTimeout(this.timer); clearTimeout(this.idle);
    Viz.stop("stage");
    Sfx.play("back");
    const a = play(this.el, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "linear" });
    await a.finished.catch(() => {});
    a.cancel();
    if (!this.isOpen) this.el.hidden = true;
    if (this.wasFull === false) native("window.fullscreen", { on: false }).catch(() => {});
  },
  /** Mouse moved: show the pointer and hints for a moment, then get out of the way. */
  wake() {
    this.el.classList.remove("idle");
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.el.classList.add("idle"), 2600);
  },
  async render() {
    const it = S.player && S.player.item;
    const uri = it ? it.uri : "";
    if (uri === this.uri) return;
    this.uri = uri;
    this.lines = []; this.cur = -2;
    this.setLyric(-1);
    // Case is left to each theme's CSS (most shout in capitals; Studio doesn't).
    setText("sg-title", it ? cleanTitle(it.name) : "Nothing playing");
    setText("sg-artist", it ? it.artists : "Play something in Cadenza or Spotify");
    setText("sg-album", it ? [it.album, PlayCounts.text(PlayCounts.of(it))].filter(Boolean).join("  ·  ") : "");
    setBg($("sg-art"), it ? it.image : null);
    setBg($("sg-bg"), it ? it.image : null);
    if (this.isOpen) {
      const m = motion();
      play($("sg-art"), m.trackIn ? m.trackIn.frames : [{ opacity: 0 }, { opacity: 1 }], { duration: (m.trackIn && m.trackIn.ms) || 300, easing: OUT, fill: "none" });
    }
    if (!it) return;
    const res = await views.lyrics.fetch(it);
    if (this.uri !== uri) return;
    this.lines = res && res.synced ? views.lyrics.parse(res.synced).filter((l) => l.text.trim()) : [];
    this.el.classList.toggle("nolyrics", !this.lines.length);
    this.cur = -2;
    this.tick();
  },
  setLyric(i) {
    const L = this.lines, txt = (k) => (L[k] ? L[k].text : "");
    const box = $("sg-lyrics");
    const [p, c, n] = box.children;
    p.textContent = txt(i - 1); c.textContent = i >= 0 ? txt(i) : ""; n.textContent = i >= 0 ? txt(i + 1) : txt(0);
    if (this.isOpen && i >= 0) play(c, [{ opacity: 0.2, transform: "translate3d(0,1.6vh,0)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: OUT, fill: "none" });
  },
  tick() {
    if (!this.isOpen) return;
    const it = S.player && S.player.item;
    if ((it ? it.uri : "") !== this.uri) this.render();
    const pos = progressNow(), dur = it ? it.duration_ms : 0;
    setText("sg-pos", fmt(pos)); setText("sg-dur", fmt(dur));
    $("sg-fill").style.transform = `scaleX(${dur ? Math.min(1, pos / dur) : 0})`;
    this.el.classList.toggle("paused", !(S.player && S.player.is_playing));
    if (!this.lines.length) return;
    const at = LyricSync.pos();
    let i = -1;
    for (let k = 0; k < this.lines.length; k++) { if (this.lines[k].t <= at) i = k; else break; }
    if (i !== this.cur) { this.cur = i; this.setLyric(i); }
  },
  onKey(e) {
    const k = e.key.toLowerCase();
    if (e.key === "Escape" || (k === "f" && !e.metaKey) || (e.metaKey && e.shiftKey && k === "f")) { this.close(); return true; }
    if (e.metaKey && k === "k") { this.close().then(() => Palette.open()); return true; }
    if (e.metaKey && e.key === "ArrowRight") { cmd("next"); return true; }
    if (e.metaKey && e.key === "ArrowLeft") { cmd("previous"); return true; }
    if (e.metaKey && e.key === "ArrowUp") { setVolume(((S.player && S.player.volume) ?? 50) + 5); toast("VOLUME " + S.player?.volume + "%"); return true; }
    if (e.metaKey && e.key === "ArrowDown") { setVolume(((S.player && S.player.volume) ?? 50) - 5); toast("VOLUME " + S.player?.volume + "%"); return true; }
    if (e.metaKey) return false;                                   // ⌘Q, ⌘H… still work
    if (e.key === " ") { if (!e.repeat) cmd("toggle"); return true; }
    if (k === "l") { toggleLike(); return true; }
    return true;                                                   // everything else is ignored on stage
  },
};
Stage.el.addEventListener("mousemove", () => Stage.wake());
$("sg-art").onclick = () => cmd("toggle");
$("sg-exit").onclick = () => Stage.close();
Stage.el.addEventListener("dblclick", (e) => { if (!e.target.closest("#sg-art")) Stage.close(); });

/* =====================================================================
   cadenza:// LINKS: for the Shortcuts app, Siri (via Shortcuts), Raycast, Alfred, or Terminal's `open`
   ===================================================================== */
// e.g. cadenza://next · cadenza://playlist?name=Gym · cadenza://play?q=midnight%20tide · cadenza://sleep?minutes=30
const LINKS = [
  ["play / pause / toggle", "cadenza://toggle"], ["next / previous", "cadenza://next"], ["like the song", "cadenza://like"],
  ["volume (0–100, or up / down)", "cadenza://volume?level=40"], ["play a playlist (shuffle=1 to shuffle)", "cadenza://playlist?name=Gym"],
  ["search and play a song", "cadenza://play?q=midnight%20tide"], ["song radio from what's playing", "cadenza://radio"], ["start the DJ", "cadenza://dj"],
  ["open search", "cadenza://search?q=artist"], ["open a page", "cadenza://go?page=stats"], ["add the current song to Up Next", "cadenza://upnext"],
  ["sleep timer (minutes, end, off)", "cadenza://sleep?minutes=30"], ["floating mini player", "cadenza://mini"], ["show / hide Cadenza", "cadenza://show"],
];
async function handleLink(action, q) {
  const p = S.player, it = p && p.item;
  if (!S.loggedIn && action !== "go") return;
  switch (action) {
    case "toggle": case "playpause": return cmd("toggle");
    case "play": {
      if (!q.q) return p && p.is_playing ? null : cmd("toggle");
      const r = await api("GET", `/search?type=track&limit=1&q=${enc(q.q)}`);
      const t = r.body && r.body.tracks && r.body.tracks.items && r.body.tracks.items[0];
      if (!t) return toast("NOTHING FOUND FOR " + upper(q.q), true);
      return Radio.enabled() ? Radio.start(t) : playBody({ uris: [t.uri] }, t.name);
    }
    case "pause": return p && p.is_playing ? cmd("toggle") : null;
    case "next": case "skip": return cmd("next");
    case "previous": case "back": return cmd("previous");
    case "shuffle": return cmd("shuffle").then(() => Controls.render());
    case "repeat": return cmd("repeat").then(() => Controls.render());
    case "like": return toggleLike();
    case "volume": {
      const cur = (p && p.volume) != null ? p.volume : 50;
      const v = q.level === "up" ? cur + 10 : q.level === "down" ? cur - 10 : parseInt(q.level, 10);
      if (isFinite(v)) setVolume(v);
      return;
    }
    case "playlist": {
      const name = String(q.name || "").toLowerCase();
      const pl = (S.playlists || []).find((x) => x.name.toLowerCase() === name) || (S.playlists || []).find((x) => x.name.toLowerCase().includes(name));
      if (!pl) return toast("NO PLAYLIST CALLED " + upper(q.name || ""), true);
      const shuf = q.shuffle === "1" || q.shuffle === "true";
      if (shuf && TrueShuffle.enabled() && await TrueShuffle.start(pl)) return;
      await playBody({ context_uri: pl.uri }, pl.name);
      if (shuf) api("PUT", "/me/player/shuffle?state=true");
      return;
    }
    case "radio": return it ? Radio.start({ uri: it.uri, name: it.name, artists: (it.raw && it.raw.artists) || [] }, true) : toast("NOTHING PLAYING", true);
    case "dj": return DJ.start();
    case "upnext": return it ? queueTrack(it) : null;
    case "search": return go("search").then(() => { if (q.q) { views.search.input.value = q.q; views.search.run(q.q); } });
    case "go": {
      // Only real pages (a link like cadenza://go?page=constructor mustn't reach anything else).
      const page = String(q.page || "");
      if (!Object.prototype.hasOwnProperty.call(views, page) || page === "setup") return null;
      return page === "home" ? go("home", {}, { reset: true, dir: -1 }) : go(page);
    }
    case "stats": return go("stats");
    case "friends": return go("friends");
    case "sleep": {
      if (q.minutes === "off" || q.off != null || q.minutes === "0") return Sleep.cancel();
      if (q.minutes === "end" || q.end != null) return Sleep.set("end");
      const m = parseFloat(q.minutes || q.min || "30");
      return isFinite(m) && m > 0 ? Sleep.set(Math.min(m, 600)) : null;
    }
    default: toast("UNKNOWN LINK: CADENZA://" + upper(action || ""), true);
  }
}

/* =====================================================================
   COMMANDS: every shortcut in one list (System → Commands, ⌘/ or the Controls menu)
   ===================================================================== */
const COMMANDS = [
  ["PLAYBACK", "Play / pause", "SPACE", () => cmd("toggle")],
  ["PLAYBACK", "Next song", "⌘ →", () => cmd("next")],
  ["PLAYBACK", "Previous song", "⌘ ←", () => cmd("previous")],
  ["PLAYBACK", "Shuffle on / off", "⌘ S", () => cmd("shuffle").then(() => Controls.render())],
  ["PLAYBACK", "Cycle repeat", "⌘ R", () => cmd("repeat").then(() => Controls.render())],
  ["PLAYBACK", "Volume up / down", "⌘ ↑  ⌘ ↓"],
  ["PLAYBACK", "Like this song", "L", () => toggleLike()],
  ["PLAYBACK", "Copy the song's link", "C", () => { const it = S.player && S.player.item; if (it) copyLink(it.uri, it.name); }],
  ["PLAYBACK", "Song menu (queue, add, go to)", "M"],
  ["ANYWHERE", "Command palette: find any action", "⌘ K", () => Palette.open()],
  ["ANYWHERE", "Stage mode (full screen)", "F  ·  ⌘ ⇧ F", () => Stage.open()],
  ["ANYWHERE", "Search Spotify", "⌘ F  ·  /", () => openSearch()],
  ["ANYWHERE", "Switch theme", "⌘ T", () => switchTheme()],
  ["ANYWHERE", "Back", "ESC  ·  ⌫"],
  ["ANYWHERE", "System settings", "⌘ ,", () => go("system")],
  ["ANYWHERE", "This list", "⌘ /"],
  ["ANYWHERE", "Show / hide Cadenza from any app", "⌥ ⌘ P"],
  ["ANYWHERE", "Full screen window", "⌃ ⌘ F"],
  ["LISTS", "Move / choose", "↑ ↓  ·  ⏎"],
  ["LISTS", "Add a song to Up Next (Cadenza's own queue)", "Q"],
  ["LISTS", "Add a song to a playlist", "A"],
  ["PLAYLIST", "Play all", "P"],
  ["PLAYLIST", "Shuffle a playlist (in the palette)", "⇧ ⏎"],
  ["PLAYLIST", "Playlist tools: dedupe, sort, copy", "T"],
  ["PLAYLIST", "Move a song up / down", "⌥ ↑  ⌥ ↓"],
  ["PLAYLIST", "Remove a song", "X"],
  ["PLAYLIST", "Rename / delete", "R  ·  D"],
  ["LIBRARY", "New playlist", "N", () => go("library").then(() => views.library.create())],
  ["QUEUE", "Remove from Up Next  ·  move it", "X  ·  ⌥ ↑  ⌥ ↓"],
  ["QUEUE", "Clear Up Next", "C", () => UpNext.clear()],
  ["QUEUE", "Save the queue as a playlist", "S", () => go("queue").then(() => setTimeout(() => views.queue.save(), 900))],
  ["QUEUE", "Recently played", "H", () => go("history")],
  ["ALBUM", "Save album  ·  go to artist", "S  ·  G"],
  ["ARTIST", "Play  ·  follow", "P  ·  F"],
  ["EQ", "Pick a band  ·  ±1 dB", "← →  ·  ↑ ↓"],
  ["EQ", "Previous / next preset", "[  ]"],
  ["EQ", "EQ on / off  ·  reset band", "E  ·  0"],
  ["LYRICS", "Nudge lyrics earlier / later", "[  ]"],
  ["DJ", "Switch it up  ·  change voice", "S  ·  V", () => DJ.start()],
  ["SEARCH", "Songs / albums / artists / playlists", "TAB"],
  ["STAGE", "Play / pause  ·  skip  ·  like", "SPACE  ·  ⌘ ← →  ·  L"],
  ["STAGE", "Leave stage mode", "ESC  ·  F"],
  ["LYRICS", "Translate the lyrics", "T"],
  ["STATS", "Week / month / year / all time", "← →", () => go("stats")],
  ["STATS", "Import Spotify listening history", "I", () => go("stats").then(() => settled()).then(() => views.stats.importHistory())],
  ["STATS", "Switch source (Spotify / Last.fm / Cadenza)", "S", () => go("stats")],
  ["STATS", "Friends", "F", () => go("friends")],
  ["FRIENDS", "Play their song  ·  blend  ·  profile", "⏎  ·  B  ·  O", () => go("friends")],
  ["FRIENDS", "Add  ·  remove a friend", "+  ·  X"],
  ["ANYWHERE", "Floating mini player", "⇧ ⌘ M", () => native("mini.toggle").catch(() => {})],
  ["ANYWHERE", "Sleep timer (in the palette)", "⌘ K", () => { Palette.open(); setTimeout(() => { $("pal-q").value = "sleep"; Palette.filter(); }, 60); }],
  ...LINKS.map(([what, url]) => ["LINKS", "Link: " + what, url]),
];
views.commands = {
  el: $("v-commands"),
  keys: () => [["↑↓", "SELECT"], ["⏎", "RUN"], ["ESC", "BACK", back]],
  list: new List($("cmd-list"), {
    render: (c) => {
      const r = h("div", "opt st cmd" + (c[3] ? "" : " info"));
      const inn = h("div", "in");
      inn.append(h("span", "k", c[1]), h("span", "v", ""), h("span", "go", c[3] ? "RUN" : c[0]));
      const keys = inn.querySelector(".v");
      c[2].split(/\s+·\s+/).forEach((combo) => {
        const g = h("span", "combo");
        combo.split(/\s{2,}/).forEach((part, i) => { if (i) g.append(h("span", "sep", "/")); part.trim().split(" ").forEach((key) => g.append(h("kbd", null, key))); });
        keys.append(g);
      });
      r.append(inn);
      return r;
    },
    onActivate: (c) => views.commands.run(c),
  }),
  show(params, isBack) {
    if (isBack && this.list.items.length) return;
    this.list.set(COMMANDS);
    this.list.select(0, false);
    revealRows(this.list.el);
  },
  run(c) {
    if (!c) return;
    if (!c[3]) return toast(c[1].toUpperCase() + ": " + c[2]);
    c[3]();
  },
  onKey(e) {
    if (this.list.nav(e)) return true;
    if (e.key === "Enter") { pop(this.list.rows[this.list.i]); this.run(this.list.cur); return true; }
    return false;
  },
};

/* ---------- Integrations: Discord, Last.fm, updates ---------- */
const Links = {
  discord: null, lastfm: null, update: null,
  async load() {
    const [d, l, u] = await Promise.all([native("discord.status").catch(() => null), native("lastfm.status").catch(() => null), native("update.status").catch(() => null)]);
    if (d && typeof d === "object") this.discord = d;
    if (l && typeof l === "object") this.lastfm = l;
    if (u && typeof u === "object") this.update = u;
  },
  discordText() {
    const s = S.settings, d = this.discord;
    if (!s.discordAppId) return "Add a Discord application ID below first";
    if (!s.discord) return "Show what you're listening to on your Discord profile";
    return d && d.status ? "Status: " + d.status : "Starting…";
  },
  lastfmText() {
    const l = this.lastfm;
    if (!l || !l.hasKeys) return "Add your Last.fm API key and secret below first";
    if (!l.loggedIn) return "Not logged in · log in so Stats, play counts, the DJ and Friends can read your scrobbles";
    return l.user + " · scrobbles come from Spotify (link it in Last.fm's settings)" + (l.error ? " · " + l.error : "");
  },
  updateText() {
    const u = this.update;
    if (!u) return "—";
    if (!u.repo) return "Set the GitHub repository below · you have " + u.current;
    if (u.state === "available" && u.found) return "Version " + u.found.version + " is ready (you have " + u.current + ")";
    if (u.message) return u.message;
    return "You have " + u.current;
  },
  async lastfmLogin() {
    toast("APPROVE CADENZA ON LAST.FM IN YOUR BROWSER");
    let r = null;
    try { r = await native("lastfm.login"); } catch (e) { r = { ok: false, message: "Not available here" }; }
    if (r && r.ok) toast("LAST.FM: LOGGED IN AS " + upper(r.message || ""));
    else toast("LAST.FM: " + upper((r && r.message) || "LOGIN FAILED"), true);
    if (current() && current().name === "system") views.system.refresh(false);
  },
  async check(manual) {
    if (manual) toast("CHECKING FOR UPDATES…");
    let u = null;
    try { u = await native("update.check"); } catch (e) { /* demo */ }
    if (u && typeof u === "object") this.update = u;
    if (u && u.state === "available" && u.found) this.offer(u.found);
    else if (manual) toast(upper((u && u.message) || "COULDN'T CHECK FOR UPDATES"), !u || u.state === "error");
    if (current() && current().name === "system") views.system.refresh(false);
  },
  async offer(f) {
    const notes = String(f.notes || "").replace(/[#*_`>]/g, "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 6).join("\n");
    const ok = await Modal.open({ title: "UPDATE TO " + f.version + "?", text: (notes || "A new version of Cadenza is ready.") + "\n\nCadenza will close, update and reopen.", ok: "UPDATE" });
    if (ok) this.install();
  },
  async install() {
    toast("DOWNLOADING THE UPDATE…");
    let r = null;
    try { r = await native("update.install"); } catch (e) { r = { ok: false, message: "Not available here" }; }
    if (r && r.ok) toast("INSTALLING · CADENZA WILL REOPEN");
    else toast(upper((r && r.message) || "UPDATE FAILED"), true);
  },
};

/* =====================================================================
   Background, clock, boot
   ===================================================================== */
function clock() {
  if (S.asleep) return;
  const d = new Date();
  Theme.text($("c-date"), d.getMonth() + 1 + "/" + d.getDate(), "date");
  setText("c-dow", d.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase());
  setText("c-time", d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
}
function applyMotion() {
  reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;   // follows the Mac's own Reduce Motion setting
  document.body.classList.toggle("reduce", reduced);
}

async function boot() {
  if (!bridge) window.__dbg = { S, Stage, Viz, views, Sfx, DJ, Radio, UpNext, Sleep, TrueShuffle, Palette, PlayCounts, LFM, LastPlayed, Covers, Theme };   // demo-mode testing hook
  setInterval(clock, 10000);
  setInterval(() => { tick(false); Radio.note(); UpNext.tick(); Sleep.tick(); TrueShuffle.tick(); }, 1000);
  views.home.build();
  Controls.init();
  try { const s = await native("settings.get"); if (s) S.settings = s; } catch (e) { /* defaults */ }
  applyMotion();
  Tags.init();
  EQ.load().then(() => views.home.update());
  Viz.init();
  // The login check (which can refresh the token over the network) runs while the theme loads.
  const authP = native("auth.status").catch(() => null);
  const askedP = native("store.get", { key: "scopesAskedFor" }).catch(() => "");
  const urlTheme = new URLSearchParams(location.search).get("theme");
  await Theme.apply(urlTheme || S.settings.theme || Theme.list[0].id, false);
  Covers.refresh();
  const st = await authP;
  S.loggedIn = !!(st && st.loggedIn);
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  renderNow();
  // Ask to log in again for new permissions only once. If Spotify still doesn't grant one (some
  // aren't available to every app), carry on without asking at every launch.
  const missing = (st && st.missingScopes || []).slice().sort().join(" ");
  const asked = (await askedP) || "";
  if (S.loggedIn && missing && missing !== asked) {
    native("store.set", { key: "scopesAskedFor", value: missing }).catch(() => {});
    S.loggedIn = false;
    await go("setup", { reason: "Cadenza has new features (DJ and playlist editing) that need a little more access. Log in again to allow them." }, { reset: true, dir: -1, force: true });
  } else if (S.loggedIn) {
    await go("home", {}, { reset: true, dir: -1, force: true });
    poll(); loadPlaylists(); UpNext.load(); LastPlayed.load();
    Links.load().then(() => PlayCounts.load());
  } else {
    await go("setup", {}, { reset: true, dir: -1, force: true });
  }
  setInterval(() => { if (Date.now() >= nextPoll && !cooling()) poll(); }, 1000);
  // Background loops (water, rain, the eye…) pause while Cadenza is hidden, or after it has been in the
  // background for a while; they pick up again the moment you come back. Nothing else changes.
  let idleTimer = 0;
  const rest = (on) => {
    on = on || S.asleep;                                          // a closed window stays at rest
    document.body.classList.toggle("paused", on);
    Viz.rest(on);                                                 // the visualizer and its live meter too
  };
  window.__rest = rest;
  document.addEventListener("visibilitychange", () => rest(document.hidden));
  addEventListener("blur", () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => rest(true), 15000); });
  addEventListener("focus", () => {
    clearTimeout(idleTimer);
    if (S.asleep && !document.hidden) S.asleep = false;           // in front of you, so certainly not asleep
    rest(document.hidden);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    // Back in view: drop any half-played song-change animation and redraw from the latest state.
    [$("np-artwrap"), $("np-text")].forEach((el) => el.getAnimations().forEach((a) => a.cancel()));
    shownImage = undefined; applyNow(); tick(true);
    poll();
  });
  addEventListener("resize", () => { if (current() && current().name === "home") { views.home.measure(); views.home.moveHL(true); } });
}

/* =====================================================================
   Demo mode: open index.html in a normal browser to preview the UI
   ===================================================================== */
const Demo = (() => {
  const art = (hue, glyph) => "data:image/svg+xml," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue},70%,22%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},85%,58%)"/></linearGradient></defs>` +
    `<rect width="300" height="300" fill="url(#g)"/><circle cx="${90 + hue % 120}" cy="110" r="58" fill="rgba(255,255,255,.85)"/>` +
    `<path d="M0 220 Q75 190 150 220 T300 220 V300 H0Z" fill="rgba(3,12,46,.75)"/>` +
    `<text x="20" y="280" font-family="Arial Black,Impact" font-size="40" fill="white" font-style="italic">${glyph}</text></svg>`);
  const img = (hue, g) => [{ url: art(hue, g), width: 300, height: 300 }];
  const T = (name, artist, album, sec, hue) => ({ uri: "spotify:track:" + name.replace(/\W/g, ""), name, duration_ms: sec * 1000, artists: [{ id: "a-" + artist.replace(/\W/g, ""), name: artist }], album: { id: "al-" + album.replace(/\W/g, ""), name: album, images: img(hue, album.slice(0, 4).toUpperCase()) } });
  const tracks = [
    T("Midnight Tide (Full Moon Mix)", "Kairo Blue", "Moonlit Harbor", 236, 210), T("Glass Corridor", "Neon Ferry", "After Hours", 201, 280),
    T("Paper Lanterns", "Saya Mori", "Summer Train", 188, 20), T("Undertow", "Kairo Blue", "Moonlit Harbor", 254, 200),
    T("Signal Fire", "The Static Hearts", "Broadcast", 222, 340), T("Velvet Commute", "Lumen Drive", "City Pop Drive", 245, 300),
    T("Blue Hour", "Saya Mori", "Summer Train", 197, 230), T("Stairwell Echo", "Neon Ferry", "After Hours", 213, 260),
    T("Low Tide Lullaby", "Kairo Blue", "Moonlit Harbor", 179, 190), T("Northbound", "Lumen Drive", "City Pop Drive", 231, 160),
    T("Crosswalk", "The Static Hearts", "Broadcast", 205, 0), T("Afterglow Static", "Neon Ferry", "After Hours", 266, 270),
  ];
  const playlists = [
    ["Late Night Study", 48, 220, true], ["Battle Mode", 32, 350, true], ["Rainy Day Jazz", 61, 200, false], ["City Pop Drive", 27, 310, true],
    ["Lo-Fi Mornings", 112, 30, false], ["Gym Rotation", 40, 0, true], ["Summer Train", 19, 50, true], ["Deep Focus", 88, 180, false],
    ["Throwbacks", 74, 260, true], ["Road Trip", 55, 120, true],
  ].map(([name, n, hue, own], i) => ({ id: "pl" + i, uri: "spotify:playlist:pl" + i, name, images: img(hue, name.split(" ")[0].toUpperCase()), owner: { id: own ? "me" : "someone", display_name: own ? "Chedd4rr" : "Spotify" }, items: { total: n } }));
  const player = { is_playing: true, shuffle_state: true, repeat_state: "context", progress_ms: 97000, device: { name: "Cadenza", volume_percent: 70 }, item: tracks[0] };
  let at = Date.now();
  const outputs = [
    { uid: "bt1", name: "Chedd4rr's AirPods Pro", transport: "bluetooth", isDefault: true },
    { uid: "bt2", name: "JBL Flip 6", transport: "bluetooth", isDefault: false },
    { uid: "bi", name: "MacBook Pro Speakers", transport: "builtin", isDefault: false },
    { uid: "dp", name: "LG UltraFine Display", transport: "display", isDefault: false },
    { uid: "ap", name: "Living Room TV", transport: "airplay", isDefault: false },
  ];
  const settings = { theme: "tide", djVoice: true, clientId: "0123456789abcdef0123456789abcdef", manageLibrespot: true, librespotPath: "", deviceName: "Cadenza", bitrate: 320, mediaKeys: true, mediaKeysTrusted: true, globalHotkey: true, openAtLogin: false, reduceMotion: false };
  const ok = (body, status = 200) => Promise.resolve({ status, body });
  // Made-up Last.fm data: years of plays for "you", and a few friends with their own taste.
  const lfmArtists = ["Kairo Blue", "Neon Ferry", "Saya Mori", "The Static Hearts", "Lumen Drive", "Velvet Arcade", "Hana Kite", "Polar Motel", "Glass Tigers", "Midnight Office", "Coral Static", "June Satellites"];
  const lfmFriends = [["mika_wav", "Mika", 3], ["dustyroads", "", 7], ["neonharbor", "Jules", 1], ["ttraintracks", "Tomo", 5], ["quietloud", "", 9]];
  function demoLastfm(method, q) {
    const user = q.user || q.username || "chedd4rr", f = lfmFriends.find((x) => x[0] === user), shift = f ? f[2] : 0;
    const scale = { "7day": 0.02, "1month": 0.08, "12month": 0.5, overall: 1 }[q.period || "overall"] || 1;
    const lim = +q.limit || 50, page = +q.page || 1;
    const rot = (arr, n) => arr.slice(n % arr.length).concat(arr.slice(0, n % arr.length));
    const songs = rot(tracks, shift);
    const img = (t) => [{ "#text": "", size: "large" }];
    if (method === "user.getInfo") return { user: { name: user, playcount: f ? 21000 + shift * 900 : 48213, artist_count: 1876, track_count: 9120, registered: { unixtime: 1420070400 } } };
    if (method === "user.getFriends") return { friends: { user: lfmFriends.map(([name, realname]) => ({ name, realname, image: img() })) } };
    if (method === "user.getTopArtists") {
      const names = f ? rot(lfmArtists, shift).slice(0, 2 + shift).concat(["Paper Moons", "Rust Belt Radio", "Ocean Static", "Velour", "Echo Park Kids", "Lowlight"].map((n) => n + " " + shift)) : lfmArtists;
      const list = names.slice(0, lim).map((name, i) => ({ name, playcount: String(Math.round((4200 / (i + 1.4)) * scale) + 3) }));
      return { topartists: { artist: list, "@attr": { total: String(Math.round(1876 * Math.sqrt(scale))) } } };
    }
    if (method === "user.getTopTracks") {
      if (page > 1) return { toptracks: { track: [] } };
      if (q.period === "3month") return { toptracks: { track: songs.slice(6).map((t) => ({ name: t.name, artist: { name: t.artists[0].name }, playcount: "9" })) } };
      const list = songs.map((t, i) => ({ name: t.name, artist: { name: t.artists[0].name }, playcount: String(Math.round((620 / (i + 1.2)) * scale) + 1), duration: String(t.duration_ms / 1000), image: img() }));
      for (let i = list.length; i < Math.min(lim, 50); i++) list.push({ name: ["Lantern Sea", "Arcade Rain", "Slow Satellite", "Coastline", "Night Bus"][i % 5] + " " + (i + 1), artist: { name: lfmArtists[i % lfmArtists.length] }, playcount: String(Math.max(1, Math.round((620 / (i + 1.2)) * scale))), image: img() });
      return { toptracks: { track: list.slice(0, lim), "@attr": { total: String(Math.round(9120 * Math.sqrt(scale))) } } };
    }
    if (method === "user.getRecentTracks") {
      if (lim === 1) {
        const t = songs[0], now = f && shift % 2 === 1;
        return { recenttracks: { track: [{ name: t.name, artist: { "#text": t.artists[0].name }, ...(now ? { "@attr": { nowplaying: "true" } } : { date: { uts: String(Math.floor(Date.now() / 1000) - shift * 2400) } }) }], "@attr": { total: String(q.from ? Math.round(48213 * Math.min(1, (Date.now() / 1000 - q.from) / (3.4e8))) + 140 : 48213) } } };
      }
      if (page > 2) return { recenttracks: { track: [] } };
      let seed = 11 + page; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
      const list = Array.from({ length: 200 }, () => { const t = songs[Math.floor(rnd() * songs.length)], hr = rnd() < 0.55 ? 19 + Math.floor(rnd() * 5) : rnd() < 0.5 ? 9 + Math.floor(rnd() * 5) : Math.floor(rnd() * 24); const d = new Date(); d.setHours(hr % 24, Math.floor(rnd() * 60)); return { name: t.name, artist: { "#text": t.artists[0].name }, date: { uts: String(Math.floor(d.getTime() / 1000) - Math.floor(rnd() * 20) * 86400) } }; });
      return { recenttracks: { track: list } };
    }
    if (method === "track.getSimilar") return { similartracks: { track: rot(tracks, 3).slice(0, 8).map((t, i) => ({ name: t.name, artist: { name: t.artists[0].name }, match: String(1 - i / 10) })) } };
    if (method === "artist.getSimilar") return { similarartists: { artist: lfmArtists.slice(1, 6).map((name) => ({ name })) } };
    if (method === "track.getInfo") { const i = Math.max(0, songs.findIndex((t) => t.name.toLowerCase().startsWith(String(q.track || "").toLowerCase().slice(0, 6)))); return { track: { name: q.track, userplaycount: String(Math.round(620 / (i + 1.2)) + 1) } }; }
    return {};
  }
  function apiRoute(method, path, body) {
    const [p, qs] = path.split("?");
    const q = new URLSearchParams(qs || "");
    if (method === "GET" && p === "/me/player") { player.progress_ms += player.is_playing ? Date.now() - at : 0; at = Date.now(); return ok(JSON.parse(JSON.stringify(player))); }
    if (method === "GET" && p === "/me") return ok({ id: "me", display_name: "Chedd4rr" });
    if (method === "GET" && p === "/me/playlists") return ok({ items: playlists, next: null, total: playlists.length });
    if (method === "GET" && p === "/me/tracks") return ok({ items: tracks.slice(0, +q.get("limit") || 50).map((t) => ({ track: t })), total: 312, next: null });
    if (method === "GET" && p.startsWith("/playlists/")) {
      const pl = playlists.find((x) => p.includes(x.id));
      if (pl && pl.owner.id !== "me") return ok({ error: { status: 403, message: "Forbidden" } }, 403);
      return ok({ items: tracks.map((t) => ({ item: t })), total: tracks.length, next: null });
    }
    if (method === "GET" && p === "/search") {
      const term = (q.get("q") || "").toLowerCase(), off = +q.get("offset") || 0;
      const hits = tracks.filter((t) => (t.name + t.artists[0].name + t.album.name).toLowerCase().includes(term.slice(0, 3)));
      const list = (hits.length ? hits : tracks).concat(tracks).slice(off, off + 10);
      const type = q.get("type");
      if (type === "album") return ok({ albums: { items: [...new Map(tracks.map((t) => [t.album.id, { ...t.album, uri: "spotify:album:" + t.album.id, artists: t.artists, release_date: "2024-05-01", album_type: "album" }])).values()].slice(off, off + 10), total: 5 } });
      if (type === "artist") return ok({ artists: { items: [...new Map(tracks.map((t) => [t.artists[0].id, { ...t.artists[0], uri: "spotify:artist:" + t.artists[0].id, genres: ["dream pop", "city pop"], images: t.album.images }])).values()].slice(off, off + 10), total: 5 } });
      if (type === "playlist") return ok({ playlists: { items: playlists.slice(off, off + 10), total: playlists.length } });
      return ok({ tracks: { items: list, total: 24 } });
    }
    if (method === "GET" && p === "/me/player/queue") return ok({ currently_playing: player.item, queue: tracks.slice(1) });
    if (method === "GET" && p === "/me/player/devices") return ok({ devices: [{ id: "cadenza", name: "Cadenza", is_active: true }] });
    if (method === "PUT" && p === "/me/player/pause") { player.is_playing = false; return ok(null, 204); }
    if (method === "PUT" && p === "/me/player/play") {
      player.is_playing = true;
      if (body && body.uris) player.item = tracks.find((t) => t.uri === body.uris[0]) || player.item;
      if (body && body.offset) player.item = tracks.find((t) => t.uri === body.offset.uri) || player.item;
      if (body) { player.progress_ms = 0; at = Date.now(); }
      return ok(null, 204);
    }
    if (method === "POST" && (p === "/me/player/next" || p === "/me/player/previous")) {
      const i = tracks.indexOf(player.item);
      player.item = tracks[(i + (p.endsWith("next") ? 1 : tracks.length - 1)) % tracks.length]; player.progress_ms = 0; at = Date.now();
      return ok(null, 204);
    }
    if (method === "PUT" && p === "/me/player/shuffle") { player.shuffle_state = q.get("state") === "true"; return ok(null, 204); }
    if (method === "PUT" && p === "/me/player/repeat") { player.repeat_state = q.get("state"); return ok(null, 204); }
    if (method === "GET" && p === "/me/library/contains") return ok([false]);
    if (method === "GET" && p.startsWith("/albums/")) { const t0 = tracks[0]; return ok({ id: "al1", uri: "spotify:album:al1", name: t0.album.name, album_type: "album", release_date: "2025-03-14", total_tracks: 4, images: t0.album.images, artists: [{ id: "a1", name: "Kairo Blue" }], tracks: { items: tracks.filter((t) => t.album.name === t0.album.name).map((t) => ({ ...t, album: undefined })), next: null } }); }
    if (method === "GET" && /^\/artists\/[^/]+$/.test(p)) return ok({ id: "a1", uri: "spotify:artist:a1", name: "Kairo Blue", genres: ["dream pop", "city pop", "chillwave"], images: tracks[0].album.images });
    if (method === "GET" && /^\/artists\/[^/]+\/albums$/.test(p)) return ok({ items: playlists.slice(0, 6).map((x, i) => ({ id: "al" + i, name: x.name, album_type: i % 3 ? "single" : "album", release_date: String(2018 + i), images: x.images })), next: null });
    if (method === "GET" && p === "/me/player/devices") return ok({ devices: [{ id: "cadenza", name: "Cadenza", type: "Computer", is_active: true, volume_percent: 70 }, { id: "ph", name: "Chedd4rr's iPhone", type: "Smartphone", is_active: false, volume_percent: 100 }, { id: "sp", name: "Kitchen Speaker", type: "Speaker", is_active: false, volume_percent: 40 }] });
    if (method === "GET" && p === "/me/top/tracks") return ok({ items: (q.get("time_range") === "long_term" ? [...tracks].reverse() : tracks), next: null });
    if (method === "GET" && p === "/me/top/artists") return ok({ items: [{ id: "a1", name: "Kairo Blue" }, { id: "a2", name: "Neon Ferry" }, { id: "a3", name: "Saya Mori" }], next: null });
    if (method === "GET" && p === "/me/player/recently-played") return ok({ items: tracks.map((t, i) => ({ track: t, played_at: new Date(Date.now() - (i * 4 + 1) * 60000 * (i > 6 ? 30 : 1)).toISOString() })), next: null });
    if (method === "PUT" && p.startsWith("/playlists/")) { const pl = playlists.find((x) => p.endsWith(x.id)); if (pl && body) pl.name = body.name; return ok(null, 200); }
    if (method === "DELETE" && p === "/me/library") { const u = q.get("uris"); const i = playlists.findIndex((x) => x.uri === u); if (i >= 0) playlists.splice(i, 1); return ok(null, 200); }
    if (method === "POST" && p === "/me/playlists") { const pl = { id: "new" + Date.now(), uri: "spotify:playlist:new", name: body.name, images: [], owner: { id: "me" }, items: { total: 0 } }; return ok(pl, 201); }
    return ok(null, 204);
  }
  return {
    native(cmd, args) {
      switch (cmd) {
        case "api": (window.__calls = window.__calls || []).push(args.method + " " + args.path);
          if (window.__force429 && args.path.startsWith("/me/player?")) return Promise.resolve({ status: 429, body: { retryAfter: 20 } });
          return new Promise((res) => setTimeout(() => apiRoute(args.method, args.path, args.body).then(res), +(new URLSearchParams(location.search).get("lat") || 60)));
        case "auth.status": return Promise.resolve({ loggedIn: !/setup/.test(location.hash), clientId: settings.clientId, redirectURI: "http://127.0.0.1:8888", missingScopes: [] });
        case "auth.login": return new Promise((res) => setTimeout(() => res({ ok: true }), 800));
        case "outputs.list": return Promise.resolve(outputs.map((o) => ({ ...o })));
        case "outputs.set": outputs.forEach((o) => (o.isDefault = o.uid === args.uid)); return Promise.resolve(true);
        case "settings.get": return Promise.resolve({ ...settings });
        case "settings.set": settings[args.key] = args.value; return Promise.resolve({ ...settings });
        case "speak": return new Promise((res) => setTimeout(() => res(true), 1500));
        case "ai.status": return Promise.resolve({ available: true, reason: "" });
        case "ai.tags": { const g = ["Dream Pop", "City Pop", "Lo-Fi", "Indie Rock", "Jazz", "Hip-Hop", "Synthwave"], m = ["Chill", "Hype", "Dreamy", "Melancholy", "Feel-Good", "Focused"], t = ["Laid-Back", "Upbeat", "Mid-Tempo", "Fast", "Slow"];
          const hsh = [...args.prompt].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
          return new Promise((res) => setTimeout(() => res({ tags: { genre: g[hsh % g.length], mood: m[(hsh >> 3) % m.length], tempo: t[(hsh >> 6) % t.length] }, error: null }), 300)); }
        case "store.get": return Promise.resolve(null);
        case "history.get": {                                 // a couple of months of made-up plays
          const out = []; let seed = 7; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
          for (let d = 60; d >= 0; d--) for (let k = 0, n = Math.floor(rnd() * 9); k < n; k++) {
            const t = tracks[Math.floor(Math.pow(rnd(), 1.6) * tracks.length)];
            const at = Date.now() - d * 86400e3 - Math.floor((rnd() < .6 ? 10 + rnd() * 6 : rnd() * 24) * 3600e3) % 86400e3;
            out.push({ uri: t.uri, name: t.name, artists: t.artists.map((a) => a.name).join(", "), album: t.album.name, image: t.album.images[0].url, ms: Math.round(t.duration_ms * (0.6 + rnd() * 0.4)), at, dur: t.duration_ms });
          }
          return Promise.resolve(out.sort((a, b) => a.at - b.at));
        }
        // Importing Spotify's history: two years of made-up plays, with the same songs counted once.
        case "spotifyHistory.get": return Promise.resolve(window.__demoSpot || { tracks: [], plays: [] });
        case "spotifyHistory.clear": window.__demoSpot = null; return Promise.resolve(true);
        case "spotifyHistory.import": {
          const had = window.__demoSpot ? window.__demoSpot.plays.length : 0;
          if (!window.__demoSpot) {
            const ts = tracks.map((t) => [t.uri, t.name, t.artists[0].name, t.album.name]), plays = [];
            let seed = 3; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
            const end = Math.floor((Date.now() - 20 * 86400e3) / 1000);
            for (let d = 730; d >= 0; d--) for (let k = 0, n = Math.floor(rnd() * 12); k < n; k++) {
              const i = Math.floor(Math.pow(rnd(), 1.5) * ts.length);
              plays.push([end - d * 86400 - Math.floor(rnd() * 86400), i, 60000 + Math.floor(rnd() * 150000)]);
            }
            plays.sort((a, b) => a[0] - b[0]);
            window.__demoSpot = { tracks: ts, plays };
          }
          const total = window.__demoSpot.plays.length;
          return new Promise((res) => setTimeout(() => res({ files: 3, read: total + 400, added: total - had, duplicates: had, skipped: 400, total }), 600));
        }
        case "translate": return new Promise((res) => setTimeout(() => res({ lines: args.lines.map((l) => l && l !== "♪" ? "(ES) " + l.split(" ").reverse().join(" ") : ""), error: null, target: "es" }), 400));
        case "genius.search": return Promise.resolve({ hits: [{ title: "Midnight Tide (Full Moon Mix)", artist: "Kairo Blue" }, { title: "Undertow", artist: "Kairo Blue" }], error: null });
        case "diagnostics": return Promise.resolve("Cadenza 1.2 (demo)\nmacOS (browser)");
        case "discord.status": return Promise.resolve({ enabled: !!settings.discord, status: settings.discordAppId ? "connected" : "needs an application ID", hasId: !!settings.discordAppId });
        case "lastfm.status": return Promise.resolve({ user: "chedd4rr", hasKeys: true, loggedIn: true, error: "" });
        case "lastfm.get": return new Promise((res) => setTimeout(() => res({ status: 200, body: demoLastfm(args.method, args.params || {}) }), 80));
        case "update.status": return Promise.resolve({ repo: settings.updateRepo || "", current: "1.0", state: "idle", message: "", auto: true });
        case "update.check": return Promise.resolve({ repo: "Chedd4rr/Cadenza", current: "1.0", state: "available", message: "Version 1.1 is ready", auto: true, found: { version: "1.1", notes: "## What's new\n- Stage mode\n- Discord status", page: "", asset: "x" } });
        case "window.fullscreen": return Promise.resolve(true);
        case "speak.voices": return Promise.resolve({ voices: [{ id: "zoe", name: "Zoe", quality: "Premium" }, { id: "ava", name: "Ava", quality: "Enhanced" }, { id: "sam", name: "Samantha", quality: "Standard" }], current: "" });
        case "eq.get": return Promise.resolve(window.__eq || (window.__eq = { enabled: true, preamp: 0, gains: Array(10).fill(0), preset: "Flat", freqs: [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000], engine: true }));
        case "eq.set": Object.assign(window.__eq, args); return Promise.resolve({ ...window.__eq });
        case "api.activity": return Promise.resolve({ lastMinute: (window.__calls || []).length, total: (window.__calls || []).length, uptime: 60, blockedFor: 0, lastRetryAfter: 0, log: [] });
        case "lyrics": return Promise.resolve({ synced: "[00:00.00] ♪\n[01:30.00] Neon on the water, I can hear the tide\n[01:36.50] Every little signal pulling me outside\n[01:43.00] Hold the night a little longer\n[01:49.50] Midnight tide, carry me home\n[01:56.00] Under a moon that we called our own\n[02:02.50] Lights go blue and the city goes slow\n[02:09.00] Midnight tide, never let go\n[02:15.50] ♪", plain: "", instrumental: false });
        case "librespot.status": return Promise.resolve({ state: "running", path: "/opt/homebrew/bin/librespot", deviceName: "Cadenza", log: ["[INFO librespot] librespot 0.6.0 (Built on 2026-05-01)", "[INFO librespot_core::session] Connecting to AP \"ap-gew4.spotify.com:4070\"", "[INFO librespot_core::session] Authenticated as \"chedd4rr\" !", "[INFO librespot_playback::player] Loading <Midnight Tide (Full Moon Mix)>", "[INFO librespot_playback::player] <Midnight Tide (Full Moon Mix)> (236000 ms) loaded"] });
        default: return Promise.resolve(true);
      }
    },
  };
})();

boot();
})();
