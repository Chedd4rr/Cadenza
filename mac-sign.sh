#!/bin/bash
# Signs a built Cadenza.app (the Tauri one or the Swift one) on a Mac:  ./mac-sign.sh path/to/Cadenza.app
#
# It uses a stable, self-made certificate ("Cadenza Local Signing", created once in your login keychain).
# macOS ties permissions (Accessibility, Local Network, notifications) to the app's signature. With a
# one-off (ad-hoc) signature every rebuild looks like a new app, and macOS asks again.
set -euo pipefail
OUT="${1:?usage: mac-sign.sh path/to/Cadenza.app}"
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
  echo "OK: Signed as ${IDENTITY} (permissions now survive rebuilds)"
else
  echo "!  Using a one-off (ad-hoc) signature: macOS may ask for permissions again after each rebuild."
  if [ -f "${HELPER}" ]; then codesign --force --sign - "${HELPER}"; fi
  codesign --force --deep --sign - "${OUT}"
fi
