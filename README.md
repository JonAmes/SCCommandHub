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

## Local data

Accounts, trades, routes, crew, hangar, and mining records are stored on the device. They are not synchronized between installations or platforms.
