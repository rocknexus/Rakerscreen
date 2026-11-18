# Rakerscreen

A KlipperScreen look-alike for Android, for phones that run the Klipper host themselves
(Klip Pocket, Beam Klipper, Kocoa Beam). It is a native APK; no X server, VNC or second computer.
(Formerly PocketScreen. The Android package id stays `com.pocketscreen.app`, so Rakerscreen installs
over PocketScreen and keeps its settings.)

```
Android phone
  Rakerscreen.apk                              Klip Pocket (Beam)
  WebView UI -> PSBridge -> native WebSocket --ws://127.0.0.1:7125--> Moonraker -> Klippy
                                     (loopback, never leaves the phone)              |
                                                                  USB OTG serial (Klip Pocket)
                                                                                     |
                                                                               Printer MCU
```

## "Local communication through USB": what actually applies

- The phone's USB port is already taken: Klip Pocket uses it in OTG host mode to talk serial to the
  printer's MCU. Android gives that USB device to one app at a time, so the UI app must not touch USB.
- The UI and Klipper run on the **same device**, so the UI only needs to reach Moonraker, and it does
  that over the **loopback interface (127.0.0.1)**. Loopback traffic never leaves the phone and works
  with Wi‑Fi off. It is the only IPC path Klip Pocket exposes to other apps; its Unix sockets live in
  its private app sandbox and can't be opened from another app.
- The UI is loaded from `file:///android_asset`, so the WebView's own WebSocket would send
  `Origin: null`, which Moonraker rejects unless you edit `cors_domains`. Rakerscreen instead uses a
  small native WebSocket client (`MiniWebSocket.java`) that sends no Origin header, which Moonraker
  allows, and that can send `X-Api-Key`.

## Install

1. Download the latest `Rakerscreen-v*.apk` from
   [Releases](https://github.com/rocknexus/Rakerscreen/releases/latest), open it on the phone (or run
   `adb install`), and allow "install unknown apps" for your browser or file manager.
2. Start Klip Pocket first and let it bring Klipper up.
3. Open Rakerscreen. It connects to `127.0.0.1:7125` by default. If Klip Pocket's Moonraker uses
   another port, tap **Menu** on the splash screen (or **More → Rakerscreen** later) and change the
   port, then tap **Connect**. Beam's web UI is on 8888; Moonraker's default port is 7125.
4. In Android settings, set **Battery → Unrestricted** for both apps, so Android doesn't kill Klipper
   while Rakerscreen is in the foreground.
5. If Moonraker asks for authorization (the error says "Unauthorized"), either add `127.0.0.1` to
   `trusted_clients` in Klip Pocket's moonraker config or paste an API key in settings.

### Updates

Rakerscreen checks this repository's latest release at startup and every 6 hours (Settings →
Updates turns that off; it never prompts during a print). **Update** downloads the APK and opens
Android's installer: allow "install unknown apps" for Rakerscreen the first time, then confirm
Android's "Update" screen. On Android 12+ later updates may install without that confirmation.
Klipper keeps running in Klip Pocket while Rakerscreen restarts. **System → Check for Updates** and
**Settings → Updates** check on demand.

Hardware tip: many phones won't charge while their port is in OTG host mode. Use an OTG Y-cable or a
powered OTG hub so the phone stays charged during long prints.

## What's implemented (mirrors KlipperScreen panels)

Splash/connection screen, main menu (heater list, temperature graph, numpad), More menu, Move (with
homing submenu, QGL/Z-tilt when available), Temperature (preheat presets, +/- deltas, PID/MPC
calibrate), Extrude (load/unload macros, filament sensors), Fan, Print file browser (thumbnails, folders,
sort, delete), Job Status (progress ring, time estimates using KlipperScreen's algorithm, pause, resume,
cancel, restart, save Z offset), Print Control menu, Fine Tuning (babystep, speed, flow), Macros (with
parameters), Console, Limits, Z Calibrate (probe/endstop + TESTZ), Camera (MJPEG), Notifications,
System, Shutdown, Settings. Also included: action bar (back, home, notification shortcut, E-stop while
printing), title bar temps, clock, phone battery, portrait layout, and hardware back button.

Settings (More → Rakerscreen) has KlipperScreen's full options list in the same categories:
Appearance, Printing, Display, Behaviour, Others, Printer Connections and Language. That includes all
five icon themes, screen power-off with DPMS (on Android it drops the backlight to minimum), wake
delay, the lock screen, and the action bar shortcut. Two extras: a second configurable action bar
button, and a lock password field. Leds and Lock panels are included too.

Not ported yet: bed mesh, bed level/screws, input shaper, spoolman, pins, power devices, Moonraker's
updater, network, pressure advance/retraction, multi-printer, translations (English only), and add-ons (shown
in settings but disabled, since Android can't load KlipperScreen's Python add-ons).

## Develop / rebuild

```
node tools/mock_moonraker.js          # simulated printer + serves web/ on http://127.0.0.1:7125
```
Open http://127.0.0.1:7125 in a desktop browser to work on the UI (it falls back to the browser's
WebSocket when `PSBridge` is absent).

```
powershell -ExecutionPolicy Bypass -File build.ps1   # -> releases/Rakerscreen-v<version>.apk (debug-signed)
```
To release a new version, bump `const VERSION` in `web/main.js`; the build derives the APK file name,
`versionName` and `versionCode` (major*10000 + minor*100 + patch) from it.
Needs the Android SDK (platform + build-tools) and a JDK 17+. Android Studio's bundled JBR is used by
default. Gradle isn't needed.

### Publishing a release

```
powershell -ExecutionPolicy Bypass -File tools/release.ps1 -Notes "What changed"
```
Builds, then creates GitHub release `v<version>` with the APK attached (needs the GitHub CLI, `gh`,
signed in). Installed apps pick it up on their next check.

**Signing key:** `pocketscreen-debug.keystore` is not in this repository (it's in `.gitignore`).
Every release must be signed with that same key, or installed apps refuse the update and users
must uninstall first. Keep a backup of it somewhere safe; if it is missing, `build.ps1` makes a new
key and the next release can no longer update existing installs.

Layout: `web/` holds the UI (core.js = Moonraker client and printer model; main.js = screen, navigation
and menus; panels.js = panels; keyboard.js = on-screen keyboard and the Input module; update.js =
self-update), `android/` holds the WebView shell, native WebSocket and installer, and `tools/` holds
the mock server and release script.

## License

The icons in `web/icons` and the visual design come from KlipperScreen (AGPL-3.0, see
`LICENSE-KlipperScreen`), so this derivative is distributed under AGPL-3.0 as well.
