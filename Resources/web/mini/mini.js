// The menu-bar mini player. Cadenza calls mini.apply(info) with what's playing; buttons go back to
// Cadenza through window.webkit.messageHandlers.mini. This page can only ask for the few things the
// mini player does (play/pause, skip, like, volume, open Cadenza, its own size), nothing else.
"use strict";

const $ = (id) => document.getElementById(id);
const native = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.mini;
const send = (cmd, value) => { if (native) native.postMessage(value === undefined ? { cmd } : { cmd, value }); };

const ICON_PLAY = "M7 4.5v15l12.5-7.5z";
const ICON_PAUSE = "M6 5h4v14H6zM14 5h4v14h-4z";

const S = {
  info: {},
  position: 0,        // ms, as of `stamp`
  duration: 0,
  playing: false,
  stamp: Date.now(),
  volume: 70,
  volLock: 0,         // ignore Cadenza's volume for a moment after you change it here
  visible: !native,    // Cadenza says when the panel opens; until then, nothing needs to move
  art: null,          // the cover's data URL (null until the first update)
  lastSize: "",
};

const clock = (ms) => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};
const now = () => Math.min(S.duration || Infinity, S.position + (S.playing ? Date.now() - S.stamp : 0));

/* ---------- what's playing ---------- */

function apply(info) {
  info = info || {};
  S.info = info;
  // Themes the menu-bar player has its own look for; any other (like CHROMA) uses the blue one.
  const theme = ["tide", "heist", "neon", "min", "rogue"].includes(info.theme) ? info.theme : "tide", style = info.style === "mp3" ? "mp3" : "theme";
  const themeChanged = document.body.dataset.theme !== theme || document.body.dataset.style !== style;
  document.body.dataset.theme = theme;
  document.body.dataset.style = style;

  const title = info.title || "", artist = info.artist || "", album = info.album || "";
  $("title").textContent = title || "Nothing playing";
  $("artist").textContent = artist;
  $("album").textContent = album;
  $("cap").textContent = album || title;
  $("lcdTitle").textContent = title ? (artist ? title + "  ·  " + artist : title) : "NO DISC";
  $("lcdArtist").textContent = artist || "CADENZA";

  S.playing = !!info.playing;
  S.position = Number(info.position) || 0;
  S.duration = Number(info.duration) || 0;
  S.stamp = Date.now();
  if (info.volume != null && Date.now() > S.volLock) S.volume = Math.round(Number(info.volume));

  document.body.classList.toggle("playing", S.playing);
  document.body.classList.toggle("liked", !!info.liked);
  document.body.classList.toggle("empty", !title);
  $("playIcon").setAttribute("d", S.playing ? ICON_PAUSE : ICON_PLAY);
  $("badge").textContent = S.playing ? "PLAYING" : title ? "PAUSED" : "STANDBY";
  $("lcdState").textContent = S.playing ? "▶ PLAY" : title ? "❚❚ PAUSE" : "■ STOP";

  if (themeChanged) restyle(theme);
  setArt(info.art || "");
  renderVolume();
  tick();
  marquee();
  reportSize();
}

function setArt(src) {
  if (src === S.art) return;
  S.art = src;
  const img = $("art");
  if (!src) { img.removeAttribute("src"); document.body.classList.add("noart"); dither(null); return; }
  document.body.classList.remove("noart");
  img.onload = () => dither(img);
  img.src = src;
}

/* ---------- theme details ---------- */

