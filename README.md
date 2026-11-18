# Qobuz for Linux (unofficial)

Runs the official Qobuz desktop app (Windows build 8.3.0-b028, Electron 32.3.3)
natively on Linux. Qobuz's UI and app logic run as-is; only the Windows-only
pieces are replaced, most importantly the `juce.node` audio engine, which is
reimplemented here on top of [miniaudio](https://miniaud.io) (PipeWire /
PulseAudio / ALSA).

> **This repository contains no Qobuz code.** The installer downloads the
> official Qobuz installer from `desktop.qobuz.com` on your machine, extracts
> it, applies the Linux patches and builds an AppImage locally. Don't
> redistribute the resulting AppImage. This is a community project, not
> affiliated with or endorsed by Qobuz. You need a Qobuz subscription.

## Install

Requires x86_64, Node.js ≥ 18 with npm, a C++ toolchain, Python 3, 7-Zip and curl.

```bash
# Debian/Ubuntu
sudo apt install curl p7zip-full nodejs npm python3 build-essential
# Fedora
sudo dnf install curl p7zip p7zip-plugins nodejs npm python3 gcc-c++ make
# Arch
sudo pacman -S curl 7zip nodejs npm python base-devel
```

Then download the latest installer from
[Releases](../../releases/latest), or clone the repo, and run:

```bash
tar xzf qobuz-linux-installer-*.tar.gz && cd qobuz-linux-installer-*   # if using the release tarball
./install.sh
```

This installs for the current user only (no root):
`~/.local/opt/qobuz-linux/`, a `qobuz` launcher in `~/.local/bin`, and a
"Qobuz" entry in your application menu.

Options:

- `./install.sh --installer ~/Downloads/Qobuz_Installer.exe` uses an installer you already downloaded
- `./install.sh --no-sandbox` for distros that restrict unprivileged user
  namespaces (detected automatically for Ubuntu's AppArmor setting)

Uninstall: `./uninstall.sh` (add `--purge` to also remove settings/login in `~/.config/Qobuz`).

## Troubleshooting

- Audio engine debug logging: `QOBUZ_AUDIO_DEBUG=1 qobuz`
- App log: `~/.config/Qobuz/logs/rapport_qobuz0.txt`

## What was changed

| Windows piece | Linux replacement |
|---|---|
| `juce.node` (JUCE + WASAPI/ASIO/DirectSound, V8-ABI, Windows-only) | `native/` — N-API addon using miniaudio (PulseAudio/PipeWire/ALSA, loaded at runtime) with built-in FLAC/MP3 decoders. Same JS API: `open`, `openStream`, `play`, `pause`, `status`, `offset`, `volume`, devices, `trackInformation`, `hasStreamFinished`, cache ranges, `clearNextTrack`/`switchToNext`. |
| `sqlite3` Windows binary | sqlite3 5.1.7 napi-v6 linux-x64 prebuild (`vendor/`) |
| `getDeviceType(){return"windows"}` | `"linux"` window-controls layout (already in Qobuz's code) |
| `setThumbarButtons` / `setThumbnailToolTip` | removed (Windows-only, would throw) |
| Squirrel auto-updater + UI hot-swap | disabled (no Squirrel; AppImage is read-only) |
| First-run "updating" window | skipped (same reason) |
| Tray icon loaded from `.ico` (blank on Linux) | 1024px PNG scaled to 32px, "Qobuz" tooltip |
| No window icon (generic taskbar icon) | PNG scaled to 256px (1024px overflows X11's `_NET_WM_ICON`) |
| Close button destroys the window and quits | close hides to tray; tray click or relaunching restores; tray "Quit" (or system shutdown) really quits |
| Login opened in system browser, `qobuzapp://` redirect handed back by the OS | sign-in opens in an in-app window; the `qobuzapp://` redirect is caught there and delivered via the app's own `open-url` channel (works even if another app, e.g. the qbz Flatpak, owns the scheme) |

Patches live in `patches/patches.js`; each must match the minified bundle
exactly once, so a new Qobuz version that moves the code fails loudly.

Native engine behaviour:
- Plays the progressively-downloaded buffer the JS hands it (decryption is
  already done in JS), blocking as `Blocked`/"Buffering" when it runs dry.
- Seeks into not-yet-downloaded HLS segments by pairing the time/byte ranges
  the JS records and re-starting the decoder at that segment.
- Gapless: at end of track it rolls into the prepared next track if the format
  matches; otherwise the device re-opens at the new rate on `switchToNext`.
- Opens the output at the track's native rate/channels (no app-side resampling;
  PipeWire/Pulse may still resample unless configured otherwise).

Patches live in `patches/patches.js`; each must match the minified bundle
exactly once, so a new Qobuz version that moves the code fails loudly.

Native engine behaviour:
- Plays the progressively-downloaded buffer the JS hands it (decryption is
  already done in JS), blocking as `Blocked`/"Buffering" when it runs dry.
- Seeks into not-yet-downloaded HLS segments by pairing the time/byte ranges
  the JS records and re-starting the decoder at that segment.
- Gapless: at end of track it rolls into the prepared next track if the format
  matches; otherwise the device re-opens at the new rate on `switchToNext`.
- Opens the output at the track's native rate/channels (no app-side resampling;
  PipeWire/Pulse may still resample unless configured otherwise).

## Build without installing

```bash
scripts/build-appimage.sh      # fetch Qobuz + sqlite3 -> addon -> dist/stage/app -> dist/*.AppImage
```

Pipeline: `scripts/fetch-upstream.sh` (installer → PE resource `DATA/131` →
`Qobuz-8.3.0-b028-full.nupkg` → `lib/net45/resources/app` → `upstream/app`),
`scripts/fetch-sqlite3.sh` (official sqlite3 5.1.7 napi-v6 linux-x64 prebuild),
then `scripts/stage.sh` (copies the app, drops in the Linux native modules, applies
`patches/`) and electron-builder.

Tests (run inside Electron's Node, after a build):
```bash
E=dist/linux-unpacked/qobuz; A=$PWD/dist/linux-unpacked/resources/app/juce.node
ELECTRON_RUN_AS_NODE=1 $E native/test/harness.js $A a.flac b-hires.flac
ELECTRON_RUN_AS_NODE=1 $E native/test/gapless.js $A a.flac
```

## Known gaps

- Tested with a real account (2026-11-18): sign-in, 16-bit/44.1 kHz and
  24-bit/96 kHz streaming, seeking (including into not-yet-downloaded HLS
  segments), gapless track transitions and the device re-opening at the
  track's native rate.
- No exclusive/bit-perfect ALSA `hw:` mode; output goes through the sound server.
- Device list: "System default" + sound-server sinks; device-change detection
  polls every ~3 s.
- No MPRIS/media-key integration beyond what Qobuz's own globalShortcut code does.
- External `qobuzapp://` links (from a browser) are declared in the .desktop
  entry but only reach this app once the AppImage is integrated into the desktop
  and set as the scheme's handler. Login does not depend on this.
- No auto-update. When Qobuz ships a new version, the patches may need updating; `install.sh` checks the installer checksum and the build fails loudly if a patch no longer matches.

## License

MIT for the code in this repository (see `LICENSE`). Qobuz is a trademark of
Xandrie SA; the Qobuz application is proprietary and is not distributed here.
