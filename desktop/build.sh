#!/bin/bash
# Builds Cadenza for Windows, Linux or macOS (the Tauri app) on the computer you run it on.
#   ./build.sh          the installers (Linux: .deb and .AppImage; Windows: setup .exe; macOS: .dmg)
#   ./build.sh --run    build and open it straight away, for trying changes
#   ./build.sh --test   the same, in test mode: beside your normal Cadenza, with its own copy of your data
#                       and its own speaker, "Cadenza (test)", for comparing the two
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
cargo tauri build
echo "OK: the installers are in desktop/target/release/bundle/"
