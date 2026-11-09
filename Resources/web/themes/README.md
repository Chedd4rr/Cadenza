# Making a theme

A theme is a folder here with two files, plus a line in `themes.js`:

```
themes/
  themes.js          ← list of themes (order = ⌘T order)
  tide/theme.css     ← TIDE · BLUE (the base styles are this palette)
  tide/theme.js
  heist/theme.css    ← HEIST · RED
  heist/theme.js
  heist/fonts/…      ← extra fonts a theme needs
  neon/theme.css     ← NEON · CITY (rebuilds the layout too: see below)
  neon/theme.js
  min/…             ← STUDIO · MINIMAL (a desktop-app layout: bento Home, transport bar docked at the bottom)
  chroma/…          ← CHROMA · COVER (colours taken from the playing song's cover: see onArt below)
  rogue/…           ← the secret one, OGMI.OS (hidden: true in themes.js): spine + workspace + AI core panel
```

To start, copy `heist` (it uses every hook) or `tide` (the minimum),
rename the folder, change `id` in `theme.js`, and add it to `themes.js`:

```js
window.THEMES = [
  { id: "tide", name: "TIDE · BLUE" },
  { id: "heist", name: "HEIST · RED" },
  { id: "mytheme", name: "MY THEME" },
];
```

Then rebuild (`bash build.sh --install`), or preview it in a browser by opening
`index.html?theme=mytheme`.

## theme.css

`theme.css` is loaded after the shared `styles.css`, so any rule you write overrides it.
Most of the look comes from these variables:

| Variable | Used for |
|---|---|
| `--navy`, `--navy-rgb` | darkest colour: panels, row backgrounds, shadows |
| `--deep`, `--deep-rgb` | text on light highlights |
| `--cyan`, `--cyan-rgb` | accent: offsets, tags, active borders |
| `--blue` | secondary accent text on light highlights |
| `--ice`, `--ice-rgb` | soft light text |
| `--white`, `--white-rgb` | highlights and main text |
| `--placeholder` | album art background before it loads |
| `--drawer-bg` | background of the add-to-playlist panel |
| `--liked-bg` | Liked Songs cover |
| `--skew` | slant used everywhere |
| `--tone-dark`, `--tone-mid`, `--tone-light` | "album covers in the theme's colours": a cover's shadows, middle and highlights (rgb numbers). They default to `--navy-rgb`, `--cyan-rgb` and `--white-rgb`; set them if your theme's dark, accent and light colours live elsewhere (a light theme, say) |
| `--display`, `--text` | heading font and body font |

The `-rgb` versions are space-separated numbers (e.g. `3 12 46`), used for see-through
versions of the colour. Set both when you change one.

The elements themes usually restyle are `#hl .face` / `#hl .shadow` (home highlight), `.item .label`,
`.card`, `.trk`, `.dev`, `.opt`, `#now …`, `#sweep .a/.b/.c` (transition bands),
`.key`, `#toast`, `#hint` and `.notice`.

Two rules for every theme:

- Animate only `transform` and `opacity`. Animating `left`, `width` and the like makes
  transitions stutter.
- Elements may have their own resting `transform` (tilts, skews). The app adds its
  movement on top, so nothing snaps at the end of a transition.

## theme.js

```js
registerTheme({
  id: "mytheme",

  // Build background layers inside #bg (it's emptied first).
  // `h(tag, className, text)` makes an element.
  background(bg, { h }) {
    bg.append(h("div", "my-gradient"));
  },

  // Optional: draw some text your own way.
  //   kind: "menu" (home items; opts.active is true for the selected one),
  //         "header" (view titles), "date" (clock), "tag" (small labels)
  // Fill `el` yourself, or return false to use plain text.
  text(el, text, kind, opts) {
    return false;
  },

  // Optional: how things move. Each function returns [from, to] keyframes.
  // Use transform + opacity only; `dir` is 1 going forward, -1 going back.
  motion: {
    in:  (dir) => [{ transform: `translate3d(${dir * 30}vw,0,0)`, opacity: 0 }, { transform: "none", opacity: 1 }],
    out: (dir) => [{ transform: "none", opacity: 1 }, { transform: `translate3d(${-dir * 30}vw,0,0)`, opacity: 0 }],
    row: (dir) => [{ transform: `translate3d(${dir * 20}vw,0,0)`, opacity: 0 }, { transform: "none", opacity: 1 }],
    inMs: 300, outMs: 190, rowMs: 280, stagger: 24,
    inEase: "cubic-bezier(.3,1.35,.5,1)",
  },
});
```

