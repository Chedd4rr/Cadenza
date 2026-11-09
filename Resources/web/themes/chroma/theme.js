// CHROMA · COVER: a psychedelic comic page printed like a risograph poster, in the colours of the album
// cover that's playing.
//
// Each time the cover changes, it reads a small copy of it and picks the cover's four strongest colours
// (kept apart in hue so they don't all look alike), plus a paper tint and an ink colour. Those become
// --c1 … --c4, --paper and --ink, which everything in theme.css is printed with, and the old colours fade
// into the new ones over about a second. The background is an abstract poster of overprinted shapes in
// those four inks; every song gets its own arrangement (worked out from the song, so the same song always
// looks the same), and the shapes glide from one arrangement to the next.
(() => {
  const VARS = ["--paper", "--paper-rgb", "--ink", "--ink-rgb", "--ice", "--ice-rgb", "--placeholder",
    "--c1", "--c1-rgb", "--c2", "--c2-rgb", "--c3", "--c3-rgb", "--c4", "--c4-rgb"];
  const root = document.documentElement;
  // Before anything plays (and for a cover that can't be read): red, green, yellow and blue on newsprint.
  const DEFAULT = { paper: [242, 234, 217], ink: [23, 20, 28], accents: [[232, 64, 42], [47, 154, 91], [242, 183, 5], [59, 111, 216]] };
  const FADE_MS = 1100;
  let token = 0, shown = null, fading = 0;

  // ----- Colour helpers -----
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const hex = (c) => "#" + c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
  const rgb = (c) => c.map(Math.round).join(" ");
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

  /** Paper, ink and the cover's four strongest colours, from its pixels. */
  function palette(px) {
    const all = [], bins = Array.from({ length: 24 }, () => ({ w: 0, c: [0, 0, 0] }));
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      const c = [px[i], px[i + 1], px[i + 2]], [h, s, l] = toHsl(c);
      all.push(c);
      if (s > 0.18 && l > 0.12 && l < 0.9) {
        const w = s * s * (1 - Math.abs(l - 0.5) * 0.8), b = bins[Math.floor(h * 24) % 24];
        b.w += w; b.c = b.c.map((v, k) => v + c[k] * w);
      }
    }
    if (!all.length) return null;
    const avg = (list) => list.reduce((s, c) => s.map((v, k) => v + c[k]), [0, 0, 0]).map((v) => v / list.length);
    const ranked = bins.map((b) => ({ w: b.w, c: b.w ? b.c.map((v) => v / b.w) : null })).filter((b) => b.c && b.w > all.length * 0.006).sort((a, b) => b.w - a.w);
    const picks = [];
    for (const b of ranked) {
      const h = toHsl(b.c)[0];
      if (picks.every((p) => hueGap(p.h, h) > 1 / 12)) picks.push({ h, c: b.c });
      if (picks.length === 4) break;
    }
    // Flat printing inks: strong and mid-bright, so they read as fills on paper with black text on top.
    let accents = picks.map((p) => { const [h, s, l] = toHsl(p.c); return fromHsl([h, clamp(s, 0.6, 0.95), clamp(l, 0.5, 0.62)]); });
    if (!accents.length) {                                          // a black-and-white cover: greys and one hot colour
      accents = [[226, 58, 46], [150, 146, 156], [205, 200, 210], [90, 86, 96]];
    }
    while (accents.length < 4) {                                    // fewer colours on the cover: shifted versions of the main one
      const [h, s, l] = toHsl(accents[0]), n = accents.length;
      accents.push(fromHsl([(h + [0, 0.08, -0.08, 0.16][n] + 1) % 1, s, clamp(l + [0, 0.12, -0.1, 0.2][n], 0.4, 0.75)]));
    }
    // Paper: warm newsprint with a breath of the cover's overall colour. Ink: near-black, a touch of its darkest tone.
    const [ah, as] = toHsl(avg(all));
    const paper = mix([243, 235, 219], fromHsl([ah, Math.min(as, 0.5), 0.86]), 0.18);
    all.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
    const ink = mix([22, 19, 26], avg(all.slice(0, Math.max(1, Math.floor(all.length * 0.15)))), 0.15).map((v) => Math.min(v, 40));
    return { paper, ink, accents };
  }

  function vars(p) {
    const [a1, a2, a3, a4] = p.accents, ice = mix(p.ink, p.paper, 0.38);
    return {
      "--paper": hex(p.paper), "--paper-rgb": rgb(p.paper), "--ink": hex(p.ink), "--ink-rgb": rgb(p.ink),
      "--ice": hex(ice), "--ice-rgb": rgb(ice), "--placeholder": hex(mix(p.paper, a1, 0.3)),
      "--c1": hex(a1), "--c1-rgb": rgb(a1), "--c2": hex(a2), "--c2-rgb": rgb(a2), "--c3": hex(a3), "--c3-rgb": rgb(a3), "--c4": hex(a4), "--c4-rgb": rgb(a4),
    };
  }
  function set(p) { for (const [k, v] of Object.entries(vars(p))) root.style.setProperty(k, v); }
  const between = (a, b, t) => ({ paper: mix(a.paper, b.paper, t), ink: mix(a.ink, b.ink, t), accents: a.accents.map((c, i) => mix(c, b.accents[i], t)) });

  /** Fade from the colours on screen to `p`. Instant when nobody would see it (hidden, resting, reduced motion). */
  function fadeTo(p, recolored) {
    cancelAnimationFrame(fading);
    const from = shown || DEFAULT;
    shown = p;
    note(p);
    const instant = document.hidden || document.body.classList.contains("paused") || document.body.classList.contains("reduce") ||
      (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (instant) { set(p); return recolored(); }
    const t0 = performance.now();
    let frames = 0;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / FADE_MS), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      set(between(from, p, e));
      if (t === 1 || ++frames % 8 === 0) recolored();             // the visualiser and themed covers read them too
      if (t < 1) fading = requestAnimationFrame(step);
    };
    fading = requestAnimationFrame(step);
  }

  /** The colourist's note: each colour's code beside a swatch (the swatches use the live colours). */
  function note(p) {
    const box = document.querySelector("#bg .cc-note");
    if (!box) return;
    box.textContent = "";
    box.append(Object.assign(document.createElement("span"), { textContent: "INKS //" }));
    p.accents.forEach((c, i) => {
      const row = document.createElement("span"), sw = document.createElement("b");
      sw.style.background = `var(--c${i + 1})`;
      row.append(sw, document.createTextNode(hex(c).slice(1)));
      box.append(row);
    });
  }

  /** The giant word across the page: the longest word of the playing song's title. */
  function word() {
    const el = document.querySelector("#bg .cc-word");
    if (!el) return;
    const n = window.cadenzaNow && window.cadenzaNow();
    const w = n && n.title ? n.title.replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).sort((a, b) => b.length - a.length)[0] || n.title : "Chroma";
    if (el.textContent === w) return;
    el.style.opacity = "0";
    setTimeout(() => { el.textContent = w; el.dataset.w = w; el.style.opacity = "1"; }, 350);
  }

  // ----- Long song titles -----
  // This theme's lettering is wide, so a long title is shrunk until it fits in three lines instead of
  // being cut off (from 4.8vh down to 2.4vh at most). Re-checked whenever the title changes.
  let titleWatch = null;
  function fitTitle() {
    const el = document.getElementById("np-title");
    if (!el) return;
    el.style.fontSize = "";
    let size = 4.8;
    const tooBig = () => el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2;
    while (size > 2.4 && tooBig()) { size -= 0.3; el.style.fontSize = size.toFixed(1) + "vh"; }
  }
  function watchTitle(on) {
    if (titleWatch) { titleWatch.disconnect(); titleWatch = null; }
    const el = document.getElementById("np-title");
    if (!el) return;
    if (!on) { el.style.fontSize = ""; lastTitle = null; const w = document.getElementById("np-artwrap"); if (w) delete w.dataset.spine; return; }
    lastTitle = el.textContent;
    spine();
    titleWatch = new MutationObserver(() => requestAnimationFrame(() => {
      fitTitle();
      // A different song (not the first one shown): flash an impact frame, and put its artist on the spine.
      const t = el.textContent;
      if (lastTitle !== null && t && t !== lastTitle) impact();
      lastTitle = t;
      spine();
    }));
    titleWatch.observe(el, { childList: true, characterData: true, subtree: true });
    requestAnimationFrame(fitTitle);
  }

  /** The spine beside the now-playing cover, like a manga volume's: the artist, and the album. */
  function spine() {
    const w = document.getElementById("np-artwrap");
    const n = window.cadenzaNow && window.cadenzaNow();
    if (w) w.dataset.spine = n ? [n.artist, n.album].filter(Boolean).join("  ·  ").toUpperCase() : "";
  }

  // ----- The poster -----
  const SHAPES = ["disc", "half", "arch", "bar", "wedge", "screen", "ring", "brush", "half"];
  /** Lay the shapes out for a song: where each sits, how big, which way it turns and which inks it uses.
   *  Seeded by the song, so a song always gets the same poster. */
  function compose(seedText) {
    const shapes = document.querySelectorAll("#bg .rs");
    if (!shapes.length) return;
    let seed = 0;
    for (const ch of String(seedText || "chroma")) seed = (seed * 31 + ch.charCodeAt(0)) % 233280;
    const r = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    // Rough zones so the poster spreads over the whole page instead of clumping: corners, edges, middle.
    const zones = [[-8, -10], [62, -14], [78, 48], [-10, 58], [30, 66], [44, 8], [12, 26], [88, 4], [52, 40]];
    const order = zones.map((z, i) => [r(), i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    shapes.forEach((el, i) => {
      const [zx, zy] = zones[order[i]];
      const x = zx + (r() - 0.5) * 16, y = zy + (r() - 0.5) * 16, rot = Math.round(r() * 360), sc = 0.7 + r() * 0.8;
      const k = (i + Math.floor(r() * 4)) % 4, k2 = (k + 1 + Math.floor(r() * 3)) % 4;
      el.style.setProperty("--k", `var(--c${k + 1})`);
      el.style.setProperty("--k2", `var(--c${k2 + 1})`);
      el.style.transform = `translate(${x.toFixed(1)}vw, ${y.toFixed(1)}vh) rotate(${rot}deg) scale(${sc.toFixed(2)})`;
    });
  }

  function pixels(src) {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => {
        try {
          const cv = document.createElement("canvas"); cv.width = cv.height = 40;
          const ctx = cv.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(im, 0, 0, 40, 40);
          resolve(ctx.getImageData(0, 0, 40, 40).data);
        } catch (e) { resolve(null); }
      };
      im.onerror = () => resolve(null);
      im.src = src;
    });
  }

  // ----- Pictures -----
  const NS = "http://www.w3.org/2000/svg";
  /** Four thick bands of smoke, one per ink, snaking side by side and overlapping a little, so each overlap
   *  prints as a new colour. Drawn as live SVG so the bands use the colour variables and fade with the rest. */
  function smoke(cls, seed) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "cc-smoke " + cls);
    svg.setAttribute("viewBox", "0 0 1300 700");
    svg.setAttribute("preserveAspectRatio", "none");
    let rnd = seed;
    const r = () => ((rnd = (rnd * 9301 + 49297) % 233280) / 233280);
    // One wandering centre line, with a curl in it, that every band follows at its own offset.
    const pts = [];
    for (let x = -100, y = 420; x <= 1400; x += 150) { pts.push([x, y]); y = clamp(y + (r() - 0.5) * 260, 220, 560); }
    const line = (off) => {
      let d = `M${pts[0][0]} ${pts[0][1] + off}`;
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], mx = (x0 + x1) / 2;
        d += ` C${mx} ${y0 + off} ${mx} ${y1 + off} ${x1} ${y1 + off}`;
      }
      return d;
    };
    for (let i = 0; i < 4; i++) {
      const off = (i - 1.5) * 40;
      const band = document.createElementNS(NS, "path");
      band.setAttribute("d", line(off)); band.setAttribute("stroke-width", "52");
      band.style.stroke = `var(--c${i + 1})`;
      band.style.opacity = ".85";
      svg.append(band);
    }
    return svg;
  }
  // Manga speed lines: thin wedges shooting out from a point, the way manga and anime frame a big moment.
  // Drawn once as a picture (cheap to show), in the given colour.
  function speedLines(color, cx, cy, count, inner) {
    let seed = 11, d = "";
    const r = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (r() - 0.5) * 0.05, w = 0.004 + r() * 0.012, r0 = inner * (0.75 + r() * 0.6), r1 = 1600;
      const p = (ang, rad) => (cx + Math.cos(ang) * rad).toFixed(1) + " " + (cy + Math.sin(ang) * rad).toFixed(1);
      d += `M${p(a, r0)}L${p(a - w, r1)}L${p(a + w, r1)}Z`;
    }
    return "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice"><path d="${d}" fill="${color}"/></svg>`);
  }
  // A rough brush stroke (used as a mask, so it can be printed in any of the inks).
  const brush = "data:image/svg+xml," + encodeURIComponent((() => {
    let seed = 5;
    const r = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    let top = "M10 60", bottom = "";
    const pts = [];
    for (let x = 10; x <= 590; x += 20) pts.push([x, 50 + Math.sin(x / 90) * 22 + (r() - 0.5) * 6, 22 + Math.sin(x / 40) * 6 + r() * 10 - (x > 480 ? (x - 480) / 6 : 0)]);
    pts.forEach(([x, y, t]) => { top += ` L${x} ${(y - t).toFixed(1)}`; });
    pts.reverse().forEach(([x, y, t]) => { bottom += ` L${x} ${(y + t * 0.8).toFixed(1)}`; });
    let dry = "";
    for (let k = 0; k < 9; k++) { const y = 40 + r() * 40, x0 = 380 + r() * 120; dry += `<rect x="${x0.toFixed(0)}" y="${y.toFixed(0)}" width="${(120 + r() * 90).toFixed(0)}" height="${(1 + r() * 3).toFixed(1)}" rx="1"/>`; }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 120"><path d="${top}${bottom} Z"/>${dry}</svg>`;
  })());

  // ----- Song changes: an impact frame -----
  // When a new song starts on Home, the screen flashes like an anime impact frame for a quarter of a
  // second: speed lines in ink on paper, then inverted, then gone. Not while hidden or with reduced motion.
  let lastTitle = null;
  function impact() {
    const el = document.querySelector("#sweep .cc-impact");
    if (!el || document.body.dataset.view !== "home" || document.hidden || document.body.classList.contains("paused") || document.body.classList.contains("reduce")) return;
    el.animate([
      { opacity: 0, filter: "none", scale: "1.08" }, { opacity: 1, filter: "none", scale: "1.04", offset: 0.08 },
      { opacity: 1, filter: "invert(1)", scale: "1.02", offset: 0.4 }, { opacity: 1, filter: "none", scale: "1", offset: 0.7 }, { opacity: 0, filter: "none", scale: "1" },
    ], { duration: 300, easing: "steps(6, end)" });
  }

  registerTheme({
    id: "chroma",

    background(bg, { h }) {
      bg.append(h("div", "cc-paper"), h("div", "cc-tint"));
      SHAPES.forEach((s) => {
        const el = h("div", "rs " + s);
        if (s === "brush") el.style.setProperty("--brush", `url("${brush}")`);
        bg.append(el);
      });
      // speed lines converging on the now-playing cover, and a strip of screentone behind the menu
      const sp = h("img", "cc-speed"); sp.alt = ""; sp.src = speedLines("#000", 760, 380, 150, 230);
      bg.append(sp, h("div", "cc-tone"));
      const w = h("div", "cc-word", "Chroma"); w.dataset.w = "Chroma";
      bg.append(smoke("s1", 3), w, h("div", "cc-dots"));
      const grain = h("div", "cc-grain");
      grain.style.backgroundImage = "url(\"data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><filter id="g"><feTurbulence type="fractalNoise" baseFrequency=".75" numOctaves="3" stitchTiles="stitch"/>' +
        '<feColorMatrix values="0 0 0 0 .55  0 0 0 0 .5  0 0 0 0 .45  0 0 0 -1.6 1.25"/></filter><rect width="100%" height="100%" filter="url(#g)"/></svg>') + "\")";
      const bar = h("div", "cc-bar");
      for (let i = 0; i < 4; i++) bar.append(h("i"));
      bg.append(grain, bar, h("div", "cc-note"));
      shown = null;
      note(DEFAULT);
      const n = window.cadenzaNow && window.cadenzaNow();
      compose(n && n.uri);
      watchTitle(true);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => requestAnimationFrame(fitTitle));   // once the wide font is in
    },

    /** Called with the playing song's cover whenever it changes (null when nothing plays). */
    async onArt(url, { dataURL, recolored }) {
      const t = ++token;
      word();
      const n = window.cadenzaNow && window.cadenzaNow();
      compose((n && n.uri) || url || "chroma");
      if (!url) return fadeTo(DEFAULT, recolored);
      const src = await dataURL(url);
      const px = src ? await pixels(src) : null;
      if (t !== token) return;                                    // the song changed again meanwhile
      fadeTo((px && palette(px)) || DEFAULT, recolored);
    },

    leave() {
      token++;
      watchTitle(false);
      cancelAnimationFrame(fading);
      shown = null;
      VARS.forEach((v) => root.style.removeProperty(v));
    },

    cover: { background: "#f2ead9", borderRight: "3vw solid #17141c", clipPath: "none" },

    overlay(sweep, { h }) {
      for (let i = 1; i <= 4; i++) sweep.append(h("div", "th cc-band b" + i));
      const imp = h("div", "th cc-impact"), lines = h("img"); lines.alt = ""; lines.src = speedLines("#fff", 500, 500, 220, 170);
      imp.append(lines);
      sweep.append(imp);
    },

    // Page change: the four colour bands blow across the screen one after another, like smoke.
    transition(sweep, dir, { play }) {
      return [...sweep.querySelectorAll(".cc-band")].map((el, i) => play(el,
        [{ translate: `${dir > 0 ? -150 : 150}vw 0` }, { translate: `${dir > 0 ? 150 : -150}vw 0` }],
        { duration: 520, delay: i * 45, easing: "cubic-bezier(.6,0,.35,1)", fill: "none" }));
    },

    // Confirm: just the small press-in from motion.confirm (no burst).
    onConfirm() {},

    motion: {
      in: (dir) => [{ transform: `translate3d(${dir * 6}vw,0,0)`, opacity: 0 }, { transform: "none", opacity: 1 }],
      out: (dir) => [{ transform: "none", opacity: 1 }, { transform: `translate3d(${-dir * 6}vw,0,0)`, opacity: 0 }],
      row: (dir) => [{ transform: `translate3d(${dir * 4}vw,0,0)`, opacity: 0 }, { transform: "none", opacity: 1 }],
      inMs: 300, outMs: 170, rowMs: 260, stagger: 20,
      inEase: "cubic-bezier(.25,1.3,.5,1)",
      select: { frames: [{ translate: "-1vw 0", scale: "1.04 1" }, { translate: "0 0", scale: "1 1" }], ms: 220 },
      confirm: { frames: [{ scale: "1.06", rotate: "-1deg" }, { scale: "1", rotate: "0deg" }], ms: 240 },
      hint: { frames: [{ translate: "-2vw 0", opacity: 0 }, { translate: "0 0", opacity: 1 }], ms: 240, ease: "cubic-bezier(.25,1.4,.5,1)" },
      intel: { frames: [{ translate: "1.5vw 1.5vh", opacity: 0 }, { translate: "0 0", opacity: 1 }], ms: 280, ease: "cubic-bezier(.25,1.3,.5,1)" },
      trackOut: {
        art: [{ translate: "0 0", rotate: "0deg", opacity: 1 }, { translate: "-3vw 0", rotate: "-6deg", opacity: 0 }],
        text: [{ translate: "0 0", opacity: 1 }, { translate: "3vw 0", opacity: 0 }], ms: 180 },
      trackIn: {
        art: [{ translate: "3vw 0", rotate: "6deg", opacity: 0 }, { translate: "0 0", rotate: "0deg", opacity: 1 }],
        text: [{ translate: "-3vw 0", opacity: 0 }, { translate: "0 0", opacity: 1 }], ms: 380 },
    },
  });
})();
