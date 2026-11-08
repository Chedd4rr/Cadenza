#!/bin/bash
# Builds Cadenza and packs it for a GitHub release, so other copies of Cadenza can update themselves.
#   1. Bump CFBundleShortVersionString in Resources/Info.plist (e.g. 1.0 → 1.1)
#   2. ./release.sh
#   3. Upload build/Cadenza-<version>.zip to a new release tagged v<version>
#      (if the GitHub CLI is installed and logged in, this script offers to do it for you)
set -euo pipefail
cd "$(dirname "$0")"

./build.sh
# A release without librespot inside would need everyone to install it themselves: stop instead.
if [ ! -x build/Cadenza.app/Contents/MacOS/librespot ]; then
  echo "!  build/Cadenza.app has no librespot inside (is Rust installed?). Not packing a release." >&2
  exit 1
fi
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' Resources/Info.plist)"
ZIP="build/Cadenza-${VERSION}.zip"
rm -f "${ZIP}"
# ditto keeps the app's signature and symlinks intact (plain zip can break them).
ditto -c -k --norsrc --noextattr --keepParent build/Cadenza.app "${ZIP}"   # no Finder/iCloud tags in the zip
echo "OK: ${ZIP}"

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  read -r -p "Publish v${VERSION} to GitHub now? [y/N] " yn
  if [ "${yn}" = "y" ] || [ "${yn}" = "Y" ]; then
    gh release create "v${VERSION}" "${ZIP}" --title "Cadenza ${VERSION}" --generate-notes
  fi
else
  echo "Upload ${ZIP} to a GitHub release tagged v${VERSION}."
fi
