# Cadenza: the app

This folder is Cadenza, built on [Tauri](https://tauri.app): one codebase for macOS, Windows and Linux.
The interface is a web page (`Resources/web`); the native side is written in Rust.

Windows was built, played and tried in a Windows 11 VM: the tray, media keys, mini player, links and
installer all work. Still to do: one check on a real Windows PC (a VM without graphics acceleration makes
animations and sound stutter, which could hide a real problem). After that comes signed releases and
updates.

## What works so far

- The whole interface, every page and theme.
- Signing in to Spotify, browsing, searching, playing, pause and skip, the queue, autoplay.
- librespot built into the app (see [docs/librespot.md](../docs/librespot.md)), played directly: play,
  pause, skip, seek and the queue go straight to it, not through Spotify's web interface. One queue,
  Cadenza's (Up Next, then the shuffle, list, DJ set or autoplay's picks), handed to the engine a few songs
  ahead; fast skips gathered into one jump; a short, growing wait after a song Spotify won't unlock.
- Cadenza's own sound engine: the 10-band EQ with presets and preamp, a peak limiter so boosting never clips, the crossfade between songs,
  pause, play, skip and seek that respond at once, the sleep timer's fade, and the visualizer and EQ meters.
- Picking the output (on Linux, the sound server's outputs; picking one makes it the system's output), with
  an EQ kept for each device. If the output stalls it's reopened, and if it can't keep up (a slow computer
  or a virtual machine) its buffer grows by itself.
- Recovery: songs Spotify won't unlock are left out of autoplay for a while, songs that failed to load on a
  hiccup get one more try, a dropped connection restarts the engine and picks up the same song at the same
  second, and Cadenza checks Spotify still lists it after the computer wakes.
- Last.fm (Stats, play counts, the DJ, Friends, similar songs), lyrics from LRCLIB, finding a song by its
  lyrics with Genius, and offline lyrics translation (the language models download the first time).
- Importing your Spotify history (pick the .zip Spotify sends, or the .json files), and Cadenza's own
  listening history for Stats.
- Playlist covers from a picture you pick.
- Media keys and the system's Now Playing (MPRIS on Linux, the media overlay on Windows, Control Center
  on a Mac), with the song, cover and position.
- A tray icon showing the album cover, with play/pause, skip, Show Cadenza, the mini player and Quit.
  Closing the window keeps the music going while the tray icon is there; Quit (or Ctrl+Q) ends it.
  On GNOME, tray icons need the "AppIndicator" extension (Ubuntu has it already).
