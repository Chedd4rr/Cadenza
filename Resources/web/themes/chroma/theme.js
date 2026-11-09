// CHROMA · COVER: a gallery-print theme coloured by the album cover that's playing.
//
// Each time the cover changes, it reads a small copy of it and picks the cover's main colours: a dark
// one from its shadows and up to four accents (strongest first, kept apart in hue so they don't all look
// alike). Those become --c1 … --c4 plus the shared colour variables every page uses, so the menu, lists,
// visualiser and (if that preference is on) other covers follow along. The old colours fade into the new
// ones over about a second. The background is built from the same colours: the cover blurred, a soft orb
// per colour, record grooves, a big outlined word from the song title, and a palette card of paint chips.
(() => {
  const VARS = ["--navy", "--navy-rgb", "--deep", "--deep-rgb", "--blue", "--cyan", "--cyan-rgb", "--ice", "--ice-rgb",
    "--white", "--white-rgb", "--placeholder", "--drawer-bg", "--liked-bg",
    "--c1", "--c1-rgb", "--c2", "--c2-rgb", "--c3", "--c3-rgb", "--c4", "--c4-rgb"];
  const root = document.documentElement;
  // Before anything plays (and for a cover that can't be read): the theme's own violet palette.
  const DEFAULT = { dark: [18, 14, 26], accents: [[180, 140, 255], [255, 143, 184], [111, 214, 255], [255, 210, 122]] };
  const FADE_MS = 1100;
  let token = 0, layer = 0, shown = null, fading = 0;

  // ----- Colour helpers -----
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const hex = (c) => "#" + c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
  const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  function toHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function fromHsl([h, s, l]) {
    if (!s) return [l, l, l].map((v) => Math.round(v * 255));
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
  }
  const hueGap = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 1 - d); };

  /** The cover's dark colour and up to four accents, from its pixels. */
  function palette(px) {
    const all = [], bins = Array.from({ length: 24 }, () => ({ w: 0, c: [0, 0, 0] }));
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      const c = [px[i], px[i + 1], px[i + 2]], [h, s, l] = toHsl(c);
      all.push(c);
      if (s > 0.18 && l > 0.12 && l < 0.9) {
        const w = s * s * (1 - Math.abs(l - 0.55) * 0.8), b = bins[Math.floor(h * 24) % 24];
        b.w += w; b.c = b.c.map((v, k) => v + c[k] * w);
      }
    }
    if (!all.length) return null;
    const avg = (list) => list.reduce((s, c) => s.map((v, k) => v + c[k]), [0, 0, 0]).map((v) => v / list.length);
    // Accents: the heaviest hues, each at least 1/12 of the colour wheel away from the ones already picked.
    const ranked = bins.map((b) => ({ w: b.w, c: b.w ? b.c.map((v) => v / b.w) : null })).filter((b) => b.c && b.w > all.length * 0.006).sort((a, b) => b.w - a.w);
    const picks = [];
    for (const b of ranked) {
      const h = toHsl(b.c)[0];
      if (picks.every((p) => hueGap(p.h, h) > 1 / 12)) picks.push({ h, c: b.c });
      if (picks.length === 4) break;
    }
    // Make each one bright and vivid enough to read on the dark colour.
    let accents = picks.map((p) => { const [h, s, l] = toHsl(p.c); return fromHsl([h, clamp(s, 0.5, 0.95), clamp(l, 0.58, 0.72)]); });
    if (!accents.length) {                                          // a black-and-white cover: soft greys
      const [h, s] = toHsl(avg(all));
      accents = [0.78, 0.62, 0.9, 0.5].map((l) => fromHsl([h, Math.min(s, 0.1), l]));
    }
    // Fewer than four colours on the cover: fill in lighter and shifted versions of the main one.
    while (accents.length < 4) {
      const [h, s, l] = toHsl(accents[0]), n = accents.length;
      accents.push(fromHsl([(h + [0, 0.06, -0.06, 0.12][n] + 1) % 1, s * (n % 2 ? 0.8 : 1), clamp(l + (n % 2 ? 0.12 : -0.06), 0.5, 0.85)]));
    }
    all.sort((a, b) => lum(a) - lum(b));
    const [dh, ds] = toHsl(avg(all.slice(0, Math.max(1, Math.floor(all.length * 0.3)))));
    const dark = mix(fromHsl([dh, Math.min(ds, 0.55), 0.085]), accents[0], 0.08);    // deep enough for text to stay readable
    return { dark, accents };
  }

  /** Every colour variable, from a palette. */
  function vars(p) {
    const { dark } = p, [a1, a2, a3, a4] = p.accents;
    const [h1, s1] = toHsl(a1);
    const deep = mix(dark, a1, 0.16), blue = fromHsl([h1, Math.min(s1, 0.8), 0.32]);
    const ice = mix(a1, [255, 255, 255], 0.7), white = mix(a1, [255, 255, 255], 0.94);
    const rgb = (c) => c.map(Math.round).join(" ");
    return {
      "--navy": hex(dark), "--navy-rgb": rgb(dark), "--deep": hex(deep), "--deep-rgb": rgb(deep), "--blue": hex(blue),
      "--cyan": hex(a1), "--cyan-rgb": rgb(a1), "--ice": hex(ice), "--ice-rgb": rgb(ice), "--white": hex(white), "--white-rgb": rgb(white),
      "--c1": hex(a1), "--c1-rgb": rgb(a1), "--c2": hex(a2), "--c2-rgb": rgb(a2), "--c3": hex(a3), "--c3-rgb": rgb(a3), "--c4": hex(a4), "--c4-rgb": rgb(a4),
      "--placeholder": hex(mix(dark, a1, 0.3)),
      "--drawer-bg": `linear-gradient(180deg, ${hex(mix(dark, a1, 0.4))}, ${hex(dark)})`,
      "--liked-bg": `linear-gradient(135deg, ${hex(a1)}, ${hex(a2)})`,
    };
  }
  function set(p) { for (const [k, v] of Object.entries(vars(p))) root.style.setProperty(k, v); }
  const between = (a, b, t) => ({ dark: mix(a.dark, b.dark, t), accents: a.accents.map((c, i) => mix(c, b.accents[i], t)) });

  /** Fade from the colours on screen to `p`. Instant when nobody would see it (hidden, resting, reduced motion). */
  function fadeTo(p, recolored) {
    cancelAnimationFrame(fading);
    const from = shown || DEFAULT;
    shown = p;
    chips(p);
    const instant = document.hidden || document.body.classList.contains("paused") || document.body.classList.contains("reduce") ||
      (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (instant) { set(p); return recolored(); }
    const t0 = performance.now();
    let frames = 0;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / FADE_MS), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // ease in-out
      set(between(from, p, e));
      // The visualiser and themed covers read the colours too: refresh them now and then, and at the end.
      if (t === 1 || ++frames % 8 === 0) recolored();
      if (t < 1) fading = requestAnimationFrame(step);
    };
    fading = requestAnimationFrame(step);
  }

  /** The palette card's chips and codes (the chips' colour change is a CSS transition). */
  function chips(p) {
    const box = document.querySelector("#bg .ch-chips");
    if (!box) return;
    const list = [p.dark, ...p.accents];
    box.querySelectorAll(".ch-chip").forEach((el, i) => {
      el.querySelector("i").style.backgroundColor = hex(list[i]);
      el.querySelector("b").textContent = hex(list[i]).slice(1);
    });
  }

  /** The big outlined word behind everything: the first word of the playing song. */
  function ghost() {
    const el = document.querySelector("#bg .ch-ghost");
    if (!el) return;
    const n = window.cadenzaNow && window.cadenzaNow();
    const word = n && n.title ? n.title.split(/\s+/).find((w) => w.length > 2) || n.title.split(/\s+/)[0] : "Chroma";
    if (el.textContent === word) return;
    el.style.opacity = "0";
    setTimeout(() => { el.textContent = word; el.style.opacity = "1"; }, 400);
  }

  /** A small copy of the picture, as pixels. */
  function pixels(src) {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => {
        try {
          const cv = document.createElement("canvas"); cv.width = cv.height = 40;
          const ctx = cv.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(im, 0, 0, 40, 40);
          resolve(ctx.getImageData(0, 0, 40, 40).data);
        } catch (e) { resolve(null); }                            // a picture we're not allowed to read
      };
      im.onerror = () => resolve(null);
      im.src = src;
    });
  }

  // Title Case for menu items and page headings ("LIBRARY" → "Library"): serif capitals look shouty.
  const KEEP = new Set(["DJ", "EQ", "AI", "OK", "TV", "ID", "UP", "LP", "EP"]);
  const title = (s) => String(s).toLowerCase().replace(/[a-z0-9'’]+/g, (w, i) => (KEEP.has(w.toUpperCase()) ? w.toUpperCase() : i === 0 || w.length > 3 ? w[0].toUpperCase() + w.slice(1) : w))
    .replace(/^./, (m) => m.toUpperCase());

  // Record grooves, drawn once as an image (rotating an image is nearly free).
  const rings = "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="1000" height="1000">' +
    Array.from({ length: 34 }, (_, i) => `<circle cx="100" cy="100" r="${98 - i * 2.6}" fill="none" stroke="#fff" stroke-width="${i % 5 === 0 ? 0.7 : 0.25}" opacity="${0.4 + (i % 3) * 0.2}"/>`).join("") +
    '<path d="M100 2 A98 98 0 0 1 198 100" fill="none" stroke="#fff" stroke-width="1.6" opacity=".7"/></svg>');

  registerTheme({
    id: "chroma",

    background(bg, { h }) {
      bg.append(h("div", "ch-base"), h("div", "ch-art"), h("div", "ch-art"),
        h("div", "ch-orb o1"), h("div", "ch-orb o2"), h("div", "ch-orb o3"), h("div", "ch-orb o4"));
      const r = h("img", "ch-rings"); r.alt = ""; r.src = rings;
      bg.append(r, h("div", "ch-ghost", "Chroma"), h("div", "ch-wash"));
      const grain = h("div", "ch-grain");
      grain.style.backgroundImage = "url(\"data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .9 0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>') + "\")";
      const card = h("div", "ch-chips");
      for (let i = 0; i < 5; i++) { const c = h("div", "ch-chip"); c.append(h("i"), h("b")); card.append(c); }
      bg.append(grain, card);
      shown = null;                                              // a fresh start: fade in from the default colours
      chips(DEFAULT);
    },

    text(el, text, kind) {
      if (kind === "menu" || kind === "header") { el.textContent = title(text); return true; }
      return false;
    },

    /** Called with the playing song's cover whenever it changes (null when nothing plays). */
    async onArt(url, { dataURL, recolored }) {
      const t = ++token;
      const layers = document.querySelectorAll("#bg .ch-art");
      if (layers.length === 2) {
        layer ^= 1;
        layers[layer].style.backgroundImage = url ? `url("${String(url).replace(/"/g, "%22")}")` : "none";
        layers[layer].classList.toggle("on", !!url);
        layers[layer ^ 1].classList.remove("on");
      }
      ghost();
      if (!url) return fadeTo(DEFAULT, recolored);
      const src = await dataURL(url);
      const px = src ? await pixels(src) : null;
      if (t !== token) return;                                    // the song changed again meanwhile
      fadeTo((px && palette(px)) || DEFAULT, recolored);
    },

    /** Switching to another theme: hand the colour variables back to its stylesheet. */
    leave() {
      token++;
      cancelAnimationFrame(fading);
      shown = null;
      VARS.forEach((v) => root.style.removeProperty(v));
    },

    cover: { background: "#120e1a", borderRight: "3vw solid #b48cff", clipPath: "none" },

    overlay(sweep, { h }) {
      sweep.append(h("div", "th ch-bloom b1"), h("div", "th ch-bloom b2"), h("div", "th ch-bloom b3"), h("div", "th ch-dot"));
    },

    // Page change: three blooms, one in each of the cover's main colours, open out from the middle.
    transition(sweep, dir, { play }) {
      const anims = [...sweep.querySelectorAll(".a, .b, .c")].map((el, i) => play(el,
        [{ transform: `translate3d(${dir > 0 ? "-60vw" : "160vw"},0,0)`, opacity: 0.35 }, { transform: `translate3d(${dir > 0 ? "160vw" : "-60vw"},0,0)`, opacity: 0.35 }],
        { duration: 460, delay: i * 40, easing: "cubic-bezier(.55,.05,.35,1)", fill: "none" }));
      sweep.querySelectorAll(".ch-bloom").forEach((el, i) => {
        el.style.translate = `${(i - 1) * dir * 12}vw ${(i % 2 ? -1 : 1) * 6}vh`;
        anims.push(play(el, [{ scale: ".15", opacity: 1 }, { scale: "1.5", opacity: 0 }], { duration: 640, delay: i * 70, easing: "cubic-bezier(.15,.7,.3,1)", fill: "none" }));
      });
      return anims;
    },

    // A small glow wherever you confirm something.
    onConfirm(el, { play }) {
      const dot = document.querySelector("#sweep .ch-dot");
      if (!dot || !el || !el.getBoundingClientRect) return;
      const r = el.getBoundingClientRect();
      dot.style.left = r.left + Math.min(r.width, innerWidth * 0.1) + "px";
      dot.style.top = r.top + r.height / 2 + "px";
      play(dot, [{ scale: ".2", opacity: 1 }, { scale: "1.3", opacity: 0 }], { duration: 460, easing: "cubic-bezier(.15,.7,.3,1)", fill: "none" });
    },

    motion: {
      in: (dir) => [{ transform: `translate3d(${dir * 4}vw,1.5vh,0)`, opacity: 0 }, { transform: "none", opacity: 1 }],
      out: (dir) => [{ transform: "none", opacity: 1 }, { transform: `translate3d(${-dir * 4}vw,0,0)`, opacity: 0 }],
      row: (dir) => [{ transform: `translate3d(${dir * 3}vw,0,0)`, opacity: 0 }, { transform: "none", opacity: 1 }],
      inMs: 340, outMs: 180, rowMs: 300, stagger: 22,
      inEase: "cubic-bezier(.2,.9,.3,1)",
      select: { frames: [{ scale: "1.06 1", opacity: 0.7 }, { scale: "1 1", opacity: 1 }], ms: 280 },
      confirm: { frames: [{ scale: "1.04" }, { scale: "1" }], ms: 240 },
      hint: { frames: [{ translate: "0 1vh", opacity: 0 }, { translate: "0 0", opacity: 1 }], ms: 280, ease: "cubic-bezier(.3,1.2,.5,1)" },
      intel: { frames: [{ translate: "0 2vh", opacity: 0 }, { translate: "0 0", opacity: 1 }], ms: 320, ease: "cubic-bezier(.2,.9,.3,1)" },
      // the sleeve slides down out of view and the new one rises in
      trackOut: {
        art: [{ translate: "0 0", opacity: 1 }, { translate: "0 4vh", opacity: 0 }],
        text: [{ translate: "0 0", opacity: 1 }, { translate: "0 -1.5vh", opacity: 0 }], ms: 200 },
      trackIn: {
        art: [{ translate: "0 -4vh", scale: "1.04", opacity: 0 }, { translate: "0 0", scale: "1", opacity: 1 }],
        text: [{ translate: "0 1.5vh", opacity: 0 }, { translate: "0 0", opacity: 1 }], ms: 460 },
    },
  });
})();