function restyle(theme) {
  // HEIST cuts "NOW PLAYING" out of magazines: each letter gets its own font, colours and tilt.
  const np = $("np");
  np.textContent = "";
  if (theme === "heist") {
    const fonts = ["a", "b", "c"], looks = ["w", "k", "r"];
    let seed = 7;
    const rnd = (n) => { seed = (seed * 9301 + 49297) % 233280; return Math.floor((seed / 233280) * n); };
    for (const ch of "NOW PLAYING") {
      if (ch === " ") { np.append(document.createTextNode(" ")); continue; }
      const s = document.createElement("b");
      s.textContent = ch;
      s.className = "f" + fonts[rnd(3)] + " l" + looks[rnd(3)];
      s.style.transform = `rotate(${rnd(17) - 8}deg) translateY(${rnd(5) - 2}px)`;
      np.append(s);
    }
  } else {
    np.textContent = theme === "rogue" ? "SIGNAL // LIVE" : theme === "min" ? "Now playing" : "NOW PLAYING";
  }
  if (S.art) { const img = $("art"); if (img.complete) dither(img); }
}

/* ---------- progress, volume ---------- */

function tick() {
  const pos = now(), dur = S.duration, f = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0;
  $("t0").textContent = $("lcdT0").textContent = clock(pos);
  $("t1").textContent = $("lcdT1").textContent = clock(dur);
  $("fill").style.width = (f * 100).toFixed(2) + "%";
  // The LCD bar moves in whole "pixels" (3 px steps), like a real one.
  const pix = $("lcdFill").parentElement.clientWidth;
  $("lcdFill").style.width = Math.round((f * pix) / 3) * 3 + "px";
}

function renderVolume() {
  const v = Math.max(0, Math.min(100, S.volume));
  $("volfill").style.width = v + "%";
  $("volnum").textContent = v;
  $("lcdVol").textContent = "VOL " + String(Math.round(v / 5)).padStart(2, "0");
}

function setVolume(v) {
  S.volume = Math.max(0, Math.min(100, Math.round(v)));
  S.volLock = Date.now() + 2500;
  renderVolume();
  send("volume", S.volume);
}

// Drag or click on the volume bar.
(() => {
  const bar = $("volbar");
  const at = (e) => { const r = bar.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * 100; };
  let dragging = false;
  bar.addEventListener("pointerdown", (e) => { dragging = true; bar.setPointerCapture(e.pointerId); S.volume = at(e); S.volLock = Date.now() + 2500; renderVolume(); });
  bar.addEventListener("pointermove", (e) => { if (dragging) { S.volume = Math.max(0, Math.min(100, at(e))); renderVolume(); } });
  bar.addEventListener("pointerup", (e) => { if (dragging) { dragging = false; setVolume(at(e)); } });
})();

/* ---------- MP3 mode: the LCD ---------- */

// The cover on the little colour screen: shrunk to 28 × 28 and shown at double size, with fewer colours,
// like the low-resolution displays those players had.
function dither(img) {
  const c = $("dither"), ctx = c.getContext("2d", { willReadFrequently: true });
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  if (!img) {
    // No cover: a pixel music note in the screen's accent colour.
    ctx.fillStyle = getComputedStyle($("lcd")).getPropertyValue("--acc").trim() || "#fff";
    const note = ["....######", "....######", "....#....#", "....#....#", "....#....#", "....#....#", ".###.#.###", "####.#####", "####..####", ".##....##."];
    note.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === "#") ctx.fillRect(x * 2 + 4, y * 2 + 4, 2, 2); }));
    return;
  }
  try {
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h), px = d.data;
    for (let i = 0; i < px.length; i += 4) for (let k = 0; k < 3; k++) px[i + k] = Math.round(px[i + k] / 51) * 51;   // 6 levels per colour
    ctx.putImageData(d, 0, 0);
  } catch (e) { /* a cover we can't read: leave the screen blank */ }
}

// Long titles scroll across the LCD; short ones sit still.
function marquee() {
  const box = $("lcdTitle").parentElement, span = $("lcdTitle");
  span.classList.remove("run");
  span.style.removeProperty("--dist");
  requestAnimationFrame(() => {
    const over = span.scrollWidth - box.clientWidth;
    if (over > 2) {
      span.style.setProperty("--dist", -(span.scrollWidth + 24) + "px");
      span.style.setProperty("--dur", Math.max(6, (span.scrollWidth + 24) / 22) + "s");
      span.dataset.text = span.textContent;
      span.classList.add("run");
    }
  });
}

