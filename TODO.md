# Inkstone Modernization TODO

## Done
- [x] Remove Crosswalk (dead project, repo offline)
- [x] Fix Docker build (TLS certs, remove unavailable SDK packages)
- [x] Cherry-pick stroke warnings ("Already drawn!", "Out of order!") + implement `handwriting.warn()`
- [x] Reduce session duration from 12h to 10min
- [x] Write smoke test script (`scripts/smoke-test.sh`) — 16/16 green
- [x] Bundle character data in APK (99 files, 37MB, 9574 characters) — no more hours-long download
- [x] Modify readCharacter() to read from bundled characters_v2/ NDJSON files with caching
- [x] Create Capacitor project (targetSdkVersion 36, minSdkVersion 24)
- [x] Replace Cordova File API with fetch() + localStorage in client/assets.js
- [x] Replace HTTP.get() with native fetch() in lib/base.js
- [x] Remove cordova.fireWindowEvent keyboard shim
- [x] Guard server-only Npm.require() calls to prevent client-side crashes
- [x] Remove cordova.js script tag from www/index.html (post-build)
- [x] Multi-stage Dockerfile: Meteor web build → Capacitor Android build
- [x] App loads without JS errors in headless browser test

## Skipped cherry-picks
- [ ] Wiktionary display (commit 7463b5d1) — needs etymology.wiktionary in character data
- [ ] Remove onClick on canvas (commit 7ed3497b) — minor UX change

## Still TODO: Play Store readiness
- [ ] Test on actual device (emulator needs KVM, or use a real phone with `adb install`)
- [ ] APK signing + switch to AAB (Android App Bundle)
- [ ] Adaptive icons (required since SDK 26) — currently uses Capacitor defaults
- [ ] Scoped storage (may not need permissions with bundled data + localStorage)
- [ ] Version bump to 0.2.0 in capacitor.config.json
- [ ] Update GitHub Actions to use new multi-stage Dockerfile
- [ ] Play Store listing update
