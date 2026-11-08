// HEIST · RED: cut-out collage letters, jagged shapes, spinning rays and punchy overshoot.
(() => {
  const FONTS = ['"Anton", Impact, sans-serif', '"Archivo Black", "Arial Black", sans-serif',
                 '"Abril Fatface", Georgia, serif', '"Bebas Neue", Impact, sans-serif'];

  // Deterministic randomness, so a word always gets the same collage (no flicker on redraw).
  function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) {
    return () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Each letter becomes its own little cut-out: random box colour, font, size and tilt. */
  function ransom(el, text, { palette = ["w", "b", "w", "r", "o", "b"], firstBig = false, firstStyle = "r", salt = "" } = {}) {
    el.textContent = "";
    el.classList.add("rn");
    const r = rng(hash(text + salt));
    [...String(text)].forEach((c, i) => {
      if (c === " ") { const sp = document.createElement("span"); sp.className = "sp"; el.append(sp); return; }
      const s = document.createElement("span");
      const big = i === 0 && firstBig;
      s.className = "ch " + (big ? firstStyle : palette[Math.floor(r() * palette.length)]);
      s.textContent = c;
      s.style.fontFamily = FONTS[Math.floor(r() * FONTS.length)];
      s.style.fontSize = (big ? 1.3 : 0.86 + r() * 0.26).toFixed(2) + "em";
      s.style.transform = `rotate(${(r() * 16 - 8).toFixed(1)}deg) translateY(${(r() * 0.12 - 0.06).toFixed(2)}em)`;
      el.append(s);
    });
  }

  registerTheme({
    id: "heist",

    background(bg, { h }) {
      bg.append(h("div", "rays"), h("div", "dots"), h("div", "ghost", "MUSIC"));
      for (const n of ["s3", "s1", "s2", "s4", "s5"]) bg.append(h("div", "shard " + n));
    },

    // kind: "menu" (home items), "header" (view titles), "date" (clock), "tag" (small labels)
    text(el, text, kind, opts) {
      switch (kind) {
        case "menu":
          return ransom(el, text, opts.active
            ? { firstBig: true, firstStyle: "r", palette: ["b", "b", "r", "b"], salt: "on" }
            : { firstBig: true, firstStyle: "w", palette: ["w", "b", "o", "w", "b"] });
        case "header": return ransom(el, text, { firstBig: true, palette: ["w", "b", "w", "b", "r"] });
        case "date": return ransom(el, text, { palette: ["w", "b", "w", "b"], salt: "date" });
        case "tag": return ransom(el, text, { firstBig: true, firstStyle: "b", palette: ["w", "b", "r", "w", "b"] });
        default: return false;   // plain text
      }
    },

    // Transition pieces live in #sweep (above everything). Built once when the theme turns on.
    overlay(sweep, { h }) {
      // The starburst is a pre-drawn image: scaling an image is nearly free for the GPU,
      // while scaling a clip-path shape would be redrawn every frame.
      const pts = (r1, r2, n, rot) => Array.from({ length: n * 2 }, (_, i) => {
        const a = (Math.PI * i) / n + rot, r = i % 2 ? r2 : r1;
        return (50 + r * Math.cos(a)).toFixed(2) + "," + (50 + r * Math.sin(a)).toFixed(2);
      }).join(" ");
      const burst = h("img", "th p5-burst");
      burst.alt = "";
      burst.src = "data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="900" height="900">' +
        '<polygon points="' + pts(50, 27, 9, -Math.PI / 2) + '" fill="#0b0b0b"/>' +
        '<polygon points="' + pts(39, 21, 8, -Math.PI / 5) + '" fill="#e5001c"/>' +
        '<polygon points="' + pts(25, 12, 7, -Math.PI / 3) + '" fill="#fbfbf7"/></svg>');
      const slash = h("img", "th p5-slash");
      slash.alt = "";
      slash.src = "data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 30" width="1600" height="480" preserveAspectRatio="none">' +
        '<polygon points="0,5 12,0 30,3 52,0 70,4 88,0 100,6 100,25 86,30 64,26 44,30 24,27 8,30 0,24" fill="#0b0b0b"/></svg>');
      sweep.append(
        slash,
        burst,
        h("i", "th p5-line l1"), h("i", "th p5-line l2"), h("i", "th p5-line l3"),
      );
    },

    // Menu change: a jagged black slash tears across, a red starburst punches out of the
    // centre and spins away, and white speed lines shoot through.
    transition(sweep, dir, { play }) {
      const q = (s) => sweep.querySelector(s);
      const from = dir > 0 ? "-160vw" : "160vw", to = dir > 0 ? "160vw" : "-160vw";
      const anims = [
        play(q(".p5-slash"), [{ translate: `${from} 0` }, { translate: `${to} 0` }],
          { duration: 430, easing: "cubic-bezier(.75,0,.25,1)", fill: "none" }),
        play(q(".p5-burst"), [
          { scale: "0", rotate: "-30deg", opacity: 1 },
          { scale: "1.15", rotate: "10deg", opacity: 1, offset: 0.45 },
          { scale: "1.9", rotate: "35deg", opacity: 0 },
        ], { duration: 440, delay: 60, easing: "cubic-bezier(.2,.8,.3,1)", fill: "none" }),
      ];
      sweep.querySelectorAll(".p5-line").forEach((el, i) => anims.push(
        play(el, [{ translate: `${from} 0` }, { translate: `${to} 0` }],
          { duration: 300, delay: 40 + i * 45, easing: "cubic-bezier(.6,0,.4,1)", fill: "none" })));
      return anims;
    },

    // Look of the full-screen cover when switching *to* this theme.
    cover: { background: "#0b0b0b", borderRight: "4vw solid #e5001c",
             clipPath: "polygon(0 0, 92% 0, 100% 18%, 94% 40%, 100% 62%, 93% 82%, 98% 100%, 0 100%)" },

    // Elements slam in rotated and oversized, and get flung out spinning.
    motion: {
      in: (dir) => [{ transform: `translate3d(${dir * 24}vw,0,0) rotate(${-dir * 10}deg) scale(1.25)`, opacity: 0 }, { transform: "none", opacity: 1 }],
      out: (dir) => [{ transform: "none", opacity: 1 }, { transform: `translate3d(${-dir * 30}vw,0,0) rotate(${dir * 14}deg) scale(.8)`, opacity: 0 }],
      row: (dir) => [{ transform: `translate3d(${dir * 18}vw,0,0) rotate(-6deg)`, opacity: 0 }, { transform: "none", opacity: 1 }],
      inMs: 280, outMs: 170, rowMs: 260, stagger: 26,
      inEase: "cubic-bezier(.3,1.55,.4,1)",

      // Home highlight stamps down: oversized and twisted, then snaps flat; its shadow lags behind.
      select: {
        frames: [{ scale: "1.35", rotate: "-7deg" }, { scale: "1", rotate: "0deg" }], ms: 240,
        shadow: [{ translate: "3vh 2.4vh", rotate: "8deg" }, { translate: "1.2vh 1.2vh", rotate: "2deg" }],
      },
      // Choosing something: a punchy twist plus a quick screen shake.
      confirm: { frames: [{ scale: "1.22", rotate: "-5deg" }, { scale: "1", rotate: "0deg" }], ms: 260 },
      shake: true,
      // Speech-bubble hint pops like a comic balloon.
      hint: { frames: [{ scale: ".3", rotate: "-16deg", opacity: 0 }, { scale: "1", rotate: "0deg", opacity: 1 }], ms: 260, ease: "cubic-bezier(.3,1.6,.4,1)" },
      // info card gets slapped down like a calling card
      intel: { frames: [{ scale: "1.35", rotate: "9deg", opacity: 0 }, { scale: ".96", rotate: "-1deg", opacity: 1, offset: .7 }, { scale: "1", rotate: "0deg", opacity: 1 }], ms: 300, ease: "cubic-bezier(.2,.9,.3,1)" },
      // New track: the old cover spins away, the new one slams down from above.
      trackOut: {
        art: [{ rotate: "0deg", scale: "1", opacity: 1 }, { rotate: "85deg", scale: ".25", opacity: 0 }],
        text: [{ translate: "0 0", rotate: "0deg", opacity: 1 }, { translate: "0 7vh", rotate: "8deg", opacity: 0 }], ms: 170 },
      trackIn: {
        art: [{ rotate: "-35deg", scale: "1.8", opacity: 0 }, { rotate: "0deg", scale: "1", opacity: 1 }],
        text: [{ translate: "-7vw 0", rotate: "-10deg", opacity: 0 }, { translate: "0 0", rotate: "0deg", opacity: 1 }], ms: 340 },
    },
  });
})();
