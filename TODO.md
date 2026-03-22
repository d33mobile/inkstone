# Inkstone Modernization TODO

## Done
- [x] Remove Crosswalk (dead project, repo offline)
- [x] Fix Docker build (TLS certs, remove unavailable SDK packages)
- [x] Cherry-pick stroke warnings ("Already drawn!", "Out of order!") + implement `handwriting.warn()`
- [x] Reduce session duration from 12h to 10min
- [x] Write smoke test script (`scripts/smoke-test.sh`)

## Skipped cherry-picks
- [ ] Wiktionary display (commit 7463b5d1) — requires `etymology.wiktionary` field in character data which doesn't exist in current dataset. Needs character data regeneration from d33tah/gh-pages branch data first.
- [ ] Remove onClick on canvas (commit 7ed3497b from moj_branch) — minor UX change, can add later

## Next: Bundle character data in APK
- [ ] Get makemeahanzi data (dictionary.txt + graphics.txt)
- [ ] Run `rebuildCharacterData()` to generate `characters_v2/` files
- [ ] Bundle the 256 character asset files in the APK (~35MB raw, ~15MB compressed)
- [ ] Modify `client/assets.js` readAsset() to read bundled chars via fetch() instead of Cordova File API
- [ ] Modify `client/templates/assets/code.js` to skip download when data is bundled
- [ ] Test: app launches without download prompt

## Next: Migrate Cordova → Capacitor
- [ ] Replace `Meteor.isCordova` checks with `!!window.Capacitor` detection
- [ ] Replace Cordova File API in `client/assets.js` with `@capacitor/filesystem`
- [ ] Replace `HTTP.get()` in `lib/base.js` with native `fetch()`
- [ ] Remove `cordova.fireWindowEvent` keyboard shim from `client/templates/main/code.js`
- [ ] Create Capacitor project wrapping the Meteor web bundle
- [ ] Configure `targetSdkVersion 34`, `compileSdkVersion 34`, `minSdkVersion 24`
- [ ] Build and test APK on API 34

## Next: Build system & Play Store
- [ ] New Dockerfile for Meteor + Capacitor + Android SDK 34
- [ ] New `scripts/build` combining Meteor web build + Capacitor Android build
- [ ] Switch from APK to AAB (Android App Bundle) for Play Store
- [ ] Set up signing with apksigner
- [ ] Update GitHub Actions
- [ ] Adaptive icons (required since SDK 26)
- [ ] Scoped storage permissions
- [ ] Version bump to 0.2.0
- [ ] Play Store listing update
