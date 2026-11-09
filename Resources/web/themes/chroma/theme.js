// CHROMA · COVER: takes its colours from the album cover that's playing. Each time the cover changes,
// it reads a small copy of it, picks a dark colour, an accent and a light colour from it, and sets the
// shared colour variables, so every page, the visualiser and (if that preference is on) every other
// cover follow along. The background is the cover itself, blurred, under a wash of those colours.
(() => {
  const VARS = ["--navy", "--navy-rgb", "--deep", "--deep-rgb", "--blue", "--cyan", "--cyan-rgb", "--ice", "--ice-rgb",
    "--white", "--white-rgb", "--placeholder", "--drawer-bg", "--liked-bg"];
  const root = document.documentElement;
  let token = 0, layer = 0;

  // ----- Colour helpers -----
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const hex = (c) => "#" + c.map((v) => clamp(v, 0, 255).toString(16).padStart(2, "0")).join("");
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

  /** Dark, accent and light colours from a cover's pixels. */
  function palette(px) {
    const all = [], bins = Array.from({ length: 12 }, () => ({ w: 0, c: [0, 0, 0] }));
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      const c = [px[i], px[i + 1], px[i + 2]], [h, s, l] = toHsl(c);
      all.push(c);
      // The accent is the hue with the most strong, mid-bright colour in it.
      if (s > 0.22 && l > 0.15 && l < 0.88) {
        const w = s * s * (1 - Math.abs(l - 0.55)), b = bins[Math.floor(h * 12) % 12];
        b.w += w; b.c = b.c.map((v, k) => v + c[k] * w);
      }
    }
    if (!all.length) return null;
    all.sort((a, b) => lum(a) - lum(b));
    const avg = (list) => list.reduce((s, c) => s.map((v, k) => v + c[k]), [0, 0, 0]).map((v) => v / list.length);
    const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
    let accent;
    if (best.w > all.length * 0.01) {
      const [h, s, l] = toHsl(best.c.map((v) => v / best.w));
      accent = fromHsl([h, clamp(s, 0.55, 0.95), clamp(l, 0.56, 0.68)]);   // vivid enough to read on the dark colour
    } else {
      const [h, s] = toHsl(avg(all));                                        // a black-and-white cover: a soft grey
      accent = fromHsl([h, Math.min(s, 0.12), 0.72]);
    }
    // The dark colour: the cover's own darkest tones, pulled down so text stays readable, with a touch of the accent.
    let dark = avg(all.slice(0, Math.max(1, Math.floor(all.length * 0.3))));
    const [dh, ds] = toHsl(dark);
    dark = mix(fromHsl([dh, Math.min(ds, 0.6), 0.09]), accent, 0.1);
    return { dark, accent };
  }

  function paint(p) {
    const { dark, accent } = p;
    const [ah, as] = toHsl(accent);
    const deep = mix(dark, accent, 0.18), blue = fromHsl([ah, Math.min(as, 0.8), 0.34]);
    const ice = mix(accent, [255, 255, 255], 0.68), white = mix(accent, [255, 255, 255], 0.93);
    const set = {
      "--navy": hex(dark), "--navy-rgb": dark.join(" "),
      "--deep": hex(deep), "--deep-rgb": deep.join(" "),
      "--blue": hex(blue),
      "--cyan": hex(accent), "--cyan-rgb": accent.join(" "),
      "--ice": hex(ice), "--ice-rgb": ice.join(" "),
      "--white": hex(white), "--white-rgb": white.join(" "),
      "--placeholder": hex(mix(dark, accent, 0.3)),
      "--drawer-bg": `linear-gradient(180deg, ${hex(mix(dark, accent, 0.4))}, ${hex(dark)})`,
      "--liked-bg": `linear-gradient(135deg, ${hex(accent)}, ${hex(ice)})`,
    };
    for (const [k, v] of Object.entries(set)) root.style.setProperty(k, v);
  }
  const reset = () => VARS.forEach((v) => root.style.removeProperty(v));

  /** A small copy of the picture, as pixels. */
  function pixels(src) {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => {
        try {
          const cv = document.createElement("canvas"); cv.width = cv.height = 32;
          const ctx = cv.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(im, 0, 0, 32, 32);
          resolve(ctx.getImageData(0, 0, 32, 32).data);
        } catch (e) { resolve(null); }                            // a picture we're not allowed to read
      };
      im.onerror = () => resolve(null);
      im.src = src;
    });
  }

  registerTheme({
    id: "chroma",

    background(bg, { h }) {
      bg.append(h("div", "ch-base"), h("div", "ch-art"), h("div", "ch-art"), h("div", "ch-wash"),
        h("div", "ch-blob a"), h("div", "ch-blob b"), h("div", "ch-blob c"));
      const grain = h("div", "ch-grain");
      grain.style.backgroundImage = "url(\"data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>') + "\")";
      bg.append(grain);
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
      if (!url) { reset(); return recolored(); }
      const src = await dataURL(url);
      const px = src ? await pixels(src) : null;
      if (t !== token) return;                                    // the song changed again meanwhile
      const p = px && palette(px);
      if (p) paint(p); else reset();
      recolored();
    },

    /** Switching to another theme: hand the colour variables back to its stylesheet. */
    leave() { token++; reset(); },

    cover: { background: "#14101c", borderRight: "3vw solid #b48cff", clipPath: "none" },

    overlay(sweep, { h }) { sweep.append(h("div", "th ch-bloom")); },

    transition(sweep, dir, { play }) {
      const anims = [...sweep.querySelectorAll(".a, .b, .c")].map((el, i) => play(el,
        [{ transform: `translate3d(${dir > 0 ? "-60vw" : "160vw"},0,0) skewX(-12deg)`, opacity: 0.5 }, { transform: `translate3d(${dir > 0 ? "160vw" : "-60vw"},0,0) skewX(-12deg)`, opacity: 0.5 }],
        { duration: 480, delay: i * 40, easing: "cubic-bezier(.55,.05,.35,1)", fill: "none" }));
      anims.push(play(sweep.querySelector(".ch-bloom"), [{ scale: ".2", opacity: 0.9 }, { scale: "1.6", opacity: 0 }],
        { duration: 650, easing: "cubic-bezier(.15,.7,.3,1)", fill: "none" }));
      return anims;
    },

    motion: {
      select: { frames: [{ scale: "1.08 1", opacity: 0.6 }, { scale: "1 1", opacity: 1 }], ms: 260 },
      confirm: { frames: [{ scale: "1.05" }, { scale: "1" }], ms: 240 },
      hint: { frames: [{ translate: "0 1vh", opacity: 0 }, { translate: "0 0", opacity: 1 }], ms: 260, ease: "cubic-bezier(.3,1.2,.5,1)" },
      trackOut: {
        art: [{ scale: "1", opacity: 1 }, { scale: ".9", opacity: 0 }],
        text: [{ translate: "0 0", opacity: 1 }, { translate: "0 -1.5vh", opacity: 0 }], ms: 200 },
      trackIn: {
        art: [{ scale: "1.08", opacity: 0 }, { scale: "1", opacity: 1 }],
        text: [{ translate: "0 1.5vh", opacity: 0 }, { translate: "0 0", opacity: 1 }], ms: 420 },
    },
  });
})();
