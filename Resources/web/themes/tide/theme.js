// TIDE · BLUE: deep water, slanted light and rising bubbles.
registerTheme({
  id: "tide",

  // Build the background layers inside #bg. Called every time this theme is switched on.
  background(bg, { h }) {
    bg.append(h("div", "base"));

    // Water texture: rendered once as an image, then it only drifts (cheap for the GPU).
    const layer = (id, freq, seed, op) =>
      '<filter id="' + id + '" x="0" y="0" width="100%" height="100%">' +
      '<feTurbulence type="turbulence" baseFrequency="' + freq + '" numOctaves="2" seed="' + seed + '"/>' +
      '<feColorMatrix type="matrix" values="0 0 0 0 0.75  0 0 0 0 0.95  0 0 0 0 1  0 0 0 -22 3.2"/></filter>' +
      '<rect width="100%" height="100%" filter="url(#' + id + ')" opacity="' + op + '"/>';
    const water = h("img", "water");
    water.alt = "";
    water.src = "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="640">' +
      layer("a", "0.011 0.032", 4, 0.14) + layer("b", "0.017 0.046", 11, 0.08) + "</svg>");
    bg.append(water);

    bg.append(h("div", "slab b"), h("div", "slab c"), h("div", "slab a"), h("div", "ghost", "MUSIC"));

    for (let i = 0; i < 10; i++) {
      const b = h("div", "bubble");
      const s = 0.4 + Math.random() * 1.4;
      b.style.width = b.style.height = s + "vw";
      b.style.left = Math.random() * 100 + "vw";
      b.style.animationDuration = 10 + Math.random() * 12 + "s";
      b.style.animationDelay = -Math.random() * 20 + "s";
      bg.append(b);
    }
  },

  // Look of the full-screen cover when switching *to* this theme.
  cover: { background: "#030c2e", borderRight: "3vw solid #3fe0ff", clipPath: "none" },

  // Transition pieces: a ripple that spreads from the centre, and a small ripple for taps.
  overlay(sweep, { h }) {
    const rings = (n, w) => Array.from({ length: n }, (_, i) =>
      `<circle cx="50" cy="50" r="${48 - i * (40 / n)}" fill="none" stroke="${i % 2 ? "#f4fdff" : "#3fe0ff"}" stroke-width="${w - i * 0.3}" opacity="${1 - i * 0.18}"/>`).join("");
    const img = (cls, svg) => {
      const el = h("img", "th " + cls);
      el.alt = "";
      el.src = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="512" height="512">' + svg + "</svg>");
      return el;
    };
    sweep.append(img("p3-ripple", rings(4, 1.6)), img("p3-tap", rings(2, 3)));
  },

  // Menu change: cool light bands sweep across while a ripple spreads out like a drop in water.
  transition(sweep, dir, { play }) {
    const from = dir > 0 ? "-60vw" : "160vw", to = dir > 0 ? "160vw" : "-60vw";
    const anims = [...sweep.querySelectorAll(".a, .b, .c")].map((el, i) => play(el,
      [{ transform: `translate3d(${from},0,0) skewX(-20deg)` }, { transform: `translate3d(${to},0,0) skewX(-20deg)` }],
      { duration: 460, delay: i * 45, easing: "cubic-bezier(.55,.05,.35,1)", fill: "none" }));
    anims.push(play(sweep.querySelector(".p3-ripple"),
      [{ scale: ".2", opacity: 0.9 }, { scale: "2.8", opacity: 0 }],
      { duration: 620, delay: 60, easing: "cubic-bezier(.15,.7,.3,1)", fill: "none" }));
    return anims;
  },

  // A small ripple wherever you confirm something.
  onConfirm(el, { play }) {
    const tap = document.querySelector("#sweep .p3-tap");
    if (!tap || !el) return;
    const r = el.getBoundingClientRect();
    tap.style.left = r.left + Math.min(r.width, innerWidth * 0.12) + "px";
    tap.style.top = r.top + r.height / 2 + "px";
    play(tap, [{ scale: ".1", opacity: 1 }, { scale: "1", opacity: 0 }], { duration: 480, easing: "cubic-bezier(.15,.7,.3,1)", fill: "none" });
  },

  // Small moments: everything floats and settles like it's in water.
  motion: {
    select: {                                   // highlight stretches in from the left, shadow catches up
      frames: [{ scale: "1.16 1", translate: "-1.4vw 0" }, { scale: "1 1", translate: "0 0" }], ms: 280,
      shadow: [{ translate: "2.6vh 2vh" }, { translate: "1vh 1vh" }],
    },
    confirm: { frames: [{ translate: "1.4vw -.6vh", scale: "1.06" }, { translate: "0 0", scale: "1" }], ms: 280 },
    hint: { frames: [{ translate: "-3vw 0", scale: "1 .4", opacity: 0 }, { translate: "0 0", scale: "1 1", opacity: 1 }], ms: 260, ease: "cubic-bezier(.3,1.4,.5,1)" },
    // info card washes in from the right like a wave
    intel: { frames: [{ translate: "4vw 0", scale: ".92 1", opacity: 0 }, { translate: "0 0", scale: "1 1", opacity: 1 }], ms: 300, ease: "cubic-bezier(.3,1.3,.5,1)" },
    trackOut: {                                 // old cover sinks, new one floats up
      art: [{ translate: "0 0", rotate: "0deg", opacity: 1 }, { translate: "1vw 10vh", rotate: "7deg", opacity: 0 }],
      text: [{ translate: "0 0", opacity: 1 }, { translate: "3vw 0", opacity: 0 }], ms: 190 },
    trackIn: {
      art: [{ translate: "-1vw -12vh", rotate: "-9deg", opacity: 0 }, { translate: "0 0", rotate: "0deg", opacity: 1 }],
      text: [{ translate: "-4vw 0", opacity: 0 }, { translate: "0 0", opacity: 1 }], ms: 400 },
  },
});
