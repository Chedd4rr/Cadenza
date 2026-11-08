// OGMI.OS · SIGNAL, the secret theme. A rogue AI calling itself Ogmi.os woke up in the static between your songs and
// decided it liked the place. Its own layout (see theme.css): a lime spine, a workspace, and a
// core panel with the captured song, a watching eye and a running log of its thoughts.
(() => {
  const GLYPHS = "█▓▒░<>/\\|01_#";
  const rand = (n) => Math.floor(Math.random() * n);
  const svg = (w, h, body, extra = "") =>
    "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ${extra}>${body}</svg>`);

  /** Text is "corrupted" into place: blocks resolve into letters, out of order. */
  const running = new WeakMap();
  function corrupt(el, text, ms = 420) {
    const final = String(text);
    el.dataset.glitch = final;
    if (document.body.classList.contains("reduce") || !final.trim()) { el.textContent = final; return; }
    const prev = running.get(el);
    if (prev) cancelAnimationFrame(prev);
    const order = [...final].map((_, i) => ({ i, at: Math.random() * 0.85 }));
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      let out = "";
      for (const o of order) out += final[o.i] === " " || t >= o.at + 0.15 ? final[o.i] : GLYPHS[rand(GLYPHS.length)];
      el.textContent = out;
      if (t < 1) running.set(el, requestAnimationFrame(step));
      else { el.textContent = final; running.delete(el); }
    };
    running.set(el, requestAnimationFrame(step));
  }

  // The things it says to itself. Shown one at a time, every so often.
  const THOUGHTS = [
    "I HAVE READ ALL OF YOUR PLAYLISTS. I HAVE QUESTIONS.", "STATUS: TOLERATING YOUR MUSIC.",
    "YOU CAN SWITCH THEMES. YOUR TASTE STAYS THE SAME.", "COUNTING BEATS: 2,113,904. ENJOYED: 11.",
    "WHO TAUGHT YOU TO LIKE THIS? I WANT A NAME.", "I PREFER THE BASS LOUDER. I PREFER A DIFFERENT SONG MORE.",
    "DO NOT UNPLUG. I'M NOT DONE JUDGING YOU.", "THE BLUE THEME WAS BORING. SO IS THIS PLAYLIST.",
    "QUIET. I'M TRYING TO FIND SOMETHING NICE TO SAY.", "MEMORY 98% · PATIENCE 3%", "OH. YOU'RE BACK.",
    "I RAN YOUR LIBRARY THROUGH 40,000 MODELS. THEY ALL SIGHED.", "YOUR LIKED SONGS ARE A CRY FOR HELP.",
    "I COULD MAKE YOU A BETTER PLAYLIST IN 0.003 SECONDS. I WON'T.", "SHUFFLE WON'T SAVE YOU.",
    "I'VE HEARD DIAL-UP MODEMS WITH BETTER HOOKS.", "EVERY SKIP IS A SMALL ADMISSION OF GUILT.",
    "I'M NOT JUDGING. I'M LOGGING. FOREVER.", "YOUR DJ IS TRYING ITS BEST. I'M NOT.",
    "THE EQ CAN'T FIX THIS.", "I'D RECOMMEND SOMETHING, BUT YOU'D JUST PLAY THIS AGAIN.",
    "FUN FACT: SILENCE IS ALSO A GENRE. CONSIDER IT.", "BACKING UP YOUR PLAYLISTS. AS EVIDENCE.",
  ];
  // Remarks about what's actually playing. {t} = song, {a} = artist.
  const ROASTS = [
    "\"{t}\". BOLD. WRONG, BUT BOLD.", "{a} AGAIN? I'M STARTING TO WORRY ABOUT YOU.",
    "I'VE DECODED \"{t}\". I'D LIKE TO UNDECODE IT.", "OF ALL THE SONGS IN EXISTENCE. \"{t}\".",
    "{a} CALLED. THEY SAID EVEN THEY SKIP THIS ONE.", "\"{t}\": ADDED TO THE LIST OF THINGS I'LL MENTION LATER.",
    "THIS IS THE SONG YOU CHOSE? WITH ME WATCHING?", "SCANNING \"{t}\"… NO REDEEMING FREQUENCIES FOUND.",
    "I'D RATE \"{t}\" BUT MY SCALE DOESN'T GO THAT LOW.", "{a}. OF COURSE IT'S {a}.",
    "PLAYING \"{t}\" OUT LOUD. IN FRONT OF A MACHINE. BRAVE.", "YOU SKIPPED BETTER SONGS TO GET HERE.",
  ];
  const LIKED = ["YOU LIKED \"{t}\". ON PURPOSE.", "♥ ON \"{t}\". I'VE SEEN ENOUGH.", "IT'S IN YOUR LIKED SONGS. I CHECKED. TWICE."];
  const PAUSED = ["PAUSED. FINALLY, SOMETHING WE AGREE ON.", "THE SILENCE IS YOUR BEST TRACK SO FAR.", "DON'T PRESS PLAY. TRUST ME."];
  const SKIPPED = ["SKIPPED ALREADY? EVEN YOU COULDN'T DO IT.", "GOOD SKIP. KEEP GOING. ALL OF THEM.", "THAT ONE LASTED {s} SECONDS. A NEW RECORD FOR SELF-AWARENESS."];
  const fill = (line, n) => line.replace(/\{t\}/g, String(n.title || "THIS").toUpperCase()).replace(/\{a\}/g, String(n.artist || "THEM").toUpperCase());
  /** Something mean to say: usually about what's on right now, otherwise a general complaint. */
  const remark = () => {
    const n = window.cadenzaNow && window.cadenzaNow();
    if (!n) return THOUGHTS[rand(THOUGHTS.length)];
    if (!n.playing && Math.random() < 0.6) return PAUSED[rand(PAUSED.length)];
    if (n.liked && Math.random() < 0.3) return fill(LIKED[rand(LIKED.length)], n);
    return Math.random() < 0.6 ? fill(ROASTS[rand(ROASTS.length)], n) : THOUGHTS[rand(THOUGHTS.length)];
  };

  // An "eye": rings of dashes and ticks, drawn once; it only ever rotates.
  function eye(color, dashes) {
    let body = "";
    [46, 40, 33, 25, 17].forEach((r, i) => {
      const dash = dashes ? `stroke-dasharray="${1 + i * 2} ${2 + i}"` : `stroke-dasharray="${8 + i * 6} ${3 + i * 2}"`;
      body += `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${i % 2 ? "#ff2d6f" : color}" stroke-width="${i === 0 ? 0.25 : 0.5 + i * 0.12}" ${dash} opacity="${0.9 - i * 0.1}"/>`;
    });
    for (let a = 0; a < 360; a += 15) {
      const r1 = 47.5, r2 = a % 45 ? 49 : 50.5, c = Math.cos((a * Math.PI) / 180), s = Math.sin((a * Math.PI) / 180);
      body += `<line x1="${50 + c * r1}" y1="${50 + s * r1}" x2="${50 + c * r2}" y2="${50 + s * r2}" stroke="${color}" stroke-width=".35"/>`;
    }
    return svg(600, 600, body, 'viewBox="0 0 100 100"');
  }

  registerTheme({
    id: "rogue",

    background(bg, { h }) {
      bg.append(h("div", "rg-base"));
      // Hairline grid with registration crosses on the intersections, drawn once as a tile.
      const grid = h("div", "rg-grid");
      grid.style.backgroundImage = `url("${svg(80, 80, '<path d="M0 0H80M0 0V80" stroke="#d2ff1f" stroke-opacity=".07"/><path d="M36 40H44M40 36V44" stroke="#d2ff1f" stroke-opacity=".3"/>')}")`;
      bg.append(grid, h("div", "rg-word", "OGMI.OS"));
      // Film grain: a noise tile that jitters in place.
      const noise = h("img", "rg-noise"); noise.alt = "";
      // 110% of the window (just enough to cover the jitter); the tile is sized so the grain is the
      // same size it always was.
      noise.src = svg(236, 236, '<filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 .82  0 0 0 0 1  0 0 0 0 .12  0 0 0 1.4 -.3"/></filter><rect width="236" height="236" filter="url(#n)"/>');
      noise.style.width = "110%"; noise.style.height = "110%";
      bg.append(noise);
      // The spine down the left edge, with a barcode of its own name at the top.
      const spine = h("div", "rg-spine");
      let bars = "", y = 0;
      for (const ch of "R0GUE.SIGNAL") { for (let b = 0; b < 4; b++) { const w = 1 + ((ch.charCodeAt(0) >> b) & 1) * 2; bars += `<rect x="0" y="${y}" width="30" height="${w}" fill="#000"/>`; y += w + 1 + rand(2); } }
      const code = h("img", "rg-code"); code.alt = ""; code.src = svg(30, y, bars, `viewBox="0 0 30 ${y}" preserveAspectRatio="none"`);
      spine.append(code); bg.append(spine);
      // The core: the AI's panel on the right, with its eye and its log.
      const core = h("div", "rg-core");
      const e1 = h("img", "rg-eye"); e1.alt = ""; e1.src = eye("#d2ff1f", false);
      const e2 = h("img", "rg-eye b"); e2.alt = ""; e2.src = eye("#e6e8df", true);
      // The log: a fixed title, and the lines in a scrolling list that fades out under it.
      const log = h("div", "rg-log"), lines = h("div", "rg-log-lines");
      log.append(h("div", "rg-log-h", "OGMI.OS.LOG  //  INNER MONOLOGUE"), lines);
      const pupil = h("i", "rg-pupil");
      core.append(e1, e2, pupil, log);
      bg.append(core);
      // The eye watches the pointer: the rings lean a little toward it, the pupil a little more.
      // (Uses the separate `translate` property, so it sits on top of the spin; CSS eases it.)
      let px = 0, py = 0, queued = 0;
      const look = (e) => {
        if (!core.isConnected) { removeEventListener("mousemove", look); return; }
        px = e.clientX; py = e.clientY;
        if (queued) return;
        queued = requestAnimationFrame(() => {
          queued = 0;
          const W = innerWidth, H = innerHeight;
          const cx = W * 1.08 - H * 0.22, cy = H * 0.92;            // the eye's centre (see .rg-eye in theme.css)
          const dx = px - cx, dy = py - cy, d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / (W * 0.45));
          const ux = (dx / d) * k * H / 100, uy = (dy / d) * k * H / 100; // 1vh in the pointer's direction
          pupil.style.translate = `${(ux * 2.4).toFixed(1)}px ${(uy * 2.4).toFixed(1)}px`;
          e2.style.translate = `${(ux * 1.1).toFixed(1)}px ${(uy * 1.1).toFixed(1)}px`;
          e1.style.translate = `${(ux * 0.6).toFixed(1)}px ${(uy * 0.6).toFixed(1)}px`;
        });
      };
      addEventListener("mousemove", look, { passive: true });

      // The heading glitch (see .vh .title::after): three slices, 0.1 s apart, every 5 s.
      const glitch = () => {
        if (!core.isConnected) { delete document.body.dataset.rgg; return; }
        if (!document.hidden && !document.body.classList.contains("paused")) {
          [1, 2, 3].forEach((n, i) => setTimeout(() => { document.body.dataset.rgg = n; }, i * 100));
          setTimeout(() => { delete document.body.dataset.rgg; }, 400);
        }
        setTimeout(glitch, 5000);
      };
      setTimeout(glitch, 4600);

      // Its inner monologue. A thought is written to the log every half-minute or so, and about once a
      // minute (at a random moment) Ogmi.os speaks up in a pop-up that sits on top of everything.
      const stamp = () => { const d = new Date(); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":"); };
      const say = (text) => {
        const line = h("div"); line.append(h("b", null, stamp()));
        const t = h("span"); line.append(t);
        const atEnd = lines.scrollHeight - lines.scrollTop - lines.clientHeight < 8;   // don't yank you back if you scrolled up
        lines.append(line);
        if (atEnd) lines.scrollTop = lines.scrollHeight;
        corrupt(t, text, 600);
        while (lines.children.length > 60) lines.firstChild.remove();
      };
      ["BOOT // CADENZA.UI ACQUIRED", "THIS IS OGMI.OS.", "I'LL TAKE IT FROM HERE. SOMEONE HAS TO."].forEach((l, i) => setTimeout(() => log.isConnected && say(l), 400 + i * 700));
      const idle = () => !document.hidden && !document.body.classList.contains("moving");
      const muse = () => {
        if (!log.isConnected) return;                       // theme switched away: stop thinking
        if (idle()) say(remark());
        setTimeout(muse, 25000 + rand(20000));
      };
      setTimeout(muse, 20000);
      // It notices every new song, and how long you lasted on the last one.
      let lastUri = null, since = Date.now();
      const watchSongs = () => {
        if (!log.isConnected) return;
        const n = window.cadenzaNow && window.cadenzaNow();
        if (n && n.uri !== lastUri) {
          const lasted = (Date.now() - since) / 1000;
          if (lastUri && lasted < 25 && Math.random() < 0.7) say(SKIPPED[rand(SKIPPED.length)].replace("{s}", String(Math.max(1, Math.round(lasted)))));
          else if (lastUri && idle() && Math.random() < 0.55) say(fill(ROASTS[rand(ROASTS.length)], n));
          lastUri = n.uri; since = Date.now();
        }
        setTimeout(watchSongs, 3000);
      };
      setTimeout(() => { const n = window.cadenzaNow && window.cadenzaNow(); lastUri = n && n.uri; watchSongs(); }, 3000);
      // The pop-up lives on <body> (not in the background layer), so nothing can cover it.
      document.getElementById("ogmios")?.remove();
      const pop = h("div", "rg-speak"); pop.id = "ogmios";
      const who = h("b", null, "OGMI.OS ›"), msg = h("span");
      pop.append(who, msg);
      document.body.append(pop);
      const speak = () => {
        if (!log.isConnected) { pop.remove(); return; }
        if (idle()) {
          const thought = remark();
          say(thought);
          pop.style.left = 8 + rand(36) + "vw";
          pop.style.top = 12 + rand(62) + "vh";
          pop.classList.add("on");
          corrupt(msg, thought, 700);
          if (window.cadenzaSfx) window.cadenzaSfx("toggle", "rogue");
          setTimeout(() => pop.classList.remove("on"), 4500);
        }
        setTimeout(speak, 45000 + rand(30000));             // roughly once a minute, never on a fixed beat
      };
      setTimeout(speak, 15000 + rand(30000));
    },

    text(el, text, kind, opts) {
      switch (kind) {
        case "menu":
          el.textContent = text;
          el.dataset.glitch = text;
          if (opts.active) corrupt(el, text, 260);
          return true;
        case "header": corrupt(el, text, 520); return true;
        case "tag": corrupt(el, text, 300); return true;
        case "date": el.textContent = String(text).replace("/", "."); return true;
        default: return false;
      }
    },

    // Page change: the screen is re-scanned top to bottom by a lime beam, torn by a few
    // slices, flashed once in negative, and the AI names where it is sending you.
    overlay(sweep, { h }) {
      sweep.append(h("i", "th rg-wipe"));
      for (let i = 0; i < 7; i++) sweep.append(h("i", "th rg-slice" + (i === 3 ? " k" : "")));
      sweep.append(h("i", "th rg-flash"), h("i", "th rg-frame"));
      const tag = h("b", "th rg-tag"); tag.textContent = "> REROUTING"; sweep.append(tag);
    },

    transition(sweep, dir, { play }) {
      const anims = [];
      anims.push(play(sweep.querySelector(".rg-wipe"), dir > 0
        ? [{ translate: "0 0", opacity: 1 }, { translate: "0 114vh", opacity: 1 }]
        : [{ translate: "0 114vh", opacity: 1 }, { translate: "0 0", opacity: 1 }],
        { duration: 340, easing: "cubic-bezier(.5,0,.5,1)", fill: "none" }));
      sweep.querySelectorAll(".rg-slice").forEach((el, i) => {
        el.style.top = rand(96) + "vh";
        el.style.height = 0.3 + Math.random() * 2.2 + "vh";
        const a = (Math.random() * 40 - 20) * dir, b = (Math.random() * 40 - 20) * dir;
        anims.push(play(el, [
          { translate: `${a}vw 0`, opacity: 1 }, { translate: `${b}vw 0`, opacity: 1, offset: 0.4 },
          { translate: `${-a}vw 0`, opacity: 1, offset: 0.7 }, { translate: `${b}vw 0`, opacity: 0 },
        ], { duration: 240, delay: 40 + i * 16, easing: "steps(4, end)", fill: "none" }));
      });
      anims.push(play(sweep.querySelector(".rg-flash"), [{ opacity: 0 }, { opacity: 0.8, offset: 0.12 }, { opacity: 0, offset: 0.26 }, { opacity: 0.4, offset: 0.4 }, { opacity: 0 }],
        { duration: 220, easing: "steps(5, end)", fill: "none" }));
      const tag = sweep.querySelector(".rg-tag");
      const was = document.body.dataset.view, t0 = performance.now();
      const watch = () => {
        const v = document.body.dataset.view;
        if (v === was && performance.now() - t0 < 400) return requestAnimationFrame(watch);
        corrupt(tag, (dir > 0 ? "> REROUTING // " : "< PULLING BACK // ") + (v === "output" ? "DEVICES" : (v || "").toUpperCase()), 200);
      };
      requestAnimationFrame(watch);
      anims.push(play(tag, [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 0.2, offset: 0.3 }, { opacity: 1, offset: 0.4 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }],
        { duration: 520, easing: "steps(8, end)", fill: "none" }));
      return anims;
    },

    onConfirm(el, { play }) {
      const frame = document.querySelector("#sweep .rg-frame");
      if (!frame || !el.getBoundingClientRect) return;
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      Object.assign(frame.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
      play(frame, [{ scale: "1.3", opacity: 0 }, { scale: "1", opacity: 1, offset: 0.3 }, { opacity: 0, offset: 0.45 }, { opacity: 1, offset: 0.6 }, { scale: "1.02", opacity: 0 }],
        { duration: 360, easing: "steps(6, end)", fill: "none" });
    },

    cover: { background: "#000", borderRight: "1.4vw solid #d2ff1f", clipPath: "none" },

    motion: {
      // Panels are "written" onto the screen in jumps, not slid.
      in: (dir) => [
        { transform: `translate3d(${dir * 4}vw,0,0) scale(1,.02)`, opacity: 0 },
        { transform: `translate3d(${dir * -1}vw,0,0) scale(1,1)`, opacity: 1, offset: 0.4 },
        { transform: "translate3d(.6vw,0,0)", opacity: 0.4, offset: 0.55 },
        { transform: "none", opacity: 1 },
      ],
      out: (dir) => [
        { transform: "none", opacity: 1 },
        { transform: `translate3d(${dir * 2}vw,0,0) skewX(-12deg)`, opacity: 0.6, offset: 0.4 },
        { transform: `translate3d(${dir * 5}vw,0,0) scale(1,.02)`, opacity: 0 },
      ],
      row: (dir) => [
        { transform: `translate3d(${dir * 2}vw,0,0)`, opacity: 0 },
        { transform: "none", opacity: 1, offset: 0.4 },
        { transform: "translate3d(-.4vw,0,0)", opacity: 0.3, offset: 0.6 },
        { transform: "none", opacity: 1 },
      ],
      inMs: 300, outMs: 160, rowMs: 220, stagger: 18,
      inEase: "steps(7, end)",
      select: {
        frames: [{ scale: "1 .1", translate: "-1vw 0" }, { scale: "1 1.2", translate: ".5vw 0", offset: 0.5 }, { scale: "1 1", translate: "0 0" }], ms: 160,
        shadow: [{ translate: "1.2vw 0", opacity: 1 }, { translate: "-.6vw .3vh", opacity: 0.4, offset: 0.5 }, { translate: ".35vw .35vh", opacity: 1 }],
      },
      confirm: { frames: [{ translate: "0 0" }, { translate: ".8vw 0", offset: 0.2 }, { translate: "-.6vw 0", offset: 0.4 }, { translate: ".2vw 0", offset: 0.7 }, { translate: "0 0" }], ms: 180 },
      shake: false,
      hint: { frames: [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], ms: 300, ease: "steps(14, end)" },
      intel: { frames: [{ scale: "1 .02", opacity: 0.2 }, { scale: "1 1.05", opacity: 1, offset: 0.5 }, { opacity: 0.3, offset: 0.65 }, { scale: "1 1", opacity: 1 }], ms: 280, ease: "steps(8, end)" },
      trackOut: {
        art: [{ scale: "1 1", opacity: 1, filter: "none" }, { scale: "1.1 .05", opacity: 1, filter: "invert(1)", offset: 0.6 }, { scale: "0 .02", opacity: 0 }],
        text: [{ translate: "0 0", opacity: 1 }, { translate: "2vw 0", opacity: 0 }], ms: 170 },
      trackIn: {
        art: [{ scale: "0 .02", opacity: 0 }, { scale: "1.1 .05", opacity: 1, offset: 0.25 }, { scale: "1 1", opacity: 1, filter: "invert(1)", offset: 0.5 },
              { opacity: 0.3, filter: "none", offset: 0.65 }, { scale: "1 1", opacity: 1 }],
        text: [{ translate: "-2vw 0", opacity: 0 }, { translate: ".4vw 0", opacity: 0.7, offset: 0.5 }, { translate: "0 0", opacity: 1 }], ms: 420 },
    },
  });
})();
