#!/bin/bash
# Gets librespot ready for Cadenza on Windows, Linux and macOS (the Tauri app), the same version and
# patches as the Mac app's ../librespot.sh. Two things:
#   librespot-src/                      its source with Cadenza's patches, which Cadenza builds into
#                                       itself (the built-in engine, the normal one)
#   binaries/librespot-<triple>[.exe]   the separate librespot program, which Tauri bundles (the old way,
#                                       still there to switch back to in System → Engine settings)
# build.sh runs this for you. The first build takes a few minutes; after that it's reused.
#
# - librespot's dev branch, pinned to one exact commit, or release 0.8.0 if that commit is gone.
# - The patches in ../patches (each explains itself at its top).
# - Pipe output only: Cadenza plays all sound through its own engine.
#
# The source and finished programs live outside this project (CADENZA_CACHE, by default
# ~/.cache/cadenza-build on Linux, ~/Library/Developer/Cadenza on macOS, %LOCALAPPDATA%\cadenza-build
# on Windows), so they never end up in git.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="https://github.com/librespot-org/librespot"
COMMIT="15e02e86c72d96dd39d548e3749f00abe39ffdde"          # librespot's dev branch as of 7 Nov 2026
FALLBACK="v0.8.0"
FALLBACK_COMMIT="d36f9f1907e8cc9d68a93f8ebc6b627b1bf7267d"

if ! command -v cargo >/dev/null 2>&1; then
  echo "!  Rust isn't installed. Get it from https://rustup.rs and run this again." >&2
  exit 1
fi

TRIPLE="${CADENZA_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}"
EXT=""; case "${TRIPLE}" in *windows*) EXT=".exe" ;; esac

case "$(uname -s)" in
  Darwin) DEFAULT_CACHE="${HOME}/Library/Developer/Cadenza/librespot" ;;
  MINGW*|MSYS*|CYGWIN*) DEFAULT_CACHE="${LOCALAPPDATA:-${HOME}}/cadenza-build/librespot" ;;
  *) DEFAULT_CACHE="${XDG_CACHE_HOME:-${HOME}/.cache}/cadenza-build/librespot" ;;
esac
CACHE="${CADENZA_CACHE:-${DEFAULT_CACHE}}"
SRC="${CACHE}/src"
mkdir -p "${CACHE}"

# The patches are part of the version: change what a patch does and librespot is rebuilt. Only the
# changes themselves count (from "diff --git" on), so rewording a description doesn't.
sum() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; }
PATCHES="$(awk 'FNR==1{p=0} /^diff --git/{p=1} p' "${HERE}"/../patches/*.patch 2>/dev/null | sum | cut -c1-8)"

find_built() {
  for want in "${COMMIT}" "${FALLBACK}"; do
    local f="${CACHE}/librespot-${want}-${PATCHES}-${TRIPLE}${EXT}"
    if [ -f "${f}" ]; then echo "${f}"; return; fi
  done
}

# Fetches the pinned commit (or the fallback release) into ${SRC} and puts the patches on top.
# Prints the version it got.
checkout() (
  if [ ! -d "${SRC}/.git" ]; then
    rm -rf "${SRC}"
    git init -q "${SRC}" || exit 1
    git -C "${SRC}" remote add origin "${REPO}" || exit 1
  fi
  [ -d "${SRC}/.git" ] || exit 1
  git -C "${SRC}" reset -q --hard 2>/dev/null || true
  git -C "${SRC}" clean -qfd 2>/dev/null || true
  VERSION="${COMMIT}" WANT="${COMMIT}"
  if ! git -C "${SRC}" fetch -q --depth 1 origin "${COMMIT}" 2>/dev/null; then
    echo "!  The pinned librespot commit isn't available any more; using release ${FALLBACK} instead." >&2
    VERSION="${FALLBACK}" WANT="${FALLBACK_COMMIT}"
    git -C "${SRC}" fetch -q --depth 1 origin "${FALLBACK_COMMIT}" || exit 1
  fi
  git -C "${SRC}" -c advice.detachedHead=false checkout -q -f "${WANT}" || exit 1
  for patch in "${HERE}"/../patches/*.patch; do
    [ -f "${patch}" ] || continue
    if git -C "${SRC}" apply "${patch}"; then echo "   + $(basename "${patch}")" >&2
    else echo "!  $(basename "${patch}") doesn't fit this librespot version; building without it." >&2; fi
  done
  echo "${VERSION}"
)

build() (
  VERSION="$(checkout)" || exit 1
  ( cd "${SRC}" && CARGO_PROFILE_RELEASE_STRIP=symbols \
      cargo build --release --locked --target "${TRIPLE}" --no-default-features --features "native-tls,with-libmdns" ) || exit 1
  OUT="${CACHE}/librespot-${VERSION}-${PATCHES}-${TRIPLE}${EXT}"
  cp "${SRC}/target/${TRIPLE}/release/librespot${EXT}" "${OUT}" || exit 1
  cp "${SRC}/LICENSE" "${CACHE}/LICENSE"
  rm -rf "${SRC}/target"                     # 1-2 GB, not needed again for this version
  git -C "${SRC}" reset -q --hard
  echo "OK: built $(basename "${OUT}")"
)

BUILT="$(find_built || true)"
if [ -z "${BUILT}" ]; then
  echo "> Building librespot for ${TRIPLE} (first time only, takes a few minutes)..."
  build || true
  BUILT="$(find_built || true)"
  if [ -z "${BUILT}" ]; then
    # An earlier build is better than none.
    BUILT="$(ls -t "${CACHE}"/librespot-*-"${TRIPLE}${EXT}" 2>/dev/null | head -1 || true)"
    [ -n "${BUILT}" ] && echo "!  Couldn't build the new librespot; using the last one that built: $(basename "${BUILT}")"
  fi
fi
[ -n "${BUILT}" ] || { echo "!  Couldn't build librespot." >&2; exit 1; }

# The source Cadenza builds into itself (Cargo.toml points at it). Copied out of the cache, without git's
# files, and only again when the version or the patches change.
STAMP="${COMMIT}-${PATCHES}"
if [ "$(cat "${HERE}/librespot-src/.cadenza-version" 2>/dev/null)" != "${STAMP}" ]; then
  echo "> Getting librespot's source ready for the built-in engine..."
  if VERSION="$(checkout)"; then
    rm -rf "${HERE}/librespot-src.new"
    mkdir -p "${HERE}/librespot-src.new"
    tar -C "${SRC}" --exclude=./.git --exclude=./target -cf - . | tar -C "${HERE}/librespot-src.new" -xf -
    echo "${STAMP}" > "${HERE}/librespot-src.new/.cadenza-version"
    git -C "${SRC}" reset -q --hard
    rm -rf "${HERE}/librespot-src"
    mv "${HERE}/librespot-src.new" "${HERE}/librespot-src"
    echo "OK: librespot-src (${VERSION})"
  elif [ -d "${HERE}/librespot-src" ]; then
    echo "!  Couldn't fetch librespot's source; keeping the copy that's already here."
  else
    echo "!  Couldn't fetch librespot's source." >&2; exit 1
  fi
fi

mkdir -p "${HERE}/binaries"
cp "${BUILT}" "${HERE}/binaries/librespot-${TRIPLE}${EXT}"
chmod 755 "${HERE}/binaries/librespot-${TRIPLE}${EXT}"
[ -f "${CACHE}/LICENSE" ] && cp "${CACHE}/LICENSE" "${HERE}/binaries/librespot-LICENSE.txt"
echo "OK: binaries/librespot-${TRIPLE}${EXT}"
