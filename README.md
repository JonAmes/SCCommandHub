# SC Command Hub

A tool integrating data from Star Citizen APIs.

SC Command Hub runs as a web app, Windows/Linux desktop app, or native iOS/Android app. All platforms use the same React interface and UEX API integration.

## Requirements

- Node.js 20.19 or newer
- For Android: Android Studio with an Android SDK and JDK 21
- For iOS: macOS with Xcode installed

Install JavaScript dependencies with `npm install`.

## Run locally

```sh
npm run dev
```

## Screenshot Reader

Open **Mining & refining > Rock scan log** and choose **Image source**: **Primary screen** (the default), **Running apps**, or **Star Citizen**. Running apps reveals an **App window** selector listing available windows by title. Click **Capture screen** to start the selected source; changing a selection alone does not capture anything. You can also use **Load screenshot**, or **Take picture** on a detected mobile device. Drag the scan/cargo areas to adjust them and use **Read now** for another reading.

The reader uses a contrast-enhanced panel read and up to six label-anchored numeric retries using contrast and HUD-text filters. Warnings identify low confidence, conflicting numbers, missing data, and unmatched minerals. These are not guarantees of accuracy: small, compressed text and colored text over terrain can still require manual correction. Older HUD resistance values without a percent sign are kept as displayed; no unit conversion is inferred. Automatic filling skips uncertain reads, and nothing is saved or applied to cargo without confirmation. Recognition runs locally; the app downloads OCR assets on first use.

In the desktop app, Primary screen uses the operating system's actual primary monitor, not the first screen in the list. Running apps uses the exact selected window; Star Citizen uses a single identifiable game window. No choice is silently overridden by a running game or replaced with another screen when unavailable. Source lists refresh when opening the app selector and before capture. Stop a live capture before changing sources. Game identification uses its window title, not process inspection. Restart the desktop app after capture-handler updates.

In a browser, the normal sharing picker is required and you must choose the desired screen/window there; the app cannot enumerate running windows or enforce a particular monitor/game selection. Running apps enumeration is therefore desktop-only. Screenshot loading and mobile camera capture do not require desktop source enumeration.

Starting capture takes **four snapshots total**: one full-resolution frame to discover the panels, then three fresh snapshots cropped around their detected contents with a small margin. Discovery uses text headings and nearby measurement labels, not Example coordinates; it is bounded to two OCR preprocessing passes and a 3840-by-2160 working image. Each cropped snapshot is read separately. At least two must agree on a stable rock/composition or cargo totals before filling review; unresolved numeric fields remain blank rather than being averaged. Existing OCR warnings are retained because repeated agreement cannot rule out a systematic misread. Detected boxes stay temporary; explicit manual dragging retains the normal saved-area behavior.

The live preview stays active afterward. **Read now**, opt-in auto-fill, manual corrections, screenshot uploads, Example selection, and explicit save/cargo confirmation otherwise work as before. If discovery fails or frames stop arriving (for example, a minimized game), select the areas manually and use **Read now**, or restart capture. Changing source, stopping capture, changing areas, or resizing the captured window cancels obsolete automatic work. Some headerless/clipped panels cannot be detected, and colored text over terrain can still need correction. Star Citizen window capture should be checked in-game; synthetic stream tests cannot verify OS/game capture support.

Examples are now development/test fixtures only and are not bundled into the application or listed in Image source. Use Load screenshot to open one manually. Add dimensions, hand-annotated regions, and hand-checked values to `Examples/manifest.json` when extending accuracy tests. Fixture expected values are never substituted for recognition results. Ambiguous reference digits are omitted from scoring and documented in the fixture notes.

Run the fast parser checks and real screenshot regression separately (Node.js 22.18+ or 24 recommended for TypeScript test imports):

```sh
npm run test:ocr
npx playwright install chromium
npm run test:ocr:images
```

The image tests start and stop their own local Vite server, decode AVIF/PNG in Chromium, and use pinned local English language data without external network access. They compare exact recognized fields with hand-checked expectations, test full-frame panel discovery without preset coordinates, and verify four distinct frames through a simulated live stream. They also cover source fallback, review/edit safety, cancellation, and desktop/mobile overlays. `OCR_DEBUG=1` enables detailed recognition output. They do not claim every example is read perfectly. Inspect new fixture annotations visually before treating them as ground truth. Source-selection tests can be run separately with `node --test tests/screenCapture.test.mjs`.

