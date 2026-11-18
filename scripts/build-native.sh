#!/usr/bin/env bash
# Build the native audio engine (juce.node replacement) against Electron 32.3.3.
#
# node-gyp's silly/verbose logging includes a dump of the full process
# environment (which can contain tokens and other secrets). @electron/node-gyp
# 10.2.0-electron.1 prints every level regardless of --loglevel (its
# isVisible() returns -1, which is truthy), so those lines are dropped from
# the stream before anything is written. The rest goes to
# native/build-native.log (mode 600); on failure the error lines are shown.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/native/build-native.log"

cd "$ROOT/native"
ln -sfn ../build/node_modules node_modules
( umask 077; : > "$LOG" )
if ! ../build/node_modules/.bin/node-gyp rebuild --loglevel=error --target=32.3.3 --arch=x64 \
       --dist-url=https://electronjs.org/headers 2>&1 \
     | { grep -vE '^gyp (sill|verb) ' || true; } >>"$LOG"; then
  echo "Native addon build failed. Errors:" >&2
  grep -E 'error|Error|ERR!' "$LOG" | head -40 >&2 || true
  echo "(full log: $LOG)" >&2
  exit 1
fi
echo "built: $ROOT/native/build/Release/qobuz_audio.node"
