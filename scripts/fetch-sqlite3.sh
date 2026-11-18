#!/usr/bin/env bash
# Fetch the official sqlite3 5.1.7 N-API linux-x64 prebuild (the Qobuz app
# ships the Windows build of the same version).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="https://github.com/TryGhost/node-sqlite3/releases/download/v5.1.7/sqlite3-v5.1.7-napi-v6-linux-x64.tar.gz"
SHA256="c9bd0419f77efb3b5d3a691fda04e265f740ad8dc195f0b56003cdeac92e9a34"
OUT="$ROOT/vendor/node_sqlite3.node"

if [ -f "$OUT" ] && echo "$SHA256  $OUT" | sha256sum -c --quiet - 2>/dev/null; then
  exit 0
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL --retry 3 "$URL" | tar xz -C "$TMP"
echo "$SHA256  $TMP/build/Release/node_sqlite3.node" | sha256sum -c --quiet -
mkdir -p "$ROOT/vendor"
mv "$TMP/build/Release/node_sqlite3.node" "$OUT"
echo "fetched: $OUT"
