# Inkstone Modernization TODO

## Done
- [x] Remove Crosswalk (dead project, repo offline)
- [x] Fix Docker build (TLS certs, remove unavailable SDK packages)
- [x] Cherry-pick stroke warnings ("Already drawn!", "Out of order!") + implement `handwriting.warn()`
- [x] Reduce session duration from 12h to 10min
- [x] Write smoke test script (`scripts/smoke-test.sh`)
- [x] Bundle character data in APK (99 files, 37MB, 9574 characters)
- [x] Modify readCharacter() to read from bundled characters_v2/ NDJSON files with caching
- [x] Skip asset download on startup (data is bundled, asset server is offline)
- [x] Create Capacitor project (targetSdkVersion 36, compileSdkVersion 36, minSdkVersion 24)
- [x] Build Capacitor Android APK (33MB debug)

## Skipped cherry-picks
- [ ] Wiktionary display (commit 7463b5d1) — requires `etymology.wiktionary` field in character data which doesn't exist in current dataset. Needs character data regeneration from d33tah/gh-pages branch data first.
- [ ] Remove onClick on canvas (commit 7ed3497b from moj_branch) — minor UX change, can add later

## Still TODO: Source code adaptation for Capacitor
- [ ] Replace `Meteor.isCordova` checks with Capacitor-compatible detection in `client/templates/main/code.js`
- [ ] Replace Cordova File API in `client/assets.js` with `@capacitor/filesystem` for user-writable data (custom lists in `lists/s/`, imported characters)
- [ ] Replace `HTTP.get()` in `lib/base.js` with native `fetch()`
- [ ] Remove `cordova.fireWindowEvent` keyboard shim from `client/templates/main/code.js`
- [ ] Test on actual device or emulator: handwriting canvas, card review, data persistence

## Still TODO: Build system & Play Store
- [ ] New Dockerfile for Meteor web build + Capacitor Android build
- [ ] New unified `scripts/build`
- [ ] Switch from APK to AAB (Android App Bundle) for Play Store
- [ ] Set up signing with apksigner or Play App Signing
- [ ] Update GitHub Actions
- [ ] Adaptive icons (required since SDK 26)
- [ ] Scoped storage permissions (may not need any with bundled data)
- [ ] Version bump to 0.2.0
- [ ] Play Store listing update
