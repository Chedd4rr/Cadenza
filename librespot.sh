#!/bin/bash
# Builds the librespot that ships inside Cadenza.app, so nobody has to install it separately.
# build.sh runs this for you:  ./librespot.sh <path to Cadenza.app>
#
# What it builds:
# - librespot from source: its dev branch, pinned to one exact commit (below), for this Mac's chip.
#   The dev branch has fixes for changes Spotify made in late 2026 that aren't in a release yet.
# - Plus the patches in patches/ (each one explains itself). Right now:
#   - librespot-skip-refused: when Spotify refuses a song's key (error audio key 0 2), skip the song at
#     once, instead of downloading it anyway, failing to read it and throwing away a good cached copy.
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

# (Each step that matters ends in "|| exit 1": inside "if build", bash ignores set -e.)
build() (
  if [ ! -d "${SRC}/.git" ]; then
    rm -rf "${SRC}"
    git init -q "${SRC}" || exit 1
    git -C "${SRC}" remote add origin "${REPO}" || exit 1
  fi
  # Throw away the patches applied by the last build first, or switching versions refuses to run
  # ("Your local changes … would be overwritten by checkout").
  # (Only inside librespot's own checkout: never let a missing .git make these act on a folder above it.)
  [ -d "${SRC}/.git" ] || exit 1
  git -C "${SRC}" reset -q --hard 2>/dev/null || true
  git -C "${SRC}" clean -qfd 2>/dev/null || true
  VERSION="${COMMIT}" WANT="${COMMIT}"
  if ! git -C "${SRC}" fetch -q --depth 1 origin "${COMMIT}" 2>/dev/null; then
    echo "!  The pinned librespot commit isn't available any more; building release ${FALLBACK} instead."
    VERSION="${FALLBACK}" WANT="${FALLBACK_COMMIT}"
    git -C "${SRC}" fetch -q --depth 1 origin "${FALLBACK_COMMIT}" || exit 1
  fi
  git -C "${SRC}" -c advice.detachedHead=false checkout -q -f "${WANT}" || exit 1
  # Then apply Cadenza's patches. One that doesn't fit this version is left out.
  for patch in "${HERE}"/patches/*.patch; do
    [ -f "${patch}" ] || continue
    if git -C "${SRC}" apply "${patch}"; then echo "   + $(basename "${patch}")"
    else echo "!  $(basename "${patch}") doesn't fit this librespot version; building without it."; fi
  done

  # Strip debug symbols at build time: about half the size, no difference when running.
  rm -f "${SRC}/target/release/librespot"
  ( cd "${SRC}" && CARGO_PROFILE_RELEASE_STRIP=symbols \
      cargo build --release --locked --no-default-features --features "native-tls,with-libmdns" ) || exit 1

  OUT="${CACHE}/librespot-${VERSION}-${PATCHES}-${ARCH}"
  cp "${SRC}/target/release/librespot" "${OUT}" || exit 1
  cp "${SRC}/LICENSE" "${CACHE}/LICENSE"
  # The build folder is 1-2 GB and isn't needed again for this version.
  rm -rf "${SRC}/target"
  # Put the source back as it was fetched, so the next build starts clean.
  [ -d "${SRC}/.git" ] && git -C "${SRC}" reset -q --hard
  echo "OK: Built $(basename "${OUT}") ($(du -h "${OUT}" | cut -f1 | tr -d ' '))"
)

if [ -z "${BUILT}" ]; then
  echo "> Building librespot (first time only, takes a few minutes)..."
  if build; then
    for want in "${COMMIT}" "${FALLBACK}"; do
      if [ -x "${CACHE}/librespot-${want}-${PATCHES}-${ARCH}" ]; then BUILT="${CACHE}/librespot-${want}-${PATCHES}-${ARCH}"; break; fi
    done
  fi
  # If this build failed, an earlier one is still better than none: without it the app has no speaker
  # unless librespot is also installed with Homebrew.
  if [ -z "${BUILT}" ]; then
    BUILT="$(ls -t "${CACHE}"/librespot-*-"${ARCH}" 2>/dev/null | head -1 || true)"
    if [ -n "${BUILT}" ]; then echo "!  Couldn't build the new librespot; using the last one that built: $(basename "${BUILT}")"
    else echo "!  Couldn't build librespot." >&2; exit 1; fi
  fi
fi

mkdir -p "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources/licenses"
cp "${BUILT}" "${APP_DIR}/Contents/MacOS/librespot"
chmod 755 "${APP_DIR}/Contents/MacOS/librespot"
if [ -f "${CACHE}/LICENSE" ]; then
  cp "${CACHE}/LICENSE" "${APP_DIR}/Contents/Resources/licenses/librespot-LICENSE.txt"
fi
echo "OK: librespot is inside the app"
