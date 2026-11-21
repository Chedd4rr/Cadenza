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
  - `librespot-hold-refused.patch`: lets an app make librespot pause on a song it can't play instead of
    skipping to the next one (and the next, while Spotify keeps refusing). Only the built-in engine turns
    it on: it then waits a moment, longer each time it happens again soon, and moves on itself.

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
(`desktop/src/embedded.rs`).

Cadenza also plays, pauses, skips, seeks, queues and changes the volume, shuffle and repeat straight in the
engine instead of through Spotify's web interface (`Direct` in app.js, `direct` in librespot.rs). That works
at once and isn't bound by the web interface's rules, such as refusing plain lists of songs. Anything the
engine can't do itself, such as controlling your phone while it's the one playing, still goes through the web
interface. Two more things only work this way:

- **Fast skipping:** the first press skips at once; presses that follow quickly are gathered into one jump,
  so skipping through ten songs loads two of them, not ten (each one loaded asks Spotify for its key, and
  asked too often, Spotify starts refusing).
- **Refused songs:** the engine pauses on a song Spotify won't play (see the hold-refused patch) and Cadenza
  moves on after 1.5 s, then 3, 6, 12, 20 and 30 s if it keeps happening, instead of librespot asking for
  one key after another while Spotify only refuses more. Next pressed during the wait is counted and done
  when it ends (one jump); Play goes on straight away. A song that loads resets the waits.

Media keys, the tray, the mini player and the pause after the computer sleeps go straight to the engine too.

The separate program is still built and bundled for now. System → Engine settings → Engine switches between
the two (it restarts the engine).
