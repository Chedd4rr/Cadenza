#!/bin/bash
# Builds Cadenza for Windows, Linux or macOS (the Tauri app) on the computer you run it on.
#   ./build.sh          the installers (Linux: .deb and .AppImage; Windows: setup .exe; macOS: .dmg)
#   ./build.sh --run    build and open it straight away, for trying changes
#   ./build.sh --test   the same, in test mode: beside your normal Cadenza, with its own copy of your data
#                       and its own speaker, "Cadenza (test)", for comparing the two
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

if [ "${1:-}" = "--run" ]; then
  cargo run
  exit 0
fi
if [ "${1:-}" = "--test" ]; then
  CADENZA_TEST=1 cargo run
  exit 0
fi

if ! cargo tauri --version >/dev/null 2>&1; then
  echo "> Installing Tauri's build tool (first time only)..."
  cargo install tauri-cli --version "^2" --locked
fi

if [ "${1:-}" = "--app" ]; then
  [ "$(uname -s)" = "Darwin" ] || { echo "--app is for macOS; use --run here."; exit 1; }
  cargo tauri build --bundles app
  APP="target/release/bundle/macos/Cadenza.app"
  pkill -f "$APP/Contents/MacOS/" 2>/dev/null || true      # a copy from the last build
  if [ "${2:-}" = "--log" ]; then
    exec env CADENZA_LOG=1 "$APP/Contents/MacOS/$(defaults read "$PWD/$APP/Contents/Info" CFBundleExecutable)"
  fi
  open "$APP"
  echo "OK: opened $APP"
  exit 0
fi

cargo tauri build
echo "OK: the installers are in desktop/target/release/bundle/"
