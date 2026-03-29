#!/usr/bin/env node
/**
 * Unit tests for client/external/anki/adapter.js
 *
 * Bundles the ES-module source with mocked Meteor dependencies using esbuild,
 * then tests all branches of reconstructState() and getSchedulingResult().
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const ADAPTER_SRC = path.join(ROOT, 'client/external/anki/adapter.js');
const WASM_CJS = path.join(ROOT, 'rust/anki-scheduler/pkg-node/anki_scheduler.js');

let passed = 0, failed = 0;
const pass = (msg) => { passed++; console.log(`  ✓ ${msg}`); };
const fail = (msg) => { failed++; console.error(`  ✗ ${msg}`); };
const assert = (cond, msg) => cond ? pass(msg) : fail(msg);

// ─── Mock file content ────────────────────────────────────────────────────────

// Mock scheduler — wraps real WASM but can be disabled/broken via global flags.
const MOCK_SCHEDULER = `
'use strict';
const _wasm = require(${JSON.stringify(WASM_CJS)});
exports.nextStates = function(state, config) {
  if (global.__testAnkiDisabled) return null;
  if (global.__testAnkiEmptyStates) return {};  // missing all rating keys
  const s = typeof state === 'string' ? state : JSON.stringify(state);
  const c = typeof config === 'string' ? config : JSON.stringify(config);
  const r = JSON.parse(_wasm.next_states(s, c));
  if (r.error) { console.error('Anki error:', r.error); return null; }
  return r;
};
exports.intervalSecs = function(state, secs) {
  if (global.__testAnkiDisabled) return 0;
  const s = typeof state === 'string' ? state : JSON.stringify(state);
  return _wasm.interval_secs(s, secs || 43200);
};
`;

// Mock settings — returns defaults, overridable via global.__testSettingsOverrides.
const MOCK_SETTINGS = `
'use strict';
const _defaults = {
  learn_steps: '1 10', relearn_steps: '10',
  graduating_interval_good: 1, graduating_interval_easy: 4,
  starting_ease: 250, hard_multiplier: 120, easy_multiplier: 130,
  interval_multiplier: 100, maximum_review_interval: 36500,
  lapse_multiplier: 0, minimum_lapse_interval: 1, leech_threshold: 8,
};
exports.Settings = {
  get: function(key) {
    const ov = global.__testSettingsOverrides || {};
    return Object.prototype.hasOwnProperty.call(ov, key) ? ov[key] : _defaults[key];
  },
};
`;

// ─── Build bundle ─────────────────────────────────────────────────────────────

// Bundles must live inside the project root so c8 can track them for coverage.
const BUNDLES_DIR = path.join(ROOT, '.test-bundles');
fs.mkdirSync(BUNDLES_DIR, { recursive: true });
const MOCK_DIR = path.join(os.tmpdir(), 'adapter-mocks-' + process.pid);
fs.mkdirSync(MOCK_DIR, { recursive: true });
const SCHED_MOCK = path.join(MOCK_DIR, 'scheduler.js');
const SETT_MOCK  = path.join(MOCK_DIR, 'settings.js');
fs.writeFileSync(SCHED_MOCK, MOCK_SCHEDULER);
fs.writeFileSync(SETT_MOCK, MOCK_SETTINGS);

const BUNDLE = path.join(BUNDLES_DIR, 'adapter-bundle.cjs');

async function buildAndTest() {
  const plugin = {
    name: 'meteor-mocks',
    setup(build) {
      // Redirect Meteor module imports to mocks
      build.onResolve({ filter: /^\/client\/external\/anki\/scheduler$/ },
        () => ({ path: SCHED_MOCK }));
      build.onResolve({ filter: /^\/client\/model\/settings$/ },
        () => ({ path: SETT_MOCK }));
      // Mark the WASM package as external so __dirname stays correct
      build.onResolve({ filter: /anki_scheduler\.js$/ },
        (args) => ({ path: args.path, external: true }));
    },
  };

  await esbuild.build({
    entryPoints: [ADAPTER_SRC],
    bundle: true,
    format: 'cjs',
    outfile: BUNDLE,
    platform: 'node',
    plugins: [plugin],
    sourcemap: 'inline',
    logLevel: 'error',
  });

  const adapter = require(BUNDLE);
  const { getSchedulingResult } = adapter;

  const kOneDay = 86400;

  console.log('=== adapter.js Unit Tests ===\n');

  // ── buildConfig / parseSteps ────────────────────────────────────────────────

  console.log('[1] buildConfig — parseSteps with invalid inputs');
  // parseSteps is exercised inside getSchedulingResult via buildConfig.
  // Pass null / empty settings to hit the !s || typeof s !== 'string' branch.
  global.__testSettingsOverrides = { learn_steps: null, relearn_steps: 42 };
  {
    const item = { word: '一', last: null, next: null, attempts: 0, successes: 0, failed: false, ankiState: null };
    const r = getSchedulingResult(item, 1, 1000000);
    assert(typeof r.interval === 'number', 'parseSteps null/invalid → no crash, returns interval');
  }
  global.__testSettingsOverrides = null;

  console.log('\n[2] reconstructState — New (no attempts, no ankiState)');
  {
    const item = { word: '一', last: null, next: null, attempts: 0, successes: 0, failed: false, ankiState: null };
    const r = getSchedulingResult(item, 1, 1000000); // Good on New card
    assert(r.ankiState && (r.ankiState.Learning || r.ankiState.Review), 'New → Learning or Review state');
  }

  console.log('\n[3] reconstructState — Legacy Review (attempts > 0, no ankiState, has last+next)');
  {
    const ts = 1000000;
    const item = {
      word: '一', last: ts - kOneDay, next: ts, attempts: 3, successes: 2, failed: false,
      ankiState: null,
    };
    const r = getSchedulingResult(item, 1, ts);
    assert(r.ankiState !== null, 'legacy card → gets ankiState after update');
  }

  console.log('\n[4] reconstructState — Legacy: item.last && item.next > item.last === false → scheduled_days=1');
  {
    const ts = 1000000;
    // item.last is null → falls into scheduled_days = 1 fallback
    const item = {
      word: '一', last: null, next: null, attempts: 1, successes: 1, failed: false,
      ankiState: null,
    };
    const r = getSchedulingResult(item, 1, ts);
    assert(typeof r.interval === 'number', 'no-last legacy → handled (interval is number)');
  }

  console.log('\n[5] reconstructState — Review state with item.last (inject elapsed_days)');
  {
    const ts = 1000000;
    const item = {
      word: '二', last: ts - 2 * kOneDay, next: ts,
      attempts: 2, successes: 2, failed: false,
      ankiState: { Review: { scheduled_days: 2, elapsed_days: 0, ease_factor: 2.5, lapses: 0, leeched: false } },
    };
    const r = getSchedulingResult(item, 1, ts);
    assert(r.ankiState !== null, 'Review with last → updated state');
  }

  console.log('\n[6] reconstructState — Review state without item.last (use scheduled_days)');
  {
    const ts = 1000000;
    const item = {
      word: '二', last: null, next: ts,
      attempts: 1, successes: 1, failed: false,
      ankiState: { Review: { scheduled_days: 1, elapsed_days: 0, ease_factor: 2.5, lapses: 0, leeched: false } },
    };
    const r = getSchedulingResult(item, 1, ts);
    assert(r.ankiState !== null, 'Review without last → updated state');
  }

  console.log('\n[7] reconstructState — Learning state with item.last (inject elapsed_secs)');
  {
    const ts = 1000000;
    const item = {
      word: '三', last: ts - 30, next: ts,
      attempts: 1, successes: 0, failed: true,
      ankiState: { Learning: { remaining_steps: 2, scheduled_secs: 60, elapsed_secs: 0 } },
    };
    const r = getSchedulingResult(item, 1, ts);
    assert(r.ankiState !== null, 'Learning with last → updated state');
  }

  console.log('\n[8] reconstructState — Learning state without item.last (elapsed_secs = 0)');
  {
    const ts = 1000000;
    const item = {
      word: '三', last: null, next: null,
      attempts: 1, successes: 0, failed: true,
      ankiState: { Learning: { remaining_steps: 2, scheduled_secs: 60, elapsed_secs: 0 } },
    };
    const r = getSchedulingResult(item, 1, ts);
    assert(r.ankiState !== null, 'Learning without last → updated state');
  }

  console.log('\n[9] reconstructState — Relearning state with item.last');
  {
    const ts = 1000000;
    const item = {
      word: '四', last: ts - 30, next: ts,
      attempts: 5, successes: 4, failed: true,
      ankiState: {
        Relearning: {
          learning: { remaining_steps: 1, scheduled_secs: 600, elapsed_secs: 0 },
          review: { scheduled_days: 1, elapsed_days: 0, ease_factor: 2.3, lapses: 1, leeched: false },
        },
      },
    };
    const r = getSchedulingResult(item, 1, ts);
    assert(r.ankiState !== null, 'Relearning with last → updated state');
    assert(typeof r.interval === 'number', 'Relearning → numeric interval');
  }

  console.log('\n[10] reconstructState — Relearning state without item.last');
  {
    const ts = 1000000;
    const item = {
      word: '四', last: null, next: null,
      attempts: 5, successes: 4, failed: true,
      ankiState: {
        Relearning: {
          learning: { remaining_steps: 1, scheduled_secs: 600, elapsed_secs: 0 },
          review: { scheduled_days: 1, elapsed_days: 0, ease_factor: 2.3, lapses: 1, leeched: false },
        },
      },
    };
    const r = getSchedulingResult(item, 1, ts);
    assert(r.ankiState !== null, 'Relearning without last → updated state');
  }

  console.log('\n[11] reconstructState — Unknown/passthrough ankiState');
  {
    const ts = 1000000;
    // An unrecognized state shape (New with position — should pass through as-is)
    const item = {
      word: '五', last: null, next: null,
      attempts: 0, successes: 0, failed: false,
      ankiState: { New: { position: 5 } },
    };
    const r = getSchedulingResult(item, 1, ts);
    // New state → scheduler will process it
    assert(r.ankiState !== null || r.interval > 0, 'passthrough New state handled');
  }

  console.log('\n[12] getSchedulingResult — WASM not loaded (fallback intervals)');
  {
    global.__testAnkiDisabled = true;
    try {
      const ts = 1000000;
      const item = { word: '一', last: null, next: null, attempts: 0, successes: 0, failed: false, ankiState: null };
      const r0 = getSchedulingResult(item, 0, ts); // easy
      const r1 = getSchedulingResult(item, 1, ts); // good
      const r2 = getSchedulingResult(item, 2, ts); // hard
      const r3 = getSchedulingResult(item, 3, ts); // again
      assert(r0.interval === 28 * kOneDay, `fallback easy=${r0.interval} (expected ${28*kOneDay})`);
      assert(r1.interval === 7 * kOneDay,  `fallback good=${r1.interval} (expected ${7*kOneDay})`);
      assert(r2.interval === kOneDay,       `fallback hard=${r2.interval} (expected ${kOneDay})`);
      assert(r3.interval === 600,           `fallback again=${r3.interval} (expected 600)`);
      assert(r0.ankiState === null, 'fallback: ankiState null');
      assert(r3.failed === true,  'fallback: result>=3 → failed=true');
      assert(r0.failed === false, 'fallback: result<3 → failed=false');
    } finally {
      global.__testAnkiDisabled = false;
    }
  }

  console.log('\n[13] getSchedulingResult — unknown result value (fallback to again)');
  {
    // result=99 → kRatingMap[99] is undefined → ratingName = 'again'
    // states['again'] exists, so no error path triggered
    const ts = 1000000;
    const item = { word: '一', last: null, next: null, attempts: 0, successes: 0, failed: false, ankiState: null };
    const r = getSchedulingResult(item, 99, ts);
    // 'again' on New → should yield a Learning state
    assert(typeof r.interval === 'number', 'unknown result → fallback to again, returns interval');
  }

  console.log('\n[14] getSchedulingResult — all 4 ratings on a graduated card');
  {
    const ts = 1000000;
    const reviewItem = {
      word: '二', last: ts - kOneDay, next: ts,
      attempts: 3, successes: 3, failed: false,
      ankiState: { Review: { scheduled_days: 1, elapsed_days: 1, ease_factor: 2.5, lapses: 0, leeched: false } },
    };
    const easy = getSchedulingResult(reviewItem, 0, ts);
    const good = getSchedulingResult(reviewItem, 1, ts);
    const hard = getSchedulingResult(reviewItem, 2, ts);
    const again = getSchedulingResult(reviewItem, 3, ts);
    assert(easy.interval > good.interval, `easy(${easy.interval}) > good(${good.interval})`);
    assert(good.interval > hard.interval, `good(${good.interval}) > hard(${hard.interval})`);
    assert(hard.interval > 0, `hard interval > 0`);
    assert(again.failed === true, 'again on review → failed=true (relearning)');
    assert(easy.failed === false, 'easy on review → failed=false');
  }

  console.log('\n[15] reconstructState — Legacy: item.successes missing (|| 0 fallback) + Math.max(0, negative)');
  {
    const ts = 1000000;
    // Case A: successes intentionally omitted → (item.successes || 0) = 0
    const item = {
      word: '六', last: ts - kOneDay, next: ts,
      attempts: 2, failed: false, ankiState: null, // successes intentionally omitted
    };
    const r = getSchedulingResult(item, 1, ts);
    assert(typeof r.interval === 'number', 'missing successes → no crash');
    // Case B: successes > attempts → lapses would be negative → Math.max(0, -n) = 0
    const item2 = {
      word: '七', last: ts - kOneDay, next: ts,
      attempts: 1, successes: 3, failed: false, ankiState: null,
    };
    const r2 = getSchedulingResult(item2, 1, ts);
    assert(typeof r2.interval === 'number', 'successes > attempts → no crash (lapses clamped to 0)');
  }

  console.log('\n[16] getSchedulingResult — WASM disabled, result out of range (fallbackIntervals[n] || 600)');
  {
    global.__testAnkiDisabled = true;
    try {
      const ts = 1000000;
      const item = { word: '一', last: null, next: null, attempts: 0, successes: 0, failed: false, ankiState: null };
      const r = getSchedulingResult(item, 99, ts); // 99 not in fallbackIntervals → || 600
      assert(r.interval === 600, `out-of-range result → fallback 600s (got ${r.interval})`);
    } finally {
      global.__testAnkiDisabled = false;
    }
  }

  console.log('\n[17] getSchedulingResult — WASM returns empty states (missing rating key — lines 151-153)');
  {
    global.__testAnkiEmptyStates = true;
    try {
      const ts = 1000000;
      const item = { word: '一', last: null, next: null, attempts: 0, successes: 0, failed: false, ankiState: null };
      const r = getSchedulingResult(item, 0, ts); // 'easy' not in {} → !newState error path
      assert(r.interval === 600, `invalid state → fallback 600s (got ${r.interval})`);
      assert(r.ankiState === null, 'invalid state → ankiState null');
      assert(r.failed === true, 'invalid state → failed=true');
    } finally {
      global.__testAnkiEmptyStates = false;
    }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

buildAndTest().catch((e) => { console.error(e); process.exit(1); });
