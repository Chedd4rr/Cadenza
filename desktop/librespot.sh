#!/bin/bash
# Gets librespot's source ready for Cadenza, which builds it into itself (the audio engine): one pinned
# commit of librespot, with the patches in ../patches on top, in librespot-src/ (Cargo.toml points there).
# build.sh runs this for you. It only does anything when the version or a patch changes.
#
# - librespot's dev branch, pinned to one exact commit, or release 0.8.0 if that commit is gone.
# - The patches in ../patches (each explains itself at its top).
#
# git's copy lives outside this project (CADENZA_CACHE, by default ~/.cache/cadenza-build on Linux,
# ~/Library/Developer/Cadenza on macOS, %LOCALAPPDATA%\cadenza-build on Windows), and librespot-src/ is
# never committed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="https://github.com/librespot-org/librespot"
COMMIT="15e02e86c72d96dd39d548e3749f00abe39ffdde"          # librespot's dev branch as of 7 Nov 2026
FALLBACK="v0.8.0"
FALLBACK_COMMIT="d36f9f1907e8cc9d68a93f8ebc6b627b1bf7267d"

case "$(uname -s)" in
  Darwin) DEFAULT_CACHE="${HOME}/Library/Developer/Cadenza/librespot" ;;
  MINGW*|MSYS*|CYGWIN*) DEFAULT_CACHE="${LOCALAPPDATA:-${HOME}}/cadenza-build/librespot" ;;
  *) DEFAULT_CACHE="${XDG_CACHE_HOME:-${HOME}/.cache}/cadenza-build/librespot" ;;
esac
CACHE="${CADENZA_CACHE:-${DEFAULT_CACHE}}"
SRC="${CACHE}/src"
mkdir -p "${CACHE}"

# The patches are part of the version: change what a patch does and the source is made again. Only the
# changes themselves count (from "diff --git" on), so rewording a description doesn't.
sum() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; }
PATCHES="$(awk 'FNR==1{p=0} /^diff --git/{p=1} p' "${HERE}"/../patches/*.patch 2>/dev/null | sum | cut -c1-8)"

STAMP="${COMMIT}-${PATCHES}"
if [ "$(cat "${HERE}/librespot-src/.cadenza-version" 2>/dev/null)" = "${STAMP}" ]; then
  exit 0
fi

# Fetches the pinned commit (or the fallback release) into ${SRC} and puts the patches on top.
# Prints the version it got.
checkout() (
  if [ ! -d "${SRC}/.git" ]; then
    rm -rf "${SRC}"
    git init -q "${SRC}" || exit 1
    git -C "${SRC}" remote add origin "${REPO}" || exit 1
  fi
  git -C "${SRC}" reset -q --hard 2>/dev/null || true
  git -C "${SRC}" clean -qfdx 2>/dev/null || true
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
    else echo "!  $(basename "${patch}") doesn't fit this librespot version; going on without it." >&2; fi
  done
  echo "${VERSION}"
)

echo "> Getting librespot's source ready (only when its version or a patch changes)..."
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
  echo "!  Couldn't fetch librespot's source (it needs the internet the first time)." >&2
  exit 1
fi
