// NEON · CITY: a night-city HUD with hard edges, data readouts, scan lines and glitches.
// Its layout differs from Tide and Heist: a framed menu column, a wide now-playing deck, a
// horizontal data-shard card, and full-width windows for every page.
(() => {
  const GLYPHS = "ABCDEF0123456789#$%&/\\<>[]{}=+*?_";
  const rand = (n) => Math.floor(Math.random() * n);
  const svg = (w, h, body, extra = "") =>
    "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ${extra}>${body}</svg>`);

  /** Text "decrypts" into place: random glyphs resolve left to right. */
  const running = new WeakMap();
  function decode(el, text, ms = 360) {
    const final = String(text);
    el.dataset.glitch = final;
    if (document.body.classList.contains("reduce") || !final.trim()) { el.textContent = final; return; }
    const prev = running.get(el);
    if (prev) cancelAnimationFrame(prev);
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      const shown = Math.floor(final.length * t);
      let out = final.slice(0, shown);
      for (let i = shown; i < final.length; i++) out += final[i] === " " ? " " : GLYPHS[rand(GLYPHS.length)];
      el.textContent = out;
      if (t < 1) running.set(el, requestAnimationFrame(step));
      else { el.textContent = final; running.delete(el); }
    };
    running.set(el, requestAnimationFrame(step));
  }

  // A night skyline, drawn once as an image (only its position ever changes).
  function skyline() {
    let body = "", x = 0;
    while (x < 1600) {
      const w = 30 + rand(70), hgt = 120 + rand(360), y = 520 - hgt;
      body += `<rect x="${x}" y="${y}" width="${w}" height="${hgt}" fill="#07080d"/>`;
      if (rand(3) === 0) body += `<rect x="${x + w / 2 - 1}" y="${y - 30 - rand(40)}" width="2" height="40" fill="#07080d"/>`;
      for (let wy = y + 10; wy < 510; wy += 14) for (let wx = x + 5; wx < x + w - 6; wx += 9)
        if (Math.random() < 0.09) body += `<rect x="${wx}" y="${wy}" width="4" height="3" fill="${["#fcee0a", "#5ef6ff", "#ff003c"][rand(3)]}" opacity="${(0.25 + Math.random() * 0.55).toFixed(2)}"/>`;
      x += w + rand(6);
    }
    return svg(1600, 520, body, 'viewBox="0 0 1600 520" preserveAspectRatio="none"');
  }

  registerTheme({
    id: "neon",

    background(bg, { h }) {
      bg.append(h("div", "cp-haze"));
      const city = h("img", "cp-city"); city.alt = ""; city.src = skyline(); bg.append(city);
      // The floor: a tilted plane whose grid scrolls toward you along the plane (a seamless loop, one square per cycle).
      const floor = h("div", "cp-floor"), plane = h("div", "cp-grid");
      plane.append(h("i")); floor.append(plane); bg.append(floor);
      // Rain: streaks drawn once into a tile image; the layer only slides down (no repainting).
      let streaks = "";
      for (let i = 0; i < 70; i++) {
        const x = rand(600), y = rand(600), len = 14 + rand(26);
        streaks += `<line x1="${x}" y1="${y}" x2="${x - len * 0.18}" y2="${y + len}" stroke="${i % 3 ? "#5ef6ff" : "#ffffff"}" stroke-opacity="${(0.25 + Math.random() * 0.5).toFixed(2)}" stroke-width="1"/>`;
      }
      const rain = h("div", "cp-rain"), sheet = h("i");
      sheet.style.backgroundImage = `url("${svg(600, 600, streaks)}")`;
      rain.append(sheet); bg.append(rain);
      // A neon sign that buzzes and flickers.
      bg.append(h("div", "cp-neon", "CADENZA"), h("div", "cp-neon sub", "24H · NIGHT RADIO"));
      // A column of scrolling data on the right edge.
      const lines = Array.from({ length: 60 }, () =>
        Array.from({ length: 4 }, () => (rand(65536)).toString(16).toUpperCase().padStart(4, "0")).join(" ")).join("\n");
      const stream = h("pre", "cp-stream"); stream.textContent = lines + "\n" + lines + "\n";     // two identical halves, so the scroll loops with no jump
      bg.append(stream);
      // HUD frame: corner brackets and a header rule with readouts.
      ["tl", "tr", "bl", "br"].forEach((c) => bg.append(h("i", "cp-corner " + c)));
      bg.append(h("div", "cp-rule"), h("div", "cp-sys", "CADENZA OS v2.0.77  //  NET: ONLINE  //  SECTOR 6"));
    },

    // kind: "menu" (home items), "header" (view titles), "date" (clock), "tag" (small labels)
    text(el, text, kind, opts) {
      switch (kind) {
        case "menu":
          el.textContent = text;
          el.dataset.glitch = text;
          if (opts.active) decode(el, text, 220);
          return true;
        case "header": decode(el, text, 420); return true;
        case "tag": decode(el, text, 260); return true;
        case "date": el.textContent = String(text).replace("/", ".") + ".77"; return true;
        default: return false;
      }
    },

    // Transition pieces (in #sweep, above everything): glitch slices, a scan beam, a status line,
    // a confirm frame, and a permanent CRT scan-line overlay.
    overlay(sweep, { h }) {
      sweep.append(h("i", "th cp-scanlines"));
      for (let i = 0; i < 8; i++) sweep.append(h("i", "th cp-slice s" + i));
      sweep.append(h("i", "th cp-beam"));
      const tag = h("b", "th cp-tag"); tag.textContent = "> ACCESSING"; sweep.append(tag);
      const frame = h("i", "th cp-frame"); frame.append(h("i"), h("i"), h("i"), h("i")); sweep.append(frame);
    },

    // Page change: the screen tears into horizontal glitch slices that jitter sideways,
    // a scan beam drops through, and a status line names where you're going.
    transition(sweep, dir, { play }) {
      const anims = [];
      sweep.querySelectorAll(".cp-slice").forEach((el, i) => {
        el.style.top = (rand(92)) + "vh";
        el.style.height = (0.6 + Math.random() * 5) + "vh";
        const a = (Math.random() * 30 - 15) * dir, b = (Math.random() * 30 - 15) * dir;
        anims.push(play(el, [
          { translate: `${a}vw 0`, scale: "0 1", opacity: 1 },
          { translate: `${b}vw 0`, scale: "1 1", opacity: 1, offset: 0.3 },
          { translate: `${-a}vw 0`, scale: ".6 1", opacity: .9, offset: 0.6 },
          { translate: `${b * 2}vw 0`, scale: "0 1", opacity: 0 },
        ], { duration: 300, delay: i * 18, easing: "steps(6, end)", fill: "none" }));
      });
      const beam = sweep.querySelector(".cp-beam");
      anims.push(play(beam, dir > 0
        ? [{ translate: "0 -6vh", opacity: 1 }, { translate: "0 106vh", opacity: 1 }]
        : [{ translate: "0 106vh", opacity: 1 }, { translate: "0 -6vh", opacity: 1 }],
        { duration: 380, easing: "cubic-bezier(.5,0,.5,1)", fill: "none" }));
      const tag = sweep.querySelector(".cp-tag");
      // Name the destination as soon as the app switches to it.
      const was = document.body.dataset.view, t0 = performance.now();
      tag.textContent = dir > 0 ? "> ACCESSING //" : "< RETURNING //";
      const watch = () => {
        const v = document.body.dataset.view;
        if (v === was && performance.now() - t0 < 400) return requestAnimationFrame(watch);
        const name = (v || "").toUpperCase();
        decode(tag, (dir > 0 ? "> ACCESSING //" : "< RETURNING //") + (name === "OUTPUT" ? "DEVICES" : name), 180);
      };
      requestAnimationFrame(watch);
      anims.push(play(tag, [
        { opacity: 0, translate: "-2vw 0" }, { opacity: 1, translate: "0 0", offset: .2 },
        { opacity: .3, offset: .4 }, { opacity: 1, offset: .55 }, { opacity: 1, offset: .85 }, { opacity: 0, translate: "1vw 0" },
      ], { duration: 520, easing: "linear", fill: "none" }));
      return anims;
    },

    // Choosing something: a targeting frame locks onto it, and a little burst of glitch slices.
    onConfirm(el, { play }) {
      const sweep = document.getElementById("sweep");
      const frame = sweep.querySelector(".cp-frame");
      if (!frame || !el.getBoundingClientRect) return;
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      Object.assign(frame.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
      play(frame, [
        { scale: "1.25", opacity: 0 }, { scale: "1", opacity: 1, offset: .35 },
        { opacity: .2, offset: .5 }, { opacity: 1, offset: .62 }, { scale: "1.04", opacity: 0 },
      ], { duration: 420, easing: "cubic-bezier(.2,.9,.2,1)", fill: "none" });
    },

    // Switching *to* this theme: a black panel with a yellow edge and a cut corner.
    cover: { background: "#050608", borderRight: "1.4vw solid #fcee0a", clipPath: "polygon(0 0, 100% 0, 100% 86%, 95% 100%, 0 100%)" },

    motion: {
      // Panels power on like a CRT: a thin line that opens up, with a flicker.
      in: (dir) => [
        { transform: `translate3d(${dir * -1.5}vw,0,0) scale(1,.04)`, opacity: 0 },
        { transform: "translate3d(0,0,0) scale(1,1.04)", opacity: 1, offset: .45 },
        { transform: "translate3d(0,0,0) scale(1,1)", opacity: .35, offset: .6 },
        { transform: "translate3d(0,0,0) scale(1,1)", opacity: 1, offset: .75 },
        { transform: "none", opacity: 1 },
      ],
      // …and power off: they collapse into a line and blink out.
      out: (dir) => [
        { transform: "none", opacity: 1 },
        { transform: `translate3d(${dir * 1.5}vw,0,0) scale(1.02,.05)`, opacity: .8, offset: .6 },
        { transform: `translate3d(${dir * 3}vw,0,0) scale(.2,.02)`, opacity: 0 },
      ],
      // Rows boot in one after another, sliding a short way with a flicker.
      row: (dir) => [
        { transform: `translate3d(${dir * 3}vw,0,0)`, opacity: 0 },
        { transform: "translate3d(0,0,0)", opacity: .6, offset: .5 },
        { transform: "translate3d(0,0,0)", opacity: .2, offset: .65 },
        { transform: "none", opacity: 1 },
      ],
      inMs: 300, outMs: 160, rowMs: 240, stagger: 20,
      inEase: "cubic-bezier(.2,.9,.1,1)",

      // Home highlight snaps open from a thin line; its offset echo jitters into place.
      select: {
        frames: [{ scale: "1 .08", translate: "-.8vw 0" }, { scale: "1 1.1", translate: ".2vw 0", offset: .6 }, { scale: "1 1", translate: "0 0" }], ms: 180,
        shadow: [{ translate: "-1vw 0", opacity: 1 }, { translate: ".8vw .3vh", opacity: .6, offset: .4 }, { translate: "-.3vw 0", opacity: 1, offset: .7 }, { translate: ".35vw .35vh", opacity: 1 }],
      },
      // Enter / click: a quick sideways glitch jitter (no screen shake here).
      confirm: { frames: [{ translate: "0 0" }, { translate: "-.5vw 0", offset: .2 }, { translate: ".35vw 0", offset: .45 }, { translate: "-.15vw 0", offset: .7 }, { translate: "0 0" }], ms: 200 },
      shake: false,
      // Hint text types itself out on the terminal line.
      hint: { frames: [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], ms: 380, ease: "steps(22, end)" },
      // The data shard re-scans top to bottom.
      intel: { frames: [{ scale: "1 .03", opacity: .2 }, { scale: "1 1.03", opacity: 1, offset: .55 }, { opacity: .5, offset: .7 }, { scale: "1 1", opacity: 1 }], ms: 300, ease: "cubic-bezier(.2,.9,.1,1)" },
      // New track: the old picture switches off like a CRT; the new one tunes in with a flicker.
      trackOut: {
        art: [{ scale: "1 1", opacity: 1 }, { scale: "1.05 .02", opacity: 1, offset: .7 }, { scale: "0 .02", opacity: 0 }],
        text: [{ translate: "0 0", opacity: 1 }, { translate: "1.5vw 0", opacity: 0 }], ms: 170 },
      trackIn: {
        art: [{ scale: "0 .02", opacity: 0 }, { scale: "1.05 .02", opacity: 1, offset: .25 }, { scale: "1 1", opacity: 1, offset: .55 },
              { opacity: .3, offset: .68 }, { opacity: 1, offset: .8 }, { scale: "1 1", opacity: 1 }],
        text: [{ translate: "-1.5vw 0", opacity: 0 }, { translate: ".3vw 0", opacity: .7, offset: .5 }, { translate: "0 0", opacity: 1 }], ms: 420 },
    },
  });
})();
