# Cadenza for Windows and Linux

This folder is Cadenza rebuilt on [Tauri](https://tauri.app), so it runs on Windows and Linux (and macOS)
from one codebase. The interface is the same page as the Mac app (`Resources/web`), unchanged; only the
native side is new, written in Rust. The Mac app in `Sources/` keeps working as before until this one
does everything it does.

**Phases 0–4 of the [porting plan](https://claude.ai/artifact/MBPyXBUTmd1eJUxE4k9y6j) are done:** the
window and the bridge to the page, Spotify sign-in and playback, everything the pages read and save,
Cadenza's own sound engine, and the parts outside the window (media keys, tray, mini player and the rest).
Next is Windows itself: the installer and testing there.

## What works so far

- The whole interface, every page and theme.
- Signing in to Spotify, browsing, searching, playing, pause and skip, the queue, autoplay.
- librespot (the same version and patches as the Mac app) playing through Cadenza's own sound engine: the
  10-band EQ with presets and preamp, a peak limiter so boosting never clips, the crossfade between songs,
  pause, play, skip and seek that respond at once, the sleep timer's fade, and the visualizer and EQ meters.
- Picking the output (on Linux, the sound server's outputs; picking one makes it the system's output), with
  an EQ kept for each device. If the output stalls it's reopened, and if it can't keep up (a slow computer
  or a virtual machine) its buffer grows by itself.
- Recovery like the Mac app's: songs Spotify won't unlock are skipped and left out of autoplay for a while,
  songs that failed to load on a hiccup get one more try, a dropped connection restarts librespot and picks
  up the same song at the same second, and Cadenza checks Spotify still lists it after the computer wakes.
- Last.fm (Stats, play counts, the DJ, Friends, similar songs), lyrics from LRCLIB, finding a song by its
  lyrics with Genius, and offline lyrics translation (the language models download the first time).
- Importing your Spotify history (pick the .zip Spotify sends, or the .json files), and Cadenza's own
  listening history for Stats. Both use the same files as the Mac app.
- Playlist covers from a picture you pick.
- Media keys and the system's Now Playing (MPRIS on Linux, the media overlay on Windows, Control Center
  on a Mac), with the song, cover and position.
- A tray icon showing the album cover, with play/pause, skip, Show Cadenza, the mini player and Quit.
  Closing the window keeps the music going while the tray icon is there; Quit (or Ctrl+Q) ends it.
  On GNOME, tray icons need the "AppIndicator" extension (Ubuntu has it already).
- The mini player: the same little player as the Mac app's menu-bar one, in a small window that stays on
  top. Drag it anywhere; it remembers where. Open it from the tray, ⌘K, or `cadenza://mini`; Esc hides it.
- A notification when the song changes while Cadenza isn't in front.
- The global shortcut: Ctrl+Alt+P shows or hides Cadenza from anywhere (on Linux, under X11; Wayland
  doesn't let apps have global shortcuts).
- Start at login, and Discord's "Listening to" status.
- `cadenza://` links for launchers and scripts (`xdg-open cadenza://next`), and only one Cadenza at a time:
  opening it again brings back the one that's running.
- Settings, the taste profile and the saved page data, in private files.
- Ctrl does what ⌘ does on the Mac, and the shortcut hints on screen say Ctrl, Alt and Shift.

## Not yet

| Comes in | What |
| --- | --- |
| Phase 5 | Windows: player events from librespot, the installer, testing |
| Phase 6 | macOS build at parity, moving your Mac settings over |
| Phase 7 | Signed releases and automatic updates |
| Later | Spotify's own Soloist as a second engine you can pick, beside librespot |

## Building it

You need [Rust](https://rustup.rs). On Linux, also these libraries (Ubuntu and Debian names):

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

The first build takes a while: it builds librespot (a few minutes) and then the app. Later builds reuse both.
On Windows, run these in Git Bash.

To see what it's doing, start it with `CADENZA_LOG=1` set: it then prints the engine log, every bridge
call, every Spotify request with its answer, and a sound report every few seconds. `cargo test` runs the
tests (the EQ curves, the limiter, the visualizer levels, the history import, the history log, translation
models, Last.fm signing, covers).

## Test mode: comparing it with the Mac app

`./build.sh --test` runs this app beside your normal Cadenza without the two getting in each other's way:

- It has its own folder ("Cadenza Test" next to the normal one; on Linux `~/.local/share/cadenza-test`).
  The first time, it copies your sign-ins, taste profile, history and saved page data into it, and on a Mac
  your settings from the Mac app (Client ID, EQ, crossfade, theme…). It only ever reads your real folder,
  that once, and never writes to it.
- Its speaker is called "Cadenza (test)", so Spotify lists the two apps separately.
- It never touches the other app's librespot.

To compare the sound, open both, play a song, and move it between "Cadenza" and "Cadenza (test)" on the
Devices page (or from your phone): Spotify carries on at the same spot. Delete the test folder to start
the test copy over from your current data.

## Where it keeps your data

| System | Folder |
| --- | --- |
| Linux | `~/.local/share/cadenza` |
| Windows | `%APPDATA%\Cadenza` |
| macOS | `~/Library/Application Support/Cadenza` (the same folder as the Mac app) |

The files are the same as the Mac app's (see the main README's "Your data"), and only your account can
read them.

## How it fits together

| File | What it does | Mac app equivalent |
| --- | --- | --- |
| `src/main.rs` | Opens the window, connects the page, serves `cadenza-files://` | `AppDelegate.swift` |
| `src/bridge.rs` | Answers the page's `native(cmd, args)` calls | `Bridge.swift` |
| `src/auth.rs` | Spotify sign-in | `SpotifyAuth.swift` |
| `src/api.rs` | Spotify Web API, with the rate-limit guard | `SpotifyAPI.swift` |
| `src/librespot.rs` | Runs librespot and reads what it's playing | `Librespot.swift` |
| `src/sound.rs` | The sound engine: reading librespot, the crossfade, pause and skip, outputs | `EQ.swift`, `AudioOutputs.swift` |
| `src/dsp.rs` | The EQ, limiter, fades and visualizer levels, sample by sample | `EQ.swift` (Apple's EQ and limiter units) |
| `src/lastfm.rs` | Last.fm, lyrics (LRCLIB) and Genius | `LastFM.swift`, `Extras.swift` |
| `src/history.rs`, `src/spotify_history.rs` | Cadenza's own history; the Spotify history import | `History.swift`, `SpotifyHistory.swift` |
| `src/translation.rs` | Downloads and checks translation models | `TranslationModels.swift` |
| `src/cover.rs` | Playlist cover pictures | `Extras.swift` (`CoverPicker`) |
| `src/system.rs` | Media keys and Now Playing, the tray, the mini player, notifications, links, the window resting | `MediaKeys.swift`, `StatusBar.swift`, `FloatingPlayer.swift`, `Notifier.swift`, `AppDelegate.swift` |
| `src/discord.rs` | Discord's "Listening to" status | `Discord.swift` |
| `src/settings.rs`, `src/store.rs`, `src/files.rs` | Settings, page data, private files | `Settings.swift`, `Store.swift` |
| `librespot.sh` | Builds the bundled librespot | `../librespot.sh` |

The page finds the app through `window.cadenzaNative`, which works like the Mac app's WebKit message
handler, so app.js needs no other changes.
