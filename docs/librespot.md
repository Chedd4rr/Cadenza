# The built-in librespot

Cadenza plays the sound through [librespot](https://github.com/librespot-org/librespot), an open-source
Spotify Connect client. `librespot.sh` (run by `build.sh`) builds it from source and puts it inside
Cadenza.app, so there's nothing else to install.

- **Version:** pinned to one commit of librespot's dev branch (7 Nov 2026), which has fixes for changes
  Spotify made in late 2026 that aren't in a release yet. If that commit is ever gone, it builds release
  0.8.0. Both are fetched by exact commit, and `cargo build --locked` uses the dependency versions in
  librespot's `Cargo.lock`, so a build can't silently pick up different code.
- **Patches** in `patches/`, each explained at its top:
  - `librespot-skip-refused.patch`: when Spotify refuses a song's key (`error audio key 0 2`), skip the
    song straight away instead of downloading it anyway, failing to read it and deleting a good cached
    copy. (Cadenza used to ask for a refused key up to 3 times first; that only kept Spotify refusing.)

  Changing a patch's code (not its description) makes the next build rebuild librespot.
- **Build:** for your Mac's chip, pipe output only (Cadenza plays the sound through its own engine, for
  the EQ, crossfade and visualizer), without debug symbols: about 7–10 MB.
- **Where:** the source and the finished program live in `~/Library/Developer/Cadenza/librespot`, never
  in this repository, and later builds reuse them. If a build fails, the last one that worked is used.
- **No Rust?** The app is built without it and uses a Homebrew librespot (`brew install librespot`). Set
  `CADENZA_SKIP_LIBRESPOT=1` to skip it on purpose.

To use a different librespot, set System → Engine settings → Librespot path. Cadenza uses that first,
then its own copy, then a Homebrew one.

## The built-in engine (Windows, Linux and the Tauri Mac app)

The Tauri app normally runs librespot inside itself instead of as a separate program. `desktop/librespot.sh`
gets the same pinned commit ready with the same patches in `desktop/librespot-src/` (never in git), and
Cadenza is built with it (`desktop/Cargo.toml` points there). It's set up the way Cadenza used to start the
program: the same device name and the same device ID, so Spotify and your phone see the same "Cadenza"
speaker; the same login file; the same volume curve, quality and even-loudness settings. Spotify Connect stays
on, so your phone can still see and control it.

What changes is the plumbing: the sound goes straight into Cadenza's sound engine through memory instead of a
pipe, and librespot's events and messages are handed over directly instead of through a script and a file
(`desktop/src/embedded.rs`). The next steps use it to play, skip and queue songs directly, without going through
Spotify's web interface and back.

The separate program is still built and bundled for now. System → Engine settings → Engine switches between
the two (it restarts the engine).