- The mini player: a little player in a small window that stays on top. Drag it anywhere; it remembers where. Open it from the tray, ⌘K, or `cadenza://mini`; Esc hides it.
- A notification when the song changes while Cadenza isn't in front.
- The global shortcut: Ctrl+Alt+P shows or hides Cadenza from anywhere (on Linux, under X11; Wayland
  doesn't let apps have global shortcuts).
- Start at login, and Discord's "Listening to" status.
- `cadenza://` links for launchers and scripts (`xdg-open cadenza://next`), and only one Cadenza at a time:
  opening it again brings back the one that's running.
- Settings, the taste profile and the saved page data, in private files.
- Ctrl does what ⌘ does on the Mac, and the shortcut hints on screen say Ctrl, Alt and Shift.
- Shortcuts you can change: on the keyboard page (⌘/ or Ctrl+/), select one and press E (or click its
  keys), then press the new ones. Esc cancels, ⌫ removes it, and one row puts them all back. The Mac's
  menu bar and the show/hide shortcut follow your changes. Keys inside pages (P, T, X…) stay as they are.
- Reduce motion (System → Preferences): follows the system's setting, or on or off. While it's on, slides,
  fades and moving backgrounds are still, in the mini player too.
- After 3 minutes with nothing playing, the sound output rests (so it doesn't keep your speakers or
  Bluetooth headphones busy playing silence), and comes back the moment music does.
- Security: a strict content policy for the page (no outside scripts, no eval), and only the window
  permission the mini player needs.

### On Windows

- An installer (`Cadenza_1.0.0_x64-setup.exe`) that installs for you alone, so it doesn't ask for an
  administrator.

### On a Mac

`./build.sh --install` (here or in the project folder) builds Cadenza.app, signs it with your "Cadenza
Local Signing" certificate, and puts it in /Applications in place of the old copy.

- The window's page reaches the top, with the traffic lights over it.
- A menu bar: Cadenza, Edit, Controls (with the same shortcuts as the keyboard page) and Window.
- Outputs come from Core Audio, and picking one switches the Mac's output. Each device's EQ is saved under
  its Core Audio id.
- The window opens where you left it (on every system).
- Closing the lid pauses the music, so it doesn't start again by itself when the computer wakes (on every
  system; it's noticed as the computer wakes rather than as it sleeps).

## Not yet

| Comes in | What |
| --- | --- |
| Before release | Windows: one check on a real PC (smooth animations, clean sound, the installer) |
| Releases | Signed installers and automatic updates (`../release.sh` already collects installers and checksums for a GitHub release) |
| Later | Maybe Spotify's own Soloist as an optional engine (no EQ or crossfade, downloaded by each user) |

## Building it

You need [Rust](https://rustup.rs). On Windows, also the Visual Studio Build Tools ("Desktop development with C++") and Git for Windows (run the commands in Git Bash), and on ARM Windows LLVM (`winget install LLVM.LLVM`). On Linux, also these libraries (Ubuntu and Debian names):

```
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libasound2-dev libssl-dev libxdo-dev
```

Fedora: `webkit2gtk4.1-devel gtk3-devel librsvg2-devel libappindicator-gtk3-devel alsa-lib-devel openssl-devel libxdo-devel`.

Then, from this folder:

```
./build.sh --run    # build and open it
./build.sh --test   # the same, in test mode (below)
./build.sh          # build the installers (.deb and .AppImage, or the Windows setup .exe)
```

The first build takes a while: it fetches librespot's source (`librespot.sh`, into `librespot-src/`) and
compiles it into the app. Later builds reuse both.
On Windows, run these in Git Bash.

To see what it's doing, start it with `CADENZA_LOG=1` set: it then prints the engine log, every bridge
call, every Spotify request with its answer, and a sound report every few seconds. `cargo test` runs the
tests (the EQ curves, the limiter, the visualizer levels, the history import, the history log, translation
models, Last.fm signing, covers).

## Test mode: running a second copy

`./build.sh --test` runs this app beside your normal Cadenza without the two getting in each other's way:

- It has its own folder ("Cadenza Test" next to the normal one; on Linux `~/.local/share/cadenza-test`).
  The first time, it copies your sign-ins, settings, taste profile, history and saved page data into it.
  It only ever reads your real folder, that once, and never writes to it.
- Its speaker is called "Cadenza (test)", so Spotify lists the two apps separately.

To compare two builds, open both, play a song, and move it between "Cadenza" and "Cadenza (test)" on the
Devices page (or from your phone): Spotify carries on at the same spot. Delete the test folder to start
the test copy over from your current data.

## Where it keeps your data

| System | Folder |
| --- | --- |
| Linux | `~/.local/share/cadenza` |
| Windows | `%APPDATA%\Cadenza` |
| macOS | `~/Library/Application Support/Cadenza` |

See the main README's "Your data" for what's in them. Only your account can read them.

## How it fits together

| File | What it does |
| --- | --- |
| `src/main.rs` | Opens the window, connects the page, serves `cadenza-files://` |
| `src/bridge.rs` | Answers the page's `native(cmd, args)` calls |
| `src/auth.rs` | Spotify sign-in |
| `src/api.rs` | Spotify Web API, with the rate-limit guard |
| `src/librespot.rs` | Runs the engine, plays in it directly, reads what it's playing, recovers |
| `src/embedded.rs` | librespot running inside Cadenza: login, sound out, events, Spotify Connect |
| `src/sound.rs` | The sound engine: reading librespot, the crossfade, pause and skip, outputs |
| `src/macaudio.rs` | The Mac's outputs, from Core Audio |
| `src/menu.rs` | The Mac's menu bar |
| `src/dsp.rs` | The EQ, limiter, fades and visualizer levels, sample by sample |
| `src/lastfm.rs` | Last.fm, lyrics (LRCLIB) and Genius |
| `src/history.rs`, `src/spotify_history.rs` | Cadenza's own history; the Spotify history import |
| `src/translation.rs` | Downloads and checks translation models |
| `src/cover.rs` | Playlist cover pictures |
| `src/system.rs` | Media keys and Now Playing, the tray, the mini player, notifications, links, the window resting |
| `src/discord.rs` | Discord's "Listening to" status |
| `src/settings.rs`, `src/store.rs`, `src/files.rs` | Settings, page data, private files |
| `librespot.sh` | Gets librespot's pinned source with Cadenza's patches ready in `librespot-src/` |

The page finds the app through `window.cadenzaNative`, and sends everything it needs through it.
