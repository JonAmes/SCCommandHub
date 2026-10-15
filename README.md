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

On the desktop, open Settings and start the primary listener. Share the displayed HTTPS URL and the six-digit pairing code (valid for two minutes) only with the intended client. The client enters both values and requests pairing; approve that request on the primary. Paired client credentials live for 24 hours on that client, while the primary keeps them in memory and clears them when its listener stops. Once paired, the client uploads its local app data to the primary. “Uploaded for review” means the primary still needs to approve the merge. The primary remains canonical and never sends its data back to clients.

Sync includes accounts, ledger, hangar/cargo, crew, routes, mining records, Game.log events, market history, and selected preferences. UEX tokens, Star Citizen install paths, and pairing credentials are not part of sync snapshots. Pair credentials are stored locally on each client for up to 24 hours; stopping the primary clears its paired clients, so they must pair again after restart. The primary keeps account-conflict values and remaps incoming ledger references where possible. Pending Game.log transactions remain pending on the primary for account assignment and confirmation.

## Local data

Accounts, trades, routes, crew, hangar, and mining records are stored on the device. They are not synchronized between installations or platforms.

## Game.log integration

The Windows/Linux desktop app can monitor the selected LIVE or PTU installation's `Game.log`. Successful UEC shop transactions appear as pending Finance activity and do not affect an account balance until an account is selected and the event is confirmed. Dismissing an event leaves the ledger unchanged.

When a local ship-control record appears, a missing ship is added to the hangar using UEX specifications when available, or a zero-capacity placeholder when they are not. The sample log records this when local control is released, so ship detection can be delayed until leaving the ship. Game files are read-only. The web and mobile apps remain usable without a detected installation but cannot monitor local files.
