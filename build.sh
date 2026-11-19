#!/bin/bash
# Builds Cadenza.
#   ./build.sh --install          the app (desktop/, for macOS, Windows and Linux); on a Mac, also puts it in
#                                 /Applications in place of the old one (see desktop/build.sh)
#   ./build.sh                    the same, without installing
#   ./build.sh --swift [--install]  the old Swift Mac app (Sources/), kept for now in case you want to go back
set -euo pipefail
cd "$(dirname "$0")"

if [ "${1:-}" != "--swift" ]; then
  exec ./desktop/build.sh "$@"
fi
shift

# The Swift app: builds "Cadenza.app" into ./build, and with --install copies it to /Applications.
# It also puts librespot inside the app (librespot.sh builds it the first time, then reuses it).

APP="Cadenza.app"
OUT="build/${APP}"

if ! command -v swift >/dev/null 2>&1; then
  echo "Swift isn't installed. Run:  xcode-select --install   then try again." >&2
  exit 1
fi

echo "> Compiling..."
swift build -c release
BIN="$(swift build -c release --show-bin-path)/Cadenza"

echo "> Assembling ${APP}..."
# The app is put together and signed in a temporary folder, not in ./build: if this project sits in
# an iCloud-synced folder (Desktop or Documents), macOS keeps tagging files there, and codesign
# refuses tagged files ("resource fork, Finder information, or similar detritus not allowed").
FINAL="${OUT}"
STAGE_DIR="$(mktemp -d /tmp/cadenza-build.XXXXXX)"
trap 'rm -rf "${STAGE_DIR}"' EXIT
OUT="${STAGE_DIR}/${APP}"
mkdir -p "${OUT}/Contents/MacOS" "${OUT}/Contents/Resources"
cp "${BIN}" "${OUT}/Contents/MacOS/Cadenza"
cp Resources/Info.plist "${OUT}/Contents/Info.plist"
cp -R Resources/web "${OUT}/Contents/Resources/web"

# librespot goes inside the app, so it works without installing anything else (see librespot.sh).
./librespot.sh "${OUT}" || echo "!  Couldn't build librespot, so this copy uses a Homebrew one instead (brew install librespot)."

if [ -f Resources/icon.png ]; then
  ICONSET="${STAGE_DIR}/AppIcon.iconset"
  rm -rf "${ICONSET}"; mkdir -p "${ICONSET}"
  for s in 16 32 128 256 512; do
    sips -z $s $s Resources/icon.png --out "${ICONSET}/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) Resources/icon.png --out "${ICONSET}/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "${ICONSET}" -o "${OUT}/Contents/Resources/AppIcon.icns"
fi

./mac-sign.sh "${OUT}"

# Copy the signed app into ./build (ditto keeps the signature intact).
mkdir -p build
rm -rf "${FINAL}"
ditto "${OUT}" "${FINAL}"
echo "OK: Built: ${FINAL}"

if [ "${1:-}" = "--install" ]; then
  # Quit a running copy first so it can be replaced.
  osascript -e 'tell application "Cadenza" to quit' >/dev/null 2>&1 || true
  # The app used to be called Chord: quit and remove the old copy. Cadenza brings over its settings
  # and data the first time it opens.
  if [ -d "/Applications/Chord.app" ]; then
    osascript -e 'tell application id "io.github.chedd4rr.chord" to quit' >/dev/null 2>&1 || true
    sleep 1
    rm -rf "/Applications/Chord.app"
    echo "OK: Removed the old Chord.app (your settings move over to Cadenza)"
  fi
  sleep 1
  rm -rf "/Applications/${APP}"
  ditto "${OUT}" "/Applications/${APP}"
  echo "OK: Installed to /Applications/${APP}"
  open "/Applications/${APP}"
fi
