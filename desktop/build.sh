#!/bin/bash
# Builds Cadenza for Windows, Linux or macOS (the Tauri app) on the computer you run it on.
#   ./build.sh          the installers (Linux: .deb and .AppImage; Windows: setup .exe; macOS: .dmg)
#   ./build.sh --run    build and open it straight away, for trying changes
# Needs Rust (https://rustup.rs). On Linux also the system libraries listed in desktop/README.md.
set -euo pipefail
cd "$(dirname "$0")"

./librespot.sh

if [ "${1:-}" = "--run" ]; then
  cargo run
  exit 0
fi

if ! cargo tauri --version >/dev/null 2>&1; then
  echo "> Installing Tauri's build tool (first time only)..."
  cargo install tauri-cli --version "^2" --locked
fi
cargo tauri build
echo "OK: the installers are in desktop/target/release/bundle/"
