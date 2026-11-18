# Cadenza for Windows and Linux

This folder is Cadenza rebuilt on [Tauri](https://tauri.app), so it runs on Windows and Linux (and macOS)
from one codebase. The interface is the same page as the Mac app (`Resources/web`), unchanged; only the
native side is new, written in Rust. The Mac app in `Sources/` keeps working as before until this one
does everything it does.

**It's early.** This is phases 0 and 1 of the [porting plan](https://claude.ai/artifact/MBPyXBUTmd1eJUxE4k9y6j):
the window, the bridge to the page, Spotify sign-in and librespot playing through Cadenza's own output.

## What works so far

- The whole interface, every page and theme.
- Signing in to Spotify, browsing, searching, playing, the queue, autoplay.
- librespot (the same version and patches as the Mac app) playing through Cadenza's sound output, with
  the sound going straight through for now.
- Settings, the taste profile and the saved page data, in private files.
- Ctrl does what ⌘ does on the Mac (the shortcuts still say ⌘ for now).

## Not yet

| Comes in | What |
| --- | --- |
| Phase 2 | Last.fm, lyrics, translation, importing your Spotify history, Cadenza's own listening history, recovery when Spotify drops the connection |
| Phase 3 | EQ, limiter, crossfade, visualizer, picking the output device |
| Phase 4 | Media keys, tray icon, notifications, global shortcut, start at login, mini player, Discord |
| Phase 5 | Windows: player events from librespot, the installer, testing |
| Phase 6 | macOS build at parity, moving your Mac settings over |
| Phase 7 | Signed releases and automatic updates |

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

To see what it's doing, start it with `CADENZA_LOG=1` set: it then prints the engine log and every
bridge call to the terminal.

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
| `src/settings.rs`, `src/store.rs`, `src/files.rs` | Settings, page data, private files | `Settings.swift`, `Store.swift` |
| `librespot.sh` | Builds the bundled librespot | `../librespot.sh` |

The page finds the app through `window.cadenzaNative`, which works like the Mac app's WebKit message
handler, so app.js needs no other changes.
