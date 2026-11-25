#!/bin/bash
# Builds Cadenza for Windows, Linux or macOS (the Tauri app) on the computer you run it on.
#   ./build.sh          the installers (Linux: .deb and .AppImage; Windows: setup .exe; macOS: .dmg)
#   ./build.sh --run    build and open it straight away, for trying changes
#   ./build.sh --test   the same, in test mode: beside your normal Cadenza, with its own copy of your data
#                       and its own speaker, "Cadenza (test)", for comparing the two
#   ./build.sh --install  macOS: build Cadenza.app, sign it, and put it in /Applications in place of the
#                       old one. Elsewhere: the installers.
#   ./build.sh --app    macOS: build the real Cadenza.app (with its icon, Dock and menu name, notifications
#                       and links, which a --run build doesn't have) and open it. Add --log to see its log.
# Needs Rust (https://rustup.rs). On Linux also the system libraries listed in desktop/README.md.
set -euo pipefail
cd "$(dirname "$0")"

# On ARM Windows, part of Cadenza (ring, used for HTTPS) can only be compiled with clang, which comes with
# LLVM. Microsoft's own compiler can't do it there.
# (Ask Rust, not uname: Git Bash's own tools are x64 programs even on ARM, so uname says x86_64.)
case "$(rustc -vV | sed -n 's/^host: //p')" in
  aarch64-pc-windows-*)
    [ -d "/c/Program Files/LLVM/bin" ] && export PATH="/c/Program Files/LLVM/bin:$PATH"
    if ! command -v clang >/dev/null 2>&1; then
      echo "On ARM Windows Cadenza needs clang. Install it with:  winget install LLVM.LLVM"
      echo "then open Git Bash again and rerun this."
      exit 1
    fi
    ;;
esac

./librespot.sh

# macOS refuses to sign an app that contains Finder's marks ("resource fork, Finder information, or similar
# detritus"). Files that came out of a zip or a download can carry them, so clear them from the sources
# first.
if [ "$(uname)" = "Darwin" ]; then
  xattr -cr ../Resources src icons 2>/dev/null || true
fi

if [ "${1:-}" = "--run" ]; then
  cargo run
  exit 0
fi
if [ "${1:-}" = "--test" ]; then
  CADENZA_TEST=1 cargo run
  exit 0
fi

# Tauri's build tool goes into Cargo's own folder, which isn't always on the PATH (Homebrew's Rust doesn't
# add it), so look there too instead of installing it again every time.
CARGO_BIN="${CARGO_HOME:-$HOME/.cargo}/bin"
case ":$PATH:" in *":$CARGO_BIN:"*) ;; *) export PATH="$CARGO_BIN:$PATH" ;; esac
if ! command -v cargo-tauri >/dev/null 2>&1; then
  echo "> Installing Tauri's build tool (first time only)..."
  cargo install tauri-cli --version "^2" --locked
fi

# Your own installs skip the slowest optimisation (link-time, over the whole program): it makes the app
# a little smaller and faster, but adds minutes to every build even when one line changed. The installers
# GitHub builds for handing out keep it.
if [ "${1:-}" = "--app" ] || [ "${1:-}" = "--install" ]; then
  export CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
  # On a Mac the build happens outside this folder. Desktop and Documents are synced by iCloud, which keeps
  # tagging the files in them, and macOS refuses to sign an app with those tags in it ("resource fork,
  # Finder information, or similar detritus"). (The first build there takes a few minutes longer.)
  if [ "$(uname -s)" = "Darwin" ]; then export CARGO_TARGET_DIR="${CADENZA_TARGET_DIR:-$HOME/Library/Caches/Cadenza-build}"; fi
fi
OUT="${CARGO_TARGET_DIR:-target}"

if [ "${1:-}" = "--app" ]; then
  [ "$(uname -s)" = "Darwin" ] || { echo "--app is for macOS; use --run here."; exit 1; }
  cargo tauri build --bundles app
  APP="$OUT/release/bundle/macos/Cadenza.app"
  pkill -f "$APP/Contents/MacOS/" 2>/dev/null || true      # a copy from the last build
  if [ "${2:-}" = "--log" ]; then
    exec env CADENZA_LOG=1 "$APP/Contents/MacOS/$(defaults read "$(cd "$APP" && pwd)/Contents/Info" CFBundleExecutable)"
  fi
  open "$APP"
  echo "OK: opened $APP"
  exit 0
fi

if [ "${1:-}" = "--install" ] && [ "$(uname -s)" = "Darwin" ]; then
  rm -rf "$OUT/release/bundle/macos/Cadenza.app"           # (fresh each time, so nothing old rides along)
  cargo tauri build --bundles app
  BUILT="$OUT/release/bundle/macos/Cadenza.app"
  # Signed in a temporary folder: if this project is in an iCloud-synced folder (Desktop or Documents),
  # macOS keeps tagging files there, and codesign refuses tagged files.
  STAGE="$(mktemp -d /tmp/cadenza-install.XXXXXX)"
  trap 'rm -rf "${STAGE}"' EXIT
  ditto "${BUILT}" "${STAGE}/Cadenza.app"
  ../mac-sign.sh "${STAGE}/Cadenza.app"

  # Quit whichever Cadenza is running (the old app and this one have the same id), and wait for it.
  osascript -e 'tell application id "io.github.chedd4rr.cadenza" to quit' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "Cadenza.app/Contents/MacOS/" >/dev/null || break
    sleep 1
  done
  pkill -f "Cadenza.app/Contents/MacOS/" 2>/dev/null || true

  OLD="/Applications/Cadenza.app"
  rm -rf "${OLD}"
  ditto "${STAGE}/Cadenza.app" "${OLD}"
  echo "OK: Installed to ${OLD}"
  open "${OLD}"
  exit 0
fi

# With the update key in the environment (TAURI_SIGNING_PRIVATE_KEY), also make the signed files the updater
# downloads. Without it, a normal build: those files can't be made, and asking for them would fail.
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  cargo tauri build --config tauri.release.conf.json
else
  cargo tauri build
fi
echo "OK: the installers are in desktop/target/release/bundle/"
