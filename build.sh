#!/bin/bash
# Builds "Cadenza.app" into ./build. Pass --install to also copy it to /Applications.
# It also puts librespot inside the app (librespot.sh builds it the first time, then reuses it).
set -euo pipefail
cd "$(dirname "$0")"

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

# Sign with a stable, self-made certificate ("Cadenza Local Signing", created once in your login
# keychain). macOS ties the Accessibility permission to the app's signature. With a one-off (ad-hoc)
# signature, every rebuild looks like a new app and macOS asks for permission again.
IDENTITY="Cadenza Local Signing"
if ! security find-certificate -c "${IDENTITY}" >/dev/null 2>&1; then
  echo "> Creating the signing certificate (one time)..."
  TMP="$(mktemp -d)"
  if /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=${IDENTITY}" \
       -keyout "${TMP}/key.pem" -out "${TMP}/cert.pem" \
       -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" \
       -addext "basicConstraints=critical,CA:false" >/dev/null 2>&1 &&
     /usr/bin/openssl pkcs12 -export -out "${TMP}/cadenza.p12" -inkey "${TMP}/key.pem" -in "${TMP}/cert.pem" \
       -name "${IDENTITY}" -passout pass:cadenza >/dev/null 2>&1 &&
     security import "${TMP}/cadenza.p12" -k "${HOME}/Library/Keychains/login.keychain-db" -P cadenza \
       -T /usr/bin/codesign >/dev/null 2>&1; then
    echo "OK: Created ${IDENTITY}"
  else
    echo "!  Couldn't create the certificate; falling back to a one-off signature."
  fi
  rm -rf "${TMP}"
fi

echo "> Signing..."
# Files that came out of a zip or a download carry Finder/quarantine tags, which codesign refuses
# ("resource fork, Finder information, or similar detritus not allowed"). Strip them first.
xattr -cr "${OUT}" 2>/dev/null || true
# The bundled librespot is signed on its own first, with the same identity: macOS won't run a program
# inside an app unless it carries the app's signature too.
HELPER="${OUT}/Contents/MacOS/librespot"
if security find-certificate -c "${IDENTITY}" >/dev/null 2>&1 &&
   { [ ! -f "${HELPER}" ] || codesign --force --sign "${IDENTITY}" "${HELPER}"; } &&
   codesign --force --deep --sign "${IDENTITY}" "${OUT}"; then
  echo "OK: Signed as ${IDENTITY} (Accessibility permission now survives rebuilds)"
else
  echo "!  Using a one-off (ad-hoc) signature. After each rebuild, re-add Cadenza in"
  echo "   System Settings > Privacy & Security > Accessibility."
  if [ -f "${HELPER}" ]; then codesign --force --sign - "${HELPER}"; fi
  codesign --force --deep --sign - "${OUT}"
fi

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
