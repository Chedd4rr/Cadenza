# Cadenza for Windows and Linux

This folder is Cadenza rebuilt on [Tauri](https://tauri.app), so it runs on Windows and Linux (and macOS)
from one codebase. The interface is the same page as the Mac app (`Resources/web`), unchanged; only the
native side is new, written in Rust. The Mac app in `Sources/` keeps working as before until this one
does everything it does.

**Phases 0–2 of the [porting plan](https://claude.ai/artifact/MBPyXBUTmd1eJUxE4k9y6j) are done:** the
window and the bridge to the page, Spotify sign-in and playback, and everything the pages read and save.
The sound goes straight through for now; Cadenza's own sound engine is next.

## What works so far

- The whole interface, every page and theme.
- Signing in to Spotify, browsing, searching, playing, pause and skip, the queue, autoplay.
- librespot (the same version and patches as the Mac app) playing through Cadenza's sound output. If the
  output stalls it's reopened, and if it can't keep up (a slow computer or a virtual machine) its buffer
  grows by itself.
- Recovery like the Mac app's: songs Spotify won't unlock are skipped and left out of autoplay for a while,
  songs that failed to load on a hiccup get one more try, a dropped connection restarts librespot and picks
  up the same song at the same second, and Cadenza checks Spotify still lists it after the computer wakes.
- Last.fm (Stats, play counts, the DJ, Friends, similar songs), lyrics from LRCLIB, finding a song by its
  lyrics with Genius, and offline lyrics translation (the language models download the first time).
- Importing your Spotify history (pick the .zip Spotify sends, or the .json files), and Cadenza's own
  listening history for Stats. Both use the same files as the Mac app.
- Playlist covers from a picture you pick.
- Settings, the taste profile and the saved page data, in private files.
- Ctrl does what ⌘ does on the Mac (the shortcuts still say ⌘ for now).

## Not yet

| Comes in | What |
| --- | --- |
| Phase 3 | EQ, limiter, crossfade, visualizer, instant pause, picking the output device |
| Phase 4 | Media keys, tray icon, notifications, global shortcut, start at login, mini player, Discord |
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
./build.sh          # build the installers (.deb and .AppImage, or the Windows setup .exe)
```

The first build takes a while: it builds librespot (a few minutes) and then the app. Later builds reuse both.
On Windows, run these in Git Bash.

To see what it's doing, start it with `CADENZA_LOG=1` set: it then prints the engine log, every bridge
call, every Spotify request with its answer, and a sound report every few seconds. `cargo test` runs the
tests (the history import, the history log, translation models, Last.fm signing, covers).

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
| `src/sound.rs` | Plays librespot's sound | `EQ.swift` (the `AudioPipe` part) |
| `src/lastfm.rs` | Last.fm, lyrics (LRCLIB) and Genius | `LastFM.swift`, `Extras.swift` |
| `src/history.rs`, `src/spotify_history.rs` | Cadenza's own history; the Spotify history import | `History.swift`, `SpotifyHistory.swift` |
| `src/translation.rs` | Downloads and checks translation models | `TranslationModels.swift` |
| `src/cover.rs` | Playlist cover pictures | `Extras.swift` (`CoverPicker`) |
| `src/settings.rs`, `src/store.rs`, `src/files.rs` | Settings, page data, private files | `Settings.swift`, `Store.swift` |
| `librespot.sh` | Builds the bundled librespot | `../librespot.sh` |

The page finds the app through `window.cadenzaNative`, which works like the Mac app's WebKit message
handler, so app.js needs no other changes.