## Desktop

Run the desktop app with Vite hot reload:

```sh
npm run desktop:dev
```

Build an installer for the current platform:

```sh
npm run desktop:build
```

Windows NSIS installer:

```sh
npm run desktop:build:win
```

Linux AppImage and Debian package:

```sh
npm run desktop:build:linux
```

Installers are written to `release/`. Build Windows installers on Windows and Linux installers on Linux. Release builds should be code-signed before distribution.

## Android

The Android project is included. Build and open it in Android Studio:

```sh
npm run mobile:android
```

In Android Studio, build an APK for device testing or a signed app bundle for Google Play. The `mobile:android` command rebuilds the web app and syncs it into the native project.

## iOS

The iOS project is included. On macOS, build and open it in Xcode:

```sh
npm run mobile:ios
```

Select an iOS simulator or configured device in Xcode to run the app. Installing on devices or distributing through the App Store requires Apple signing credentials and provisioning.

## Device sync

Device sync uses Tailscale Serve for an HTTPS address available only within your tailnet. Install and sign in to Tailscale on the primary Windows/Linux desktop and each client device. The desktop also needs the Tailscale CLI available to SC Command Hub, and Serve enabled for your tailnet. SC Command Hub binds its service to loopback and asks Tailscale Serve for HTTPS port `8443` at `/sc-command-hub-sync`; no public listener or relay is used.

On the desktop, open Settings and start the host. On the client, select **Auto detect hosts**, choose a detected host (a single result is selected automatically), then enter the six-digit pairing code shown on the host and request pairing. The host must still approve the request. Detection does not pair devices, upload data, or reveal pairing codes. If no host is found, the URL field appears automatically; **Enter URL manually** is also available at any time. Share the HTTPS URL and pairing code only with the intended client.

Desktop discovery checks up to 32 online Tailscale devices using their HTTPS MagicDNS addresses, verifies the Command Hub discovery response, and uses bounded timeouts and four parallel probes. Android/iOS discovery listens for the host's local-network Bonjour service (`_sc-command-hub._tcp`) and verifies its advertised Tailscale HTTPS address. Both devices still need Tailscale access. Mobile discovery works on the same local network; multicast generally does not cross remote Tailscale connections, isolated Wi-Fi networks, or blocked firewalls. In those cases use the URL fallback. Browser clients also use the URL fallback because they cannot enumerate Tailscale peers or local services.

While hosting, the desktop advertises only its endpoint/version on the local network; advertisements stop with the host. No pairing codes, tokens, snapshots, or game status are advertised. iOS requires Local Network permission; Android uses Wi-Fi/multicast permissions. After updating, restart the desktop app and rebuild/reinstall mobile apps after `npx cap sync` to include the native discovery plugin. A browser preview does not test native discovery. Actual Android/iOS multicast, Tailscale reachability, and native builds must be checked on devices/Xcode; iOS builds require macOS.

Paired client credentials live for 24 hours on that client, while the host keeps them in memory and clears them when its listener stops. Once paired, clients receive host data automatically and their changes are sent to the host for review before merging. Pairing-code expiry, host approval, and sync-data authentication remain unchanged.

Sync includes accounts, ledger, hangar/cargo, crew, routes, mining records, Game.log events, market history, and selected preferences. UEX tokens, Star Citizen install paths, and pairing credentials are not part of sync snapshots. Pair credentials are stored locally on each client for up to 24 hours; stopping the primary clears its paired clients, so they must pair again after restart. The primary keeps account-conflict values and remaps incoming ledger references where possible. Pending Game.log transactions remain pending on the primary for account assignment and confirmation.

## Local data

Accounts, trades, routes, crew, hangar, and mining records are stored on the device. They are not synchronized between installations or platforms.

## Game.log integration

The Windows/Linux desktop app can monitor the selected LIVE or PTU installation's `Game.log`. Successful UEC shop transactions appear as pending Finance activity and do not affect an account balance until an account is selected and the event is confirmed. Dismissing an event leaves the ledger unchanged.

When a local ship-control record appears, a missing ship is added to the hangar using UEX specifications when available, or a zero-capacity placeholder when they are not. The sample log records this when local control is released, so ship detection can be delayed until leaving the ship. Game files are read-only. The web and mobile apps remain usable without a detected installation but cannot monitor local files.
