#!/usr/bin/env bash
# Assemble a Linux-runnable Qobuz app tree from the pristine Windows payload.
#   upstream/app            pristine resources/app extracted from Qobuz_Installer.exe
#   native/                 Linux juce.node replacement (miniaudio, N-API)
#   vendor/node_sqlite3.node  sqlite3 5.1.7 napi-v6 linux-x64 prebuild
#   patches/apply.js        source patches for main-win32.js
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/dist/stage/app"

[ -f "$ROOT/native/build/Release/qobuz_audio.node" ] || {
  echo "building native addon..."
  (cd "$ROOT/native" && ../build/node_modules/.bin/node-gyp rebuild --target=32.3.3 --arch=x64 \
     --dist-url=https://electronjs.org/headers >/dev/null)
}

rm -rf "$ROOT/dist/stage"
mkdir -p "$(dirname "$STAGE")"
cp -a "$ROOT/upstream/app" "$STAGE"

# native modules
install -m 0755 "$ROOT/native/build/Release/qobuz_audio.node" "$STAGE/juce.node"
install -m 0755 "$ROOT/vendor/node_sqlite3.node" \
  "$STAGE/node_modules/sqlite3/build/Release/node_sqlite3.node"
# drop leftover Windows binaries from node_modules (none are loaded on Linux)
find "$STAGE/node_modules" -type f \( -name '*.dll' -o -name '*.exe' \) -delete

# JS patches
node "$ROOT/patches/apply.js" "$STAGE/main-win32.js"
echo "staged: $STAGE"