// The little spectrum on the LCD: blocky bars that jump while music plays.
const eqBars = [...document.querySelectorAll("#eq i")];
let eqLevels = eqBars.map(() => 1);
function eqStep() {
  eqLevels = eqLevels.map((l, i) => {
    if (!S.playing) return Math.max(1, l - 1);
    const target = 2 + Math.floor(Math.random() * (i < 3 ? 6 : 5));
    return l + Math.sign(target - l) * Math.min(2, Math.abs(target - l));
  });
  eqBars.forEach((b, i) => { b.style.height = eqLevels[i] * 3 + "px"; });
}

/* ---------- buttons ---------- */

const click = (id, fn) => $(id).addEventListener("click", (e) => { e.preventDefault(); fn(); });
const toggle = () => {
  // Answer at once; Cadenza's next update confirms it.
  S.position = now(); S.stamp = Date.now(); S.playing = !S.playing;
  apply({ ...S.info, playing: S.playing, position: S.position });
  send("toggle");
};
const like = () => { apply({ ...S.info, liked: !S.info.liked, position: now() }); send("like"); };

click("play", toggle); click("splay", toggle);
click("prev", () => send("previous")); click("sprev", () => send("previous"));
click("next", () => send("next")); click("snext", () => send("next"));
click("like", like); click("slike", like);
click("vup", () => setVolume(S.volume + 5));
click("vdown", () => setVolume(S.volume - 5));
click("smenu", () => send("show"));
$("cover").addEventListener("dblclick", () => send("show"));
document.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("dragstart", (e) => e.preventDefault());

/* ---------- size and visibility ---------- */

// Tells Cadenza how big the panel should be: the player plus the room its shadow needs.
function reportSize() {
  requestAnimationFrame(() => {
    const el = document.body.dataset.style === "mp3" ? $("stick") : $("dev");
    const cs = getComputedStyle(document.body);
    const w = Math.ceil(el.offsetWidth + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight));
    const h = Math.ceil(el.offsetHeight + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom));
    const key = w + "x" + h;
    if (key === S.lastSize) return;
    S.lastSize = key;
    send("size", { w, h });
  });
}

/** Cadenza calls this when the panel opens or closes, so nothing animates while you can't see it. */
function setVisible(on) {
  S.visible = !!on;
  if (on) { tick(); marquee(); }
}

setInterval(() => { if (S.visible) tick(); }, 250);
setInterval(() => { if (S.visible && document.body.dataset.style === "mp3") eqStep(); }, 130);
setInterval(() => { if (S.visible && S.playing && document.body.dataset.style === "mp3") document.body.classList.toggle("blink"); }, 600);
document.fonts.ready.then(() => { S.lastSize = ""; reportSize(); marquee(); });

window.mini = { apply, setVisible };

/* ---------- demo (opened in a browser) ---------- */

if (!native) {
  const q = new URLSearchParams(location.search);
  const c = document.createElement("canvas");
  c.width = c.height = 480;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 480);
  grad.addColorStop(0, "#1b2a8f"); grad.addColorStop(1, "#5a2bd6");
  g.fillStyle = grad; g.fillRect(0, 0, 480, 480);
  g.fillStyle = "#e9e6f5"; g.beginPath(); g.arc(250, 170, 78, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#1a1f6e"; g.beginPath(); g.moveTo(0, 330);
  g.bezierCurveTo(140, 270, 300, 400, 480, 320); g.lineTo(480, 480); g.lineTo(0, 480); g.fill();
  const art = q.get("art") === "none" ? "" : c.toDataURL("image/jpeg", 0.85);
  apply({
    title: q.get("title") || "Midnight Tide (Full Moon Mix)", artist: "Kairo Blue", album: "Moonlit Harbor", art,
    playing: q.get("paused") ? false : true, liked: !!q.get("liked"), volume: 70, duration: 236000, position: 99000,
    theme: q.get("theme") || "tide", style: q.get("style") || "theme",
  });
}
