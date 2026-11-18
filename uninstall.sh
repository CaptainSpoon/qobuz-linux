#!/usr/bin/env bash
# Remove what install.sh installed. Settings and login (~/.config/Qobuz) are
# kept unless --purge is given.
set -euo pipefail
rm -rf "$HOME/.local/opt/qobuz-linux"
rm -f "$HOME/.local/bin/qobuz" \
      "$HOME/.local/share/applications/qobuz-linux.desktop" \
      "$HOME/.local/share/icons/hicolor/256x256/apps/qobuz-linux.png"
command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
if [ "${1:-}" = --purge ]; then
  rm -rf "$HOME/.config/Qobuz" "${XDG_CACHE_HOME:-$HOME/.cache}/qobuz-linux"
  echo "Removed Qobuz for Linux, its settings and download cache."
else
  echo "Removed Qobuz for Linux (settings kept in ~/.config/Qobuz; use --purge to remove)."
fi
