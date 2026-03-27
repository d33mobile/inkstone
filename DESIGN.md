# Design Decisions

## Anki SM-2 Scheduler (2026-03)

**Choice**: Vendor Anki's Rust SM-2 state machine, compile to WASM.
**Why**: User wanted the exact same SRS code as AnkiDroid, not a port or third-party library. The `fsrs` crate (Anki's new algorithm) depends on `burn` ML framework which doesn't compile to WASM. The SM-2 state machine in `rslib/src/scheduler/states/` is self-contained — pure math, no heavy deps.
**Source**: `github.com/ankitects/anki` @ main, AGPL v3. FSRS branches stripped, SM-2 paths only.
**Result**: 107KB WASM, 8 Rust tests + 44 JS integration tests + 31 session simulation tests.

## Runtime patching (2026-03)

**Choice**: Monkey-patch the old Meteor bundle at runtime instead of rebuilding.
**Why**: Meteor 1.4.1.3 requires Node 4.x and a Docker-based build. The `www/` bundle is pre-built. Runtime patching via `require()` + module override is faster to iterate and test.
**How**: `www/inkstone-model.js` (compiled from `src/`) loads WASM and overrides `Vocabulary.updateItem`. Hooks `getNextInterval` temporarily during each call.
**Limitation**: ankiState written to localStorage via setTimeout(50ms) after Meteor.defer — slight race window.

## TypeScript rewrite (2026-03, planned)

**Choice**: Vite + Preact + TypeScript, replacing Meteor + Blaze.
**Why Vite**: Already use esbuild (Vite uses it internally). Dev server with HMR. SCSS native. Capacitor-friendly (`build.outDir: 'www'`). Tiny config.
**Why Preact**: 3KB, JSX, React-compatible API. Signals for reactivity replace Meteor's Tracker/ReactiveVar. Huge ecosystem.
**Why not raw esbuild**: No dev server, no HMR, more manual wiring for SCSS and multi-file projects.
**Why not Svelte**: Less mainstream, smaller ecosystem. Preact's React compatibility is valuable for libraries.
**Why not vanilla TS**: Too much manual DOM wiring for the template-heavy UI.

## Versioning (2026-03)

**Choice**: `scripts/stamp-version.sh` generates `lib/version.js` with BUILD_DATE and BUILD_VERSION globals.
**Why**: Meteor 1.4 can't import JSON or use env vars at build time. Globals injected before the bundle in `www/index.html`. Version displayed on home screen.
**Locations to sync**: `package.json`, `android/app/build.gradle`, `lib/version.js`, home screen template.

## Character data format (pre-existing)

**Choice**: NDJSON files in `www/assets/characters_v2/{codepoint}.json`, chunked by Unicode code point ranges (256 chars per file).
**Why**: Bundled in APK for offline use. Chunked to avoid loading all 9574 characters at once. NDJSON for streaming parse.
