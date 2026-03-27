# Inkstone-Anki

Chinese character flashcard app with Anki SM-2 spaced repetition, stroke recognition, and offline support.

## Build

- Meteor 1.4.1.3 compiles `client/` → JS bundle. Build via Docker (see Dockerfile stage 1).
- `www/` contains the pre-built web assets served by Capacitor.
- `npx cap sync android` copies `www/` to Android assets.
- Android APK: `cd android && ./gradlew assembleDebug`
- WASM scheduler: `cd rust/anki-scheduler && wasm-pack build --target web --out-dir pkg`
  - After build, copy `pkg/anki_scheduler_bg.wasm` to `public/wasm/` and `www/wasm/`

## Testing

- `npm test` — runs all tests (unit + browser E2E)
- `node scripts/test-wasm-scheduler.cjs` — Anki WASM scheduler tests (44 cases)
- `node scripts/test-anki-e2e.cjs` — browser E2E with Anki scheduler
- `node scripts/test-browser-e2e.cjs` — basic browser E2E (draw character, complete session)
- Rust tests: `cd rust/anki-scheduler && cargo test`

## Versioning

Version is tracked in these locations (keep in sync):
- `package.json` → `"version"` field
- `android/app/build.gradle` → `versionCode` (integer) and `versionName`
- `client/templates/main/layout.html` → `<div class="version">` (displayed on home screen)
- `lib/version.js` → `BUILD_DATE` constant (auto-generated, shown on home screen)

The home screen displays the version and build date/hour. `lib/version.js` is regenerated
by `scripts/stamp-version.sh` which should be run before each build.

## Architecture

- `client/model/vocabulary.js` — card data with Anki state (8-column schema)
- `client/model/timing.js` — session management, card selection
- `client/external/anki/` — WASM scheduler loader + adapter
- `rust/anki-scheduler/` — vendored Anki SM-2 states from ankitects/anki, compiled to WASM
- `client/external/inkren/` — old Skritter algorithm (deprecated, still in bundle until rebuild)