### Theme-specific animations

These are all optional; any you leave out fall back to the blue theme's version. `heist/theme.js`
uses every one of them, so it's the one to copy from.

```js
  // Pieces for your menu-change transition, added to #sweep (the top layer).
  // Tip: use <img> with an SVG data URL for big shapes; scaling an image is nearly free,
  // while scaling a clip-path shape gets redrawn every frame.
  overlay(sweep, { h }) { … },

  // Plays on every menu change. dir is 1 going forward, -1 going back. Return the animations.
  transition(sweep, dir, { play }) { return [ play(el, keyframes, options), … ]; },

  // Called when you confirm something (Enter / click): e.g. a ripple at the element.
  onConfirm(el, { play }) { … },

  // How the full-screen cover looks when switching *to* this theme.
  cover: { background: "#000", borderRight: "3vw solid red", clipPath: "none" },

  motion: {
    …in / out / row as above…
    // Small moments. Use the translate / rotate / scale properties (not `transform`),
    // so they stack on top of an element's resting tilt.
    select:  { frames: [...], ms: 240, shadow: [...] },  // home highlight lands (shadow optional)
    confirm: { frames: [...], ms: 260 },                 // Enter / click on anything
    shake: true,                                         // shake the screen on confirm
    hint:    { frames: [...], ms: 260, ease: "…" },     // home hint text changes
    trackOut: { art: [...], text: [...], ms: 170 },     // now playing: old track leaves
    trackIn:  { art: [...], text: [...], ms: 340 },     // new track arrives
  },
```

CSS-only motion (toast pop, drawer slide, the now-playing panel docking into the corner,
the home cursor) can be restyled in `theme.css`. See the end of `heist/theme.css`.

## Changing the layout

A theme can move things around as well as recolour them. `neon` (NEON · CITY) moves the now-playing panel into a
wide deck with a grid, turns the menu into a framed column, makes every page a full-width
window, and folds the now-playing panel into a strip at the top on other pages
(`body:not([data-view="home"]) #now …`). Every theme shares the same HTML, so the features all
keep working whatever the CSS does with the layout.

## Hidden themes and sounds

A theme marked `hidden: true` in `themes.js` stays out of ⌘T, System and the palette's theme list;
something else has to switch to it (the secret one is unlocked in `Palette.filter` in `app.js`).

Click sounds live in `Sfx` in `app.js`, one set per theme id: `confirm`, `back`, `page`, `toggle`,
`stage` and `theme` (played when you switch *to* that theme). They're synthesised with WebAudio,
so a theme needs no sound files.

### Following the album cover

Two optional hooks let a theme react to the music (`chroma/theme.js` uses both):

```js
  // Called with the playing song's cover URL whenever it changes (null when nothing plays), and once
  // when the theme is switched on. dataURL(url) gives the cover as a data: URL you can draw on a canvas
  // to read its pixels; call recolored() after changing colour variables, so the visualiser and the
  // themed covers pick them up.
  async onArt(url, { dataURL, recolored }) { … },

  // Called when switching away: undo anything set outside your stylesheet (inline colour variables).
  leave() { … },
```

### Grid homes

To lay the Home menu out as tiles, add `homeCols: 4` to the theme's definition. The arrow keys
then move in two dimensions. The `text(el, text, "menu", opts)` hook also gets `opts.id` and `opts.hint`,
so a tile can show its own icon and description (see `min/theme.js`).
