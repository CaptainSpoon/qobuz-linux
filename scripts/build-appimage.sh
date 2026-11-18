#!/usr/bin/env bash
# One-shot build: fetch Qobuz + sqlite3 -> native addon -> staged app -> AppImage in dist/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
B="$ROOT/build"

[ -f "$ROOT/upstream/app/main-win32.js" ] || "$ROOT/scripts/fetch-upstream.sh" ${QOBUZ_INSTALLER:+"$QOBUZ_INSTALLER"}
"$ROOT/scripts/fetch-sqlite3.sh"

# Build tooling (Electron 32.3.3 = the version Qobuz 8.3.0 ships)
[ -d "$B/node_modules" ] || (cd "$B" && npm ci --no-audit --no-fund)

# Electron's postinstall unzip (extract-zip) silently fails under some newer
# Node versions; extract the cached zip with 7z if the binary is missing.
if [ ! -x "$B/node_modules/electron/dist/electron" ]; then
  (cd "$B/node_modules/electron" && node install.js || true)
  if [ ! -x "$B/node_modules/electron/dist/electron" ]; then
    Z=electron-v32.3.3-linux-x64.zip
    ZIP=$(find "${electron_config_cache:-${XDG_CACHE_HOME:-$HOME/.cache}/electron}" -name "$Z" 2>/dev/null | head -1 || true)
    if [ -z "$ZIP" ]; then
      ZIP="$B/$Z"
      curl -fL --retry 3 -o "$ZIP" "https://github.com/electron/electron/releases/download/v32.3.3/$Z"
    fi
    # verify against the checksum shipped in the electron npm package
    SUM=$(node -p "require('$B/node_modules/electron/checksums.json')['$Z']")
    echo "$SUM  $ZIP" | sha256sum -c --quiet -
    rm -rf "$B/node_modules/electron/dist"
    7z x -o"$B/node_modules/electron/dist" "$ZIP" >/dev/null
    echo electron > "$B/node_modules/electron/path.txt"
  fi
fi

# Native audio engine (juce.node replacement)
(cd "$ROOT/native" && ln -sfn ../build/node_modules node_modules && \
  ../build/node_modules/.bin/node-gyp rebuild --target=32.3.3 --arch=x64 \
    --dist-url=https://electronjs.org/headers >/dev/null)

"$ROOT/scripts/stage.sh"
(cd "$B" && ./node_modules/.bin/electron-builder --config electron-builder.yml --linux AppImage)
ls -la "$ROOT"/dist/*.AppImage
