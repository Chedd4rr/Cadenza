# The built-in librespot

Cadenza plays the sound through [librespot](https://github.com/librespot-org/librespot), an open-source
Spotify Connect client. `librespot.sh` (run by `build.sh`) builds it from source and puts it inside
Cadenza.app, so there's nothing else to install.

- **Version:** pinned to one commit of librespot's dev branch (7 Nov 2026), which has fixes for changes
  Spotify made in late 2026 that aren't in a release yet. If that commit is ever gone, it builds release
  0.8.0. Both are fetched by exact commit, and `cargo build --locked` uses the dependency versions in
  librespot's `Cargo.lock`, so a build can't silently pick up different code.
- **Patches** in `patches/`, each explained at its top:
  - `librespot-retry-keys.patch`: when Spotify refuses a song's key with its "try again" code
    (`error audio key 0 2`), ask again up to 3 times instead of skipping the song (from
    [pull request #1763](https://github.com/librespot-org/librespot/pull/1763), not merged yet).
  - `librespot-skip-refused.patch`: when it still refuses, skip the song straight away instead of
    downloading it anyway, failing to read it and deleting a good cached copy.

  Changing a patch's code (not its description) makes the next build rebuild librespot.
- **Build:** for your Mac's chip, pipe output only (Cadenza plays the sound through its own engine, for
  the EQ, crossfade and visualizer), without debug symbols: about 7–10 MB.
- **Where:** the source and the finished program live in `~/Library/Developer/Cadenza/librespot`, never
  in this repository, and later builds reuse them. If a build fails, the last one that worked is used.
- **No Rust?** The app is built without it and uses a Homebrew librespot (`brew install librespot`). Set
  `CADENZA_SKIP_LIBRESPOT=1` to skip it on purpose.

To use a different librespot, set System → Engine settings → Librespot path. Cadenza uses that first,
then its own copy, then a Homebrew one.
