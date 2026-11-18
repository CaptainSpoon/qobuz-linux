#!/usr/bin/env bash
# Download the official Qobuz Windows installer from Qobuz and extract the
# Electron app (resources/app) into upstream/app.
#
#   scripts/fetch-upstream.sh                 # download from desktop.qobuz.com
#   scripts/fetch-upstream.sh /path/to/Qobuz_Installer.exe   # use a local copy
#
# Nothing from Qobuz is stored in this repository; it is fetched from Qobuz
# on your machine at build time.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

QOBUZ_VERSION="8.3.0-b028"
URL="https://desktop.qobuz.com/releases/win32/x64/windows7_8_10/${QOBUZ_VERSION}/Qobuz_Installer.exe"
SHA256="37814dd6efea4b7857691efb72f7de7af6458d4c13a2ece756168ba9d580c864"

CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/qobuz-linux"
mkdir -p "$CACHE"
EXE="${1:-$CACHE/Qobuz_Installer-${QOBUZ_VERSION}.exe}"

if [ ! -f "$EXE" ]; then
  echo "Downloading Qobuz ${QOBUZ_VERSION} installer from desktop.qobuz.com..."
  curl -fL --retry 3 -o "$EXE.part" "$URL"
  mv "$EXE.part" "$EXE"
fi

if [ "${QOBUZ_SKIP_CHECKSUM:-0}" != 1 ]; then
  echo "$SHA256  $EXE" | sha256sum -c --quiet - || {
    echo "Checksum mismatch for $EXE."
    echo "The patches target Qobuz ${QOBUZ_VERSION}; a different build will likely fail to patch."
    echo "Set QOBUZ_SKIP_CHECKSUM=1 to try anyway."
    exit 1
  }
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Squirrel setup.exe: the payload is a zip stored as PE resource DATA/131,
# containing the full .nupkg, which holds lib/net45/resources/app.
7z x -tPE -y -o"$TMP/rsrc" "$EXE" '.rsrc/DATA/131' >/dev/null
7z x -tzip -y -o"$TMP/payload" "$TMP/rsrc/.rsrc/DATA/131" '*-full.nupkg' >/dev/null
NUPKG="$(find "$TMP/payload" -name '*-full.nupkg' | head -1)"
[ -n "$NUPKG" ] || { echo "no .nupkg found in installer payload"; exit 1; }
7z x -y -o"$TMP/pkg" "$NUPKG" 'lib/net45/resources/app/*' >/dev/null

APP="$TMP/pkg/lib/net45/resources/app"
[ -f "$APP/main-win32.js" ] || { echo "unexpected installer layout (main-win32.js missing)"; exit 1; }

rm -rf "$ROOT/upstream/app"
mkdir -p "$ROOT/upstream"
mv "$APP" "$ROOT/upstream/app"
echo "extracted: $ROOT/upstream/app"
