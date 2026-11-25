# The built-in librespot

Cadenza plays the sound through [librespot](https://github.com/librespot-org/librespot), an open-source
Spotify Connect client, built into the app, so there's nothing else to install. Its license ships with the
app.

- **Version:** pinned to one commit of librespot's dev branch (7 Nov 2026), which has fixes for changes
  Spotify made in late 2026 that aren't in a release yet. If that commit is ever gone, it uses release
  0.8.0. Both are fetched by exact commit.
- **Patches** in `patches/`, each explained at its top:
  - `librespot-skip-refused.patch`: when Spotify refuses a song's key (`error audio key 0 2`), skip the
    song straight away instead of downloading it anyway, failing to read it and deleting a good cached
    copy. (Cadenza used to ask for a refused key up to 3 times first; that only kept Spotify refusing.)
  - `librespot-hold-refused.patch`: lets an app make librespot pause on a song it can't play instead of
    skipping to the next one (and the next, while Spotify keeps refusing). Cadenza turns it on: it then
    waits a moment, longer each time it happens again soon, and moves on itself.
  - `librespot-report-path.patch`: two log lines per song, "Cadenza: file <song> OGG_VORBIS_320" and
    "Cadenza: playing <song> loudness -2.4 dB", so the signal path panel can say which file Spotify sent and
    what the loudness setting does to the song. Nothing about how the music plays changes.

  Changing a patch's code (not its description) makes the next build get the source ready again.
- **No speaker code of its own:** Cadenza plays the sound through its own engine, for the EQ, crossfade and
  visualizer.

## How it runs

`desktop/librespot.sh` (run by `build.sh`) gets the pinned commit ready with the patches in
`desktop/librespot-src/` (never in git), and Cadenza is built with it (`desktop/Cargo.toml` points there).
Its git copy lives in a cache folder outside the project (`~/Library/Developer/Cadenza/librespot` on a Mac,
`~/.cache/cadenza-build/librespot` on Linux, `%LOCALAPPDATA%\cadenza-build\librespot` on Windows). It's set
up the way Cadenza used to start librespot as a program: the same device name and the same device ID, so Spotify and your phone see the same "Cadenza"
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

**One queue, Cadenza's (`Lineup` in app.js).** With the built-in engine, everything that decides what plays
next shares one line-up: your Up Next songs first, then the rest of what's playing (a true-shuffle order, a DJ
set, a list of songs, autoplay's picks). Cadenza hands the next six to the engine's own queue and tops it up as
songs play, so songs follow each other with no gap, the crossfade works, and fast skipping finds songs
waiting. The engine's queue can be cleared, unlike Spotify's, so moving or removing a song puts it right
straight away, and a new list never inherits songs left over from the last one. If skipping still outruns it,
Cadenza plays the line-up's next song itself. Repeat on a list goes round the line-up again; Previous steps
back through it. A whole playlist or album started as itself is played by the engine, with Up Next ahead of it.


The separate program is still built and bundled for now. System → Engine settings → Engine switches between
the two (it restarts the engine).
