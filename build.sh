#!/bin/bash
# Builds Cadenza (the app in desktop/, for macOS, Windows and Linux). This just passes everything on to
# desktop/build.sh:
#   ./build.sh --install    build it; on a Mac, also put it in /Applications in place of the old copy
#   ./build.sh              build the installers, without installing
#   ./build.sh --run        build and open it straight away, for trying changes
set -euo pipefail
cd "$(dirname "$0")"
exec ./desktop/build.sh "$@"
