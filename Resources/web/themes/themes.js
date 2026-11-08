// Themes available in Cadenza, in the order ⌘T cycles through them.
//
// To add a theme:
//   1. Copy an existing folder, e.g. themes/tide → themes/mytheme
//   2. Edit themes/mytheme/theme.css (colours, shapes) and theme.js (background, motion, text)
//   3. Add a line below.   See themes/README.md for the full list of hooks.
window.THEMES = [
  { id: "tide", name: "TIDE · BLUE" },
  { id: "heist", name: "HEIST · RED" },
  { id: "neon", name: "NEON · CITY" },
  { id: "min", name: "STUDIO · MINIMAL" },
  // Never in the ⌘T cycle or the theme lists: only reachable through a secret in the ⌘K palette.
  { id: "rogue", name: "OGMI.OS · SIGNAL", hidden: true },
];
