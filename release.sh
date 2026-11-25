#!/bin/bash
# Builds Cadenza's installers for the computer you're on, and gets them ready for a GitHub release.
#
#   1. Raise the version, the same number in both desktop/tauri.conf.json and desktop/Cargo.toml.
#   2. Commit and push.
#   3. ./release.sh --github   has GitHub build and sign everything for all three systems (the full release,
#                              with updates: see docs/releasing.md)
#      ./release.sh            builds just this computer's installers and collects them (no updates)
#      ./release.sh --no-build packs what's already built, without building again
#
# It makes the full-strength build (the slower one GitHub's installers get too, not the quick one
# ./build.sh --install makes for you), copies the installers into build/release/v<version>/ with a
# SHA256SUMS file, and offers to put them on a draft GitHub release. A release has one set of installers
# per system, so run this on each computer you want to cover (a Mac, a Windows PC, a Linux machine), or let
# GitHub build them (Actions → Desktop app) and download the result. Running it a second time on another
# system adds its installers to the same release instead of making a new one.
#
# The release is a draft: nothing is public until you press Publish on GitHub.
set -euo pipefail
cd "$(dirname "$0")"

# The version lives in two places, and they have to agree.
VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' desktop/tauri.conf.json | head -1)"
CARGO_VERSION="$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' desktop/Cargo.toml | head -1)"
if [ -z "${VERSION}" ] || [ "${VERSION}" != "${CARGO_VERSION}" ]; then
  echo "!  The version in desktop/tauri.conf.json (${VERSION:-none}) and desktop/Cargo.toml (${CARGO_VERSION:-none}) don't match." >&2
  echo "   Make them the same and run this again." >&2
  exit 1
fi

# A release should be exactly what's in the repository: warn about changes that aren't committed.
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "!  There are changes that aren't committed, so this release wouldn't match the repository."
    read -r -p "Go on anyway? [y/N] " yn
    case "${yn}" in y|Y) ;; *) exit 1 ;; esac
  fi
fi

if [ "${1:-}" = "--github" ]; then
  command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 || { echo "!  This needs the GitHub CLI, logged in (gh auth login)." >&2; exit 1; }
  gh workflow run release.yml
  echo "OK: GitHub is building v${VERSION} for Mac, Windows and Linux. Watch it under Actions → Release;"
  echo "    when it's done there's a draft release to check and publish."
  exit 0
fi

if [ "${1:-}" != "--no-build" ]; then
  ./desktop/build.sh
fi

# Tauri names each installer Cadenza_<version>_<something>, in a folder per kind.
BUNDLE="desktop/target/release/bundle"
OUT="build/release/v${VERSION}"
rm -rf "${OUT}"
mkdir -p "${OUT}"
while IFS= read -r f; do
  case "${f}" in
    *.dmg|*.deb|*.AppImage|*-setup.exe) cp "${f}" "${OUT}/" ;;
  esac
done < <(find "${BUNDLE}" -type f -name "Cadenza_${VERSION}_*" 2>/dev/null)

if [ -z "$(ls -A "${OUT}")" ]; then
  echo "!  No installers for ${VERSION} in ${BUNDLE}/. Build first (./release.sh without --no-build)." >&2
  exit 1
fi

# Checksums, so anyone can check a download wasn't damaged or swapped.
# (One file per system, named after it, so running this on a second computer doesn't replace the first's.)
case "$(uname -s)" in Darwin) SUMS="SHA256SUMS-mac.txt" ;; MINGW*|MSYS*|CYGWIN*) SUMS="SHA256SUMS-windows.txt" ;; *) SUMS="SHA256SUMS-linux.txt" ;; esac
(
  cd "${OUT}"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -- * > "${SUMS}"
  else shasum -a 256 -- * > "${SUMS}"; fi
)
echo "OK: ${OUT}"
ls -1 "${OUT}" | sed 's/^/    /'

case "$(uname -s)" in
  Darwin) echo "Note: this Mac installer isn't signed with an Apple certificate, so people get the 'Open Anyway' step (see the README's Install section)." ;;
esac

# Putting it on GitHub (a draft). The first system makes the release; the others add to it.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  read -r -p "Put these on a draft GitHub release, v${VERSION}? [y/N] " yn
  case "${yn}" in
    y|Y)
      FILES=("${OUT}"/*)
      if gh release view "v${VERSION}" >/dev/null 2>&1; then
        gh release upload "v${VERSION}" "${FILES[@]}" --clobber
        echo "OK: added to the existing release v${VERSION}"
      else
        gh release create "v${VERSION}" "${FILES[@]}" --title "Cadenza ${VERSION}" --generate-notes --draft
        echo "OK: made a draft release. Check it on GitHub, then press Publish."
      fi
      ;;
  esac
else
  echo "To publish: make a release tagged v${VERSION} on GitHub and upload what's in ${OUT}/."
  echo "(Or install the GitHub CLI, run  gh auth login,  and run this again.)"
fi
