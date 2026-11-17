#!/bin/bash
# Builds the librespot that ships inside Cadenza.app, so nobody has to install it separately.
# build.sh runs this for you:  ./librespot.sh <path to Cadenza.app>
#
# What it builds:
# - librespot from source: its dev branch, pinned to one exact commit (below), for this Mac's chip.
#   The dev branch has fixes for changes Spotify made in late 2026 that aren't in a release yet.
# - Plus the patches in patches/ (each one explains itself). Right now:
#   - librespot-retry-keys: when Spotify refuses a song's key with its "try again" code
#     (error audio key 0 2), ask again up to 3 times instead of skipping the song (librespot PR #1763);
#   - librespot-skip-refused: when it still refuses after that, skip the song at once, instead of
#     downloading it anyway, failing to read it and throwing away a good cached copy.
# - Pipe output only, no speaker code: Cadenza plays all sound through its own engine.
#
# The source and the finished program are kept in ~/Library/Developer/Cadenza/librespot, outside this
# project, so they never end up in git. The first build takes a few minutes; after that it's reused.
# Needs Rust (brew install rust). Without it, Cadenza is built without librespot inside and falls back
# to one installed with Homebrew. Set CADENZA_SKIP_LIBRESPOT=1 to skip this on purpose.
set -euo pipefail

APP_DIR="${1:?Usage: ./librespot.sh <path to Cadenza.app>}"

REPO="https://github.com/librespot-org/librespot"
# librespot's dev branch as of 7 Nov 2026.
COMMIT="15e02e86c72d96dd39d548e3749f00abe39ffdde"
# If that commit can't be fetched for some reason, use the last release (the patches go on top where they fit).
# Pinned by commit too, since a tag can be moved.
FALLBACK="v0.8.0"
FALLBACK_COMMIT="d36f9f1907e8cc9d68a93f8ebc6b627b1bf7267d"

HERE="$(cd "$(dirname "$0")" && pwd)"
# Not in ~/Library/Caches: macOS empties that when the disk runs low (and cleaner apps empty it too),
# which made every build start over.
CACHE="${HOME}/Library/Developer/Cadenza/librespot"
OLD_CACHE="${HOME}/Library/Caches/Cadenza/librespot"
SRC="${CACHE}/src"

if [ "${CADENZA_SKIP_LIBRESPOT:-}" = "1" ]; then
  echo "!  Skipping the built-in librespot (CADENZA_SKIP_LIBRESPOT=1)."
  exit 0
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "!  Rust isn't installed, so Cadenza is built without librespot inside."
  echo "   It will use a Homebrew one instead (brew install librespot)."
  echo "   To bundle it: brew install rust   then run the build again."
  exit 0
fi

ARCH="$(uname -m)"
# The patches are part of the version: change what a patch does and librespot is rebuilt. Only the
# changes themselves count (from "diff --git" on), so rewording a patch's description doesn't.
PATCHES="$(awk 'FNR==1{p=0} /^diff --git/{p=1} p' "${HERE}"/patches/*.patch 2>/dev/null | shasum | cut -c1-8)"
# Move a build from the old place, so it isn't made again.
if [ -d "${OLD_CACHE}" ] && [ ! -d "${CACHE}" ]; then
  mkdir -p "$(dirname "${CACHE}")" && mv "${OLD_CACHE}" "${CACHE}" 2>/dev/null || true
fi
mkdir -p "${CACHE}"

# Which version we can get: the pinned commit, or the last release if that's gone.
BUILT=""
for want in "${COMMIT}" "${FALLBACK}"; do
  if [ -x "${CACHE}/librespot-${want}-${PATCHES}-${ARCH}" ]; then BUILT="${CACHE}/librespot-${want}-${PATCHES}-${ARCH}"; break; fi
done

if [ -z "${BUILT}" ]; then
  echo "> Building librespot (first time only, takes a few minutes)..."
  if [ ! -d "${SRC}/.git" ]; then
    rm -rf "${SRC}"
    git init -q "${SRC}"
    git -C "${SRC}" remote add origin "${REPO}"
  fi
  VERSION="${COMMIT}"
  if ! git -C "${SRC}" fetch -q --depth 1 origin "${COMMIT}" 2>/dev/null; then
    echo "!  The pinned librespot commit isn't available any more; building release ${FALLBACK} instead."
    VERSION="${FALLBACK}"
    git -C "${SRC}" fetch -q --depth 1 origin "${FALLBACK_COMMIT}"
  fi
  if [ "${VERSION}" = "${COMMIT}" ]; then
    git -C "${SRC}" -c advice.detachedHead=false checkout -q "${COMMIT}"
  else
    git -C "${SRC}" -c advice.detachedHead=false checkout -q "${FALLBACK_COMMIT}"
  fi
  # Start from clean source, then apply Cadenza's patches. One that doesn't fit this version is left out.
  git -C "${SRC}" checkout -q -- .
  for patch in "${HERE}"/patches/*.patch; do
    [ -f "${patch}" ] || continue
    if git -C "${SRC}" apply "${patch}"; then echo "   + $(basename "${patch}")"
    else echo "!  $(basename "${patch}") doesn't fit this librespot version; building without it."; fi
  done

  # Strip debug symbols at build time: about half the size, no difference when running.
  ( cd "${SRC}" && CARGO_PROFILE_RELEASE_STRIP=symbols \
      cargo build --release --locked --no-default-features --features "native-tls,with-libmdns" )

  BUILT="${CACHE}/librespot-${VERSION}-${PATCHES}-${ARCH}"
  cp "${SRC}/target/release/librespot" "${BUILT}"
  cp "${SRC}/LICENSE" "${CACHE}/LICENSE"
  # The build folder is 1-2 GB and isn't needed again for this version.
  rm -rf "${SRC}/target"
  echo "OK: Built $(basename "${BUILT}") ($(du -h "${BUILT}" | cut -f1 | tr -d ' '))"
fi

mkdir -p "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources/licenses"
cp "${BUILT}" "${APP_DIR}/Contents/MacOS/librespot"
chmod 755 "${APP_DIR}/Contents/MacOS/librespot"
if [ -f "${CACHE}/LICENSE" ]; then
  cp "${CACHE}/LICENSE" "${APP_DIR}/Contents/Resources/licenses/librespot-LICENSE.txt"
fi
echo "OK: librespot is inside the app"
