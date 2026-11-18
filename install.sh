#!/usr/bin/env bash
# Qobuz for Linux installer.
#
# Downloads the official Qobuz Windows installer from Qobuz, swaps its
# Windows-only parts for Linux ones, builds an AppImage locally and installs it
# for the current user (no root needed):
#
#   ~/.local/opt/qobuz-linux/Qobuz.AppImage
#   ~/.local/bin/qobuz                              (launcher symlink)
#   ~/.local/share/applications/qobuz-linux.desktop
#   ~/.local/share/icons/hicolor/256x256/apps/qobuz-linux.png
#
# Options:
#   --installer PATH   use an already-downloaded Qobuz_Installer.exe
#   --no-sandbox       add --no-sandbox to the launcher (needed on distros that
#                      restrict unprivileged user namespaces, e.g. Ubuntu 24.04+)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

NO_SANDBOX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --installer) export QOBUZ_INSTALLER="$(realpath "$2")"; shift 2 ;;
    --no-sandbox) NO_SANDBOX=" --no-sandbox"; shift ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
done

[ "$(uname -m)" = x86_64 ] || { echo "Only x86_64 is supported."; exit 1; }

missing=()
for c in curl 7z node npm python3 make g++ sha256sum; do
  command -v "$c" >/dev/null || missing+=("$c")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing build dependencies: ${missing[*]}"
  echo "  Debian/Ubuntu: sudo apt install curl p7zip-full nodejs npm python3 build-essential"
  echo "  Fedora:        sudo dnf install curl p7zip p7zip-plugins nodejs npm python3 gcc-c++ make"
  echo "  Arch:          sudo pacman -S curl 7zip nodejs npm python base-devel"
  exit 1
fi
node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' \
  || { echo "Node.js 18 or newer is required."; exit 1; }

# Auto-detect the user-namespace restriction if not specified.
if [ -z "$NO_SANDBOX" ] && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  echo "Note: unprivileged user namespaces are restricted on this system; launching with --no-sandbox."
  NO_SANDBOX=" --no-sandbox"
fi

echo "==> Building (first run downloads ~150 MB from Qobuz and ~100 MB of Electron tooling)"
rm -f "$ROOT"/dist/*.AppImage
"$ROOT/scripts/build-appimage.sh"
APPIMAGE="$(ls "$ROOT"/dist/*.AppImage | head -1)"

echo "==> Installing"
OPT="$HOME/.local/opt/qobuz-linux"
BIN="$HOME/.local/bin"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/256x256/apps"
mkdir -p "$OPT" "$BIN" "$APPS" "$ICONS"

install -m 0755 "$APPIMAGE" "$OPT/Qobuz.AppImage"
cat > "$OPT/qobuz" <<EOF
#!/bin/sh
exec "$OPT/Qobuz.AppImage"$NO_SANDBOX "\$@"
EOF
chmod 0755 "$OPT/qobuz"
ln -sfn "$OPT/qobuz" "$BIN/qobuz"

# Icon from the downloaded Qobuz app, scaled to 256px by Electron itself.
"$ROOT/build/node_modules/electron/dist/electron" --no-sandbox --headless \
  "$ROOT/scripts/make-icon.js" "$ROOT/upstream/app/static/icons/prod/icon.png" "$ICONS/qobuz-linux.png" \
  >/dev/null 2>&1 || cp "$ROOT/upstream/app/static/icons/prod/icon.png" "$ICONS/qobuz-linux.png"

cat > "$APPS/qobuz-linux.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Qobuz
Comment=Hi-res music streaming (unofficial Linux build)
Exec=$OPT/qobuz %U
Icon=qobuz-linux
Terminal=false
Categories=AudioVideo;Audio;Player;
MimeType=x-scheme-handler/qobuzapp;
StartupWMClass=Qobuz
EOF
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

echo
echo "Installed. Launch \"Qobuz\" from your app menu, or run: qobuz"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "(add $BIN to your PATH to use the 'qobuz' command)";; esac
echo "Uninstall with: $ROOT/uninstall.sh"
