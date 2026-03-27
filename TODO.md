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

## Done (Anki integration, 2026-03)
- [x] Vendor Anki SM-2 scheduler from ankitects/anki Rust source
- [x] Compile to WASM (107KB), 8 Rust + 44 JS + 31 session tests pass
- [x] Runtime patch: monkey-patch Vocabulary.updateItem via WASM adapter
- [x] Vocabulary schema extended (7→8 cols, ankiState)
- [x] Settings UI for Anki algorithm params (learning steps, ease, intervals)
- [x] Version display on home screen (build date + version)
- [x] TypeScript model layer (src/anki/, src/index.ts) compiled with esbuild
- [x] Source-level timing.js fix: due learning cards get priority over reviews
- [x] Session simulation test (test-unit-session.cjs, 31 cases)

## TypeScript Rewrite (branch: typescript-rewrite)

### Phase 1: Scaffold
- [ ] Init Vite + Preact + TypeScript project
- [ ] Configure vite.config.ts (outDir: www, SCSS, WASM)
- [ ] Verify `npm run dev` serves empty app

### Phase 2: Core model
- [ ] persistence.ts — localStorage wrapper with Preact signals
- [ ] settings.ts, lists.ts, vocabulary.ts, timing.ts
- [ ] Port src/anki/ as-is

### Phase 3: Lib layer
- [ ] Convert lib/base.js, matcher/, animation, characters, decomposition to TS

### Phase 4: Components (Preact)
- [ ] Layout, Home, Teach (handwriting canvas), Lists, Settings, Help

### Phase 5: Styles
- [ ] Port SCSS, verify visual parity

### Phase 6: Integration
- [ ] WASM + Capacitor + Android build
- [ ] All tests pass

### Phase 7: Cleanup
- [ ] Remove client/, .meteor/, cordova-build-override/, old www bundles

## Known issues
- [ ] ankiState localStorage write has 50ms race (setTimeout after Meteor.defer)
- [ ] Learning card priority only works at source level, not in runtime patch

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
