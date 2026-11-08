// STUDIO · MINIMAL: quiet motion, sentence-case type and one accent colour.
(() => {
  const KEEP = new Set(["DJ", "EQ", "AI", "OK", "USB", "TV", "ID", "LP", "EP"]);
  /** "NOW PLAYING" → "Now playing", "DJ" stays "DJ". */
  const sentence = (s) => String(s).toLowerCase().replace(/[a-z0-9']+/g, (w) => (KEEP.has(w.toUpperCase()) ? w.toUpperCase() : w))
    .replace(/^\s*([a-z])/, (m) => m.toUpperCase());
  // Line icons for the Home tiles (24×24, stroked).
  const ICONS = {
    dj: "M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v5H5a1 1 0 0 1-1-1zM20 14h-3v5h2a1 1 0 0 0 1-1z",
    lyrics: "M5 7h14M5 12h10M5 17h7M17 15v6M17 15l3-1",
    library: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
    search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
    queue: "M4 6h16M4 12h11M4 18h7M17 15l4 3-4 3z",
    output: "M7 4h10v16H7zM12 16a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 8h.01",
    eq: "M6 4v16M12 4v16M18 4v16M4 15h4M10 9h4M16 13h4",
    system: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  };
  const greeting = () => { const h = new Date().getHours(); return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  registerTheme({
    id: "min",

    // Home is a 4-column grid of tiles: ←→ move along a row, ↑↓ between rows.
    homeCols: 4,

    background(bg, { h }) {
      bg.append(h("div", "min-base"), h("div", "min-rule"), h("div", "min-mark", "Cadenza"));
      // A greeting above the Home tiles; it follows the time of day.
      const g = h("div", "min-greet"), b = h("b"), sub = h("span", null, "Pick up where you left off, or try something new.");
      g.append(b, sub); bg.append(g);
      const tick = () => { if (!g.isConnected) return; b.textContent = greeting() + "."; setTimeout(tick, 60000); };
      tick();
    },

    text(el, text, kind, opts = {}) {
      switch (kind) {
        case "menu": {
          // A tile: icon, name, and a one-line description.
          el.textContent = "";
          const mi = document.createElement("i"); mi.className = "mi";
          mi.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[opts.id] || ICONS.library}"/></svg>`;
          const b = document.createElement("b"); b.textContent = sentence(text);
          const sm = document.createElement("small"); sm.textContent = opts.hint || "";
          el.append(mi, b, sm);
          return true;
        }
        case "header": case "tag": el.textContent = sentence(text); return true;
        case "date": {
          const [m, d] = String(text).split("/");
          el.textContent = MONTHS[(+m || 1) - 1] + " " + d;
          return true;
        }
        default: return false;
      }
    },

    overlay(sweep, { h }) { sweep.append(h("i", "th min-line")); },

    // Page change: a thin accent line runs along the top edge.
    transition(sweep, dir, { play }) {
      const line = sweep.querySelector(".min-line");
      line.style.transformOrigin = dir > 0 ? "left center" : "right center";
      return [play(line, [{ scale: "0 1", opacity: 1 }, { scale: "1 1", opacity: 1, offset: 0.7 }, { scale: "1 1", opacity: 0 }],
        { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)", fill: "none" })];
    },

    cover: { background: "#f4f4f1", borderRight: ".4vw solid #3a5cff", clipPath: "none" },

    motion: {
      in: (dir) => [{ transform: `translate3d(${dir * 2}vw,0,0)`, opacity: 0 }, { transform: "none", opacity: 1 }],
      out: (dir) => [{ transform: "none", opacity: 1 }, { transform: `translate3d(${-dir * 1}vw,0,0)`, opacity: 0 }],
      row: () => [{ transform: "translate3d(0,1.2vh,0)", opacity: 0 }, { transform: "none", opacity: 1 }],
      inMs: 260, outMs: 130, rowMs: 240, stagger: 14,
      inEase: "cubic-bezier(.2,.8,.2,1)",
      select: { frames: [{ scale: ".97 .92", opacity: 0.6 }, { scale: "1 1", opacity: 1 }], ms: 160 },
      confirm: { frames: [{ scale: ".985" }, { scale: "1" }], ms: 140 },
      shake: false,
      hint: { frames: [{ opacity: 0 }, { opacity: 1 }], ms: 200 },
      intel: { frames: [{ translate: "0 1vh", opacity: 0 }, { translate: "0 0", opacity: 1 }], ms: 260, ease: "cubic-bezier(.2,.8,.2,1)" },
      trackOut: { art: [{ scale: "1", opacity: 1 }, { scale: ".97", opacity: 0 }], text: [{ opacity: 1 }, { opacity: 0 }], ms: 160 },
      trackIn: { art: [{ scale: ".97", opacity: 0 }, { scale: "1", opacity: 1 }], text: [{ translate: "0 .8vh", opacity: 0 }, { translate: "0 0", opacity: 1 }], ms: 320 },
    },
  });
})();
