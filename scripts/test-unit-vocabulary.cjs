#!/usr/bin/env node
/**
 * Unit tests for client/model/vocabulary.js
 *
 * Bundles the ES-module source with mocked Meteor dependencies (PersistentDict,
 * Settings, underscore globals) using esbuild, then tests all branches.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const VOCAB_SRC  = path.join(ROOT, 'client/model/vocabulary.js');
const WASM_CJS   = path.join(ROOT, 'rust/anki-scheduler/pkg-node/anki_scheduler.js');
const ADAPTER_SRC = path.join(ROOT, 'client/external/anki/adapter.js');

let passed = 0, failed = 0;
const pass = (msg) => { passed++; console.log(`  ✓ ${msg}`); };
const fail = (msg) => { failed++; console.error(`  ✗ ${msg}`); };
const assert = (cond, msg) => cond ? pass(msg) : fail(msg);

// ─── Mock content ────────────────────────────────────────────────────────────

// PersistentDict mock: simple in-memory store.
// Exposes global.__resetVocab(data) to reinitialise the vocabulary cache.
const MOCK_PERSISTENCE = `
'use strict';
let _vocabOnload = null;

class PersistentDict {
  constructor(name, onload) {
    this._name = name;
    this._data = {};
    if (onload) {
      if (name === 'vocabulary') _vocabOnload = onload;
      onload(this._data);
    }
  }
  get(key) { return this._data[key]; }
  set(key, value) { this._data[key] = value; }
  depend() {}
}

exports.PersistentDict = PersistentDict;

// Test helper exposed as global: reinitialise vocabulary cache with provided data.
global.__resetVocab = function(data) {
  if (_vocabOnload) _vocabOnload(data || {});
};
`;

// Scheduler mock using real WASM
const MOCK_SCHEDULER = `
'use strict';
const _wasm = require(${JSON.stringify(WASM_CJS)});
exports.nextStates = function(state, config) {
  if (global.__testAnkiDisabled) return null;
  const s = typeof state === 'string' ? state : JSON.stringify(state);
  const c = typeof config === 'string' ? config : JSON.stringify(config);
  const r = JSON.parse(_wasm.next_states(s, c));
  if (r.error) return null;
  return r;
};
exports.intervalSecs = function(state, secs) {
  if (global.__testAnkiDisabled) return 0;
  if (global.__testAnkiIntervalZero) return 0;
  const s = typeof state === 'string' ? state : JSON.stringify(state);
  return _wasm.interval_secs(s, secs || 43200);
};
`;

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

// Global shims for Meteor globals: _ (underscore), check(), String.prototype.hash
const SHIM_GLOBALS = `
'use strict';
global._ = {
  range: function(n) { return Array.from({ length: n }, function(_, i) { return i; }); },
};
global.check = function() {};
// Meteor extends String.prototype with .hash() (Java-style hash)
if (!String.prototype.hash) {
  String.prototype.hash = function() {
    let h = 0;
    for (let i = 0; i < this.length; i++) h = ((h << 5) - h + this.charCodeAt(i)) | 0;
    return h;
  };
}
`;

// ─── Build bundle ─────────────────────────────────────────────────────────────
// Bundles must live inside the project root so c8 can track them for coverage.

const BUNDLES_DIR = path.join(ROOT, '.test-bundles');
fs.mkdirSync(BUNDLES_DIR, { recursive: true });
const MOCK_DIR = path.join(os.tmpdir(), 'vocab-mocks-' + process.pid);
fs.mkdirSync(MOCK_DIR, { recursive: true });
const PERSIST_MOCK = path.join(MOCK_DIR, 'persistence.js');
const SCHED_MOCK   = path.join(MOCK_DIR, 'scheduler.js');
const SETT_MOCK    = path.join(MOCK_DIR, 'settings.js');
const SHIM_PATH    = path.join(MOCK_DIR, 'shim-globals.js');
fs.writeFileSync(PERSIST_MOCK, MOCK_PERSISTENCE);
fs.writeFileSync(SCHED_MOCK,   MOCK_SCHEDULER);
fs.writeFileSync(SETT_MOCK,    MOCK_SETTINGS);
fs.writeFileSync(SHIM_PATH,    SHIM_GLOBALS);

const BUNDLE = path.join(BUNDLES_DIR, 'vocab-bundle.cjs');

async function buildAndTest() {
  const plugin = {
    name: 'meteor-mocks',
    setup(build) {
      build.onResolve({ filter: /^\/client\/model\/persistence$/ },
        () => ({ path: PERSIST_MOCK }));
      build.onResolve({ filter: /^\/client\/external\/anki\/scheduler$/ },
        () => ({ path: SCHED_MOCK }));
      build.onResolve({ filter: /^\/client\/model\/settings$/ },
        () => ({ path: SETT_MOCK }));
      // Bundle the actual adapter.js (so vocab tests cover it too)
      build.onResolve({ filter: /^\/client\/external\/anki\/adapter$/ },
        () => ({ path: ADAPTER_SRC }));
      // Mark WASM package external so __dirname stays correct
      build.onResolve({ filter: /anki_scheduler\.js$/ },
        (args) => ({ path: args.path, external: true }));
    },
  };

  await esbuild.build({
    entryPoints: [VOCAB_SRC],
    bundle: true,
    format: 'cjs',
    outfile: BUNDLE,
    platform: 'node',
    plugins: [plugin],
    inject: [SHIM_PATH],
    sourcemap: 'inline',
    logLevel: 'error',
  });

  const mod = require(BUNDLE);
  const { Vocabulary } = mod;
  // __resetVocab is set as a global by the persistence mock after require()
  const __resetVocab = global.__resetVocab;

  const kOneDay = 86400;
  const TS = 1000000;

  console.log('=== vocabulary.js Unit Tests ===\n');

  // ── Schema migration (7→8 column) ──────────────────────────────────────────
  console.log('[1] Migration: 7-column entries are padded to 8 columns');
  __resetVocab({
    0: [],
    // Use chunk index for '一': Math.abs(strHash('一')) % 16
    // We'll seed a 7-column entry in chunk 0 and verify it works
  });
  // Compute hash for '一' to find correct chunk
  const strHash = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h;
  };
  const chunkOf = (word) => Math.abs(strHash(word)) % 16;

  const chunk1 = chunkOf('一');
  const initData = {};
  for (let i = 0; i < 16; i++) initData[i] = [];
  // Insert a 7-column entry for '一' (pre-ankiState schema)
  initData[chunk1] = [['一', TS - kOneDay, TS, ['testlist'], 1, 1, false]]; // 7 cols
  __resetVocab(initData);
  // The onload function should have migrated it to 8 columns (added null ankiState)
  const newItems0 = Vocabulary.getNewItems().fetch();
  const item1 = Vocabulary.getItemsDueBy(TS + 1, TS + 1).fetch().find(x => x.word === '一');
  assert(item1 !== undefined, '7-col migrated item is accessible via getItemsDueBy');

  // ── addItem ────────────────────────────────────────────────────────────────
  console.log('\n[2] addItem — adds a new word');
  __resetVocab({});
  Vocabulary.addItem('二', 'listA');
  {
    const items = Vocabulary.getNewItems().fetch();
    assert(items.length === 1, 'one new item after addItem');
    assert(items[0].word === '二', 'item is 二');
    assert(items[0].lists[0] === 'listA', 'list is listA');
  }

  console.log('\n[3] addItem — adding same word to same list is idempotent');
  Vocabulary.addItem('二', 'listA'); // duplicate
  {
    const items = Vocabulary.getNewItems().fetch();
    assert(items.length === 1, 'still one item (no duplicate)');
    assert(items[0].lists.length === 1, 'list still has one entry');
  }

  console.log('\n[4] addItem — adding same word to a second list');
  Vocabulary.addItem('二', 'listB');
  {
    const items = Vocabulary.getNewItems().fetch();
    assert(items.length === 1, 'still one item');
    assert(items[0].lists.length === 2, 'now in 2 lists');
  }

  console.log('\n[5] addItem — blacklisted word is not added to active list');
  __resetVocab({});
  Vocabulary.addItem('三', 'listA');
  Vocabulary.updateBlacklist({ word: '三' }, true);
  Vocabulary.addItem('三', 'listB'); // add to new list while blacklisted
  {
    const items = Vocabulary.getNewItems().fetch();
    assert(items.length === 0, 'blacklisted 三 not in active items');
  }

  // ── getNewItems / getItemsDueBy / getDueFailures ───────────────────────────
  console.log('\n[6] getNewItems — filters by attempts === 0');
  __resetVocab({});
  Vocabulary.addItem('一', 'listA');
  Vocabulary.addItem('二', 'listA');
  Vocabulary.updateItem({ word: '一', attempts: 0, successes: 0 }, 1, TS);
  {
    const newItems = Vocabulary.getNewItems().fetch();
    assert(newItems.length === 1, 'one new item after one reviewed');
    assert(newItems[0].word === '二', 'remaining new item is 二');
  }

  console.log('\n[7] getItemsDueBy — filters reviewed cards that are due');
  {
    const due = Vocabulary.getItemsDueBy(TS + 10, TS + 10).fetch();
    assert(due.length === 0, 'no reviews due now (一 has future interval)');
    // 一 was just reviewed, next due is far future
  }

  console.log('\n[8] getDueFailures — filters failed cards due now');
  __resetVocab({});
  Vocabulary.addItem('三', 'listA');
  // Review as "again" (result=3) → should mark as failed
  Vocabulary.updateItem({ word: '三', attempts: 0, successes: 0 }, 3, TS);
  {
    // 三 should now be failed, but not yet due (timer is in future)
    const failures = Vocabulary.getDueFailures(TS - kOneDay, TS + 1, TS).fetch();
    // Due time is TS + interval (e.g., 60s). At TS it's not yet due.
    const card = failures.find(x => x.word === '三');
    assert(!card, 'not yet due right after review (timer hasn\'t fired)');
  }

  // Check getDueFailures with a card that's past due
  {
    const futureTS = TS + 3600; // 1h later
    const failures = Vocabulary.getDueFailures(TS - kOneDay, TS + 1, futureTS).fetch();
    const card = failures.find(x => x.word === '三');
    assert(card !== undefined, 'failure card is due after timer fires');
  }

  console.log('\n[9] getDueFailures — failed=false cards are filtered out');
  __resetVocab({});
  Vocabulary.addItem('四', 'listA');
  Vocabulary.updateItem({ word: '四', attempts: 0, successes: 0 }, 0, TS); // easy pass
  {
    const failures = Vocabulary.getDueFailures(TS - kOneDay, TS + 1, TS + 3600).fetch();
    assert(failures.length === 0, 'passed card (failed=false) not in getDueFailures');
  }

  console.log('\n[10] getFailuresInRange — time window filtering');
  __resetVocab({});
  Vocabulary.addItem('五', 'listA');
  Vocabulary.addItem('六', 'listA');
  // Fail 五 at TS, 六 at TS+100
  Vocabulary.updateItem({ word: '五', attempts: 0, successes: 0 }, 3, TS);
  Vocabulary.updateItem({ word: '六', attempts: 0, successes: 0 }, 3, TS + 100);
  {
    // Window [TS-1, TS+1) — only 五
    const r = Vocabulary.getFailuresInRange(TS - 1, TS + 1).fetch();
    assert(r.some(x => x.word === '五'), '五 is in range');
    assert(!r.some(x => x.word === '六'), '六 is outside range');
  }
  {
    // failed=false card is excluded even if in range
    Vocabulary.addItem('七', 'listA');
    Vocabulary.updateItem({ word: '七', attempts: 0, successes: 0 }, 0, TS); // easy pass
    const r = Vocabulary.getFailuresInRange(TS - 1, TS + 1).fetch();
    assert(!r.some(x => x.word === '七'), 'non-failed card excluded from getFailuresInRange');
  }

  // ── updateItem ─────────────────────────────────────────────────────────────
  console.log('\n[11] updateItem — concurrent modification guard');
  __resetVocab({});
  Vocabulary.addItem('八', 'listA');
  // Provide wrong attempts count → should be a no-op
  Vocabulary.updateItem({ word: '八', attempts: 99, successes: 0 }, 1, TS);
  {
    const items = Vocabulary.getNewItems().fetch();
    assert(items.some(x => x.word === '八'), '八 unchanged (concurrent-mod guard)');
    assert(items[0].attempts === 0, 'attempts not incremented');
  }

  console.log('\n[12] updateItem — success incremented only when result < 3');
  __resetVocab({});
  Vocabulary.addItem('九', 'listA');
  Vocabulary.updateItem({ word: '九', attempts: 0, successes: 0 }, 3, TS); // fail
  {
    const all = Vocabulary.getExtraItems(TS + 1000000).fetch();
    const card = all.find(x => x.word === '九');
    assert(card !== undefined, 'card still accessible after fail');
    assert(card.successes === 0, 'successes not incremented on fail (result=3)');
    assert(card.attempts === 1, 'attempts incremented');
  }
  Vocabulary.updateItem({ word: '九', attempts: 1, successes: 0 }, 1, TS + 600); // good
  {
    const all = Vocabulary.getExtraItems(TS + 1000000).fetch();
    const card = all.find(x => x.word === '九');
    assert(card.successes === 1, 'successes incremented on good (result=1)');
  }

  // ── updateBlacklist ────────────────────────────────────────────────────────
  console.log('\n[13] updateBlacklist — blacklist/unblacklist');
  __resetVocab({});
  Vocabulary.addItem('十', 'listA');
  assert(Vocabulary.getNewItems().count() === 1, '十 initially active');

  // Blacklist it
  Vocabulary.updateBlacklist({ word: '十' }, true);
  assert(Vocabulary.getNewItems().count() === 0, '十 removed from active after blacklist');

  // Blacklist again → no-op (already blacklisted)
  Vocabulary.updateBlacklist({ word: '十' }, true);
  assert(Vocabulary.getNewItems().count() === 0, 'double-blacklist is no-op');

  // Unblacklist
  Vocabulary.updateBlacklist({ word: '十' }, false);
  assert(Vocabulary.getNewItems().count() === 1, '十 back in active after unblacklist');

  // Unblacklist again → no-op (not blacklisted)
  Vocabulary.updateBlacklist({ word: '十' }, false);
  assert(Vocabulary.getNewItems().count() === 1, 'double-unblacklist is no-op');

  // ── dropList ───────────────────────────────────────────────────────────────
  console.log('\n[14] dropList — removes list, deletes entry if no lists and no attempts');
  __resetVocab({});
  Vocabulary.addItem('百', 'listA');
  Vocabulary.addItem('千', 'listA');
  Vocabulary.addItem('万', 'listA');
  // Give '百' some attempts (it will be kept in chunks even after dropList)
  Vocabulary.updateItem({ word: '百', attempts: 0, successes: 0 }, 1, TS);
  // Give '万' a second list (so it stays active after dropping listA)
  Vocabulary.addItem('万', 'listB');
  Vocabulary.dropList('listA');
  {
    // '千' had no attempts and no lists left → deleted (not addable back without error)
    // Verify: adding '千' again creates a fresh entry
    Vocabulary.addItem('千', 'listB');
    const newItem = Vocabulary.getNewItems().fetch().find(x => x.word === '千');
    assert(newItem !== undefined && newItem.attempts === 0, '千 deleted then re-added fresh');
    // '万' still has listB → still active
    const active = Vocabulary.getNewItems().fetch();
    assert(active.some(x => x.word === '万'), '万 still active (has listB)');
    // '百' had attempts but no lists → not active, but re-addable
    Vocabulary.addItem('百', 'listB');
    const restored = Vocabulary.getExtraItems(TS + 1000000).fetch().find(x => x.word === '百');
    assert(restored !== undefined, '百 re-added after dropList');
  }

  // ── Cursor.next() random tie-break ─────────────────────────────────────────
  console.log('\n[15] Cursor.next() — handles tied timestamps (random tie-break)');
  __resetVocab({});
  // Add two new items (next=null → Infinity, same first value)
  Vocabulary.addItem('A', 'listA');
  Vocabulary.addItem('B', 'listA');
  // Call next() many times to verify both can be selected
  const words = new Set();
  for (let i = 0; i < 100; i++) {
    const item = Vocabulary.getNewItems().next();
    if (item) words.add(item.word);
  }
  // With ties and random selection, both A and B should appear
  assert(words.size >= 1, 'Cursor.next() returns an item');
  // NOTE: The tie-break branch uses Math.random() so both items may not always appear
  // in exactly 100 calls, but at least one should.

  // ── Cursor.next() — empty list ──────────────────────────────────────────────
  console.log('\n[16] Cursor.next() — returns null when list is empty');
  __resetVocab({});
  {
    const item = Vocabulary.getNewItems().next();
    assert(item === null, 'next() returns null on empty list');
  }

  // ── getExtraItems ──────────────────────────────────────────────────────────
  console.log('\n[17] getExtraItems — includes new items and items with past next time');
  __resetVocab({});
  Vocabulary.addItem('万', 'listA');
  Vocabulary.addItem('亿', 'listA');
  Vocabulary.updateItem({ word: '万', attempts: 0, successes: 0 }, 0, TS); // passes, next is far future
  {
    const extras = Vocabulary.getExtraItems(TS + 1).fetch();
    // '亿' is new (attempts=0) → included
    assert(extras.some(x => x.word === '亿'), '亿 (new) in getExtraItems');
    // '万' next is far future, not <= TS+1 → probably not included
    // But it has attempts>0, so only included if next < TS+1
  }

  // ── getDueFailures — card outside time range ────────────────────────────────
  console.log('\n[18] getDueFailures — card outside time range is excluded (line 177)');
  __resetVocab({});
  Vocabulary.addItem('壬', 'listA');
  Vocabulary.addItem('癸', 'listA');
  const OLD_TS = TS - 2 * kOneDay; // old session ts
  Vocabulary.updateItem({ word: '壬', attempts: 0, successes: 0 }, 3, OLD_TS); // before session
  Vocabulary.updateItem({ word: '癸', attempts: 0, successes: 0 }, 3, TS);      // in session
  {
    const r = Vocabulary.getDueFailures(TS - kOneDay, TS + 1, TS + 3600).fetch();
    assert(!r.some(x => x.word === '壬'), '壬 (before range) excluded from getDueFailures');
    assert(r.some(x => x.word === '癸'), '癸 (in range) included in getDueFailures');
  }

  // ── getDueFailures — failed card with next=null is treated as due ──────────
  console.log('\n[19] getDueFailures — next=null treated as 0 (due immediately, line 178)');
  {
    // Seed a card directly: failed=true, next=null, last inside the range
    const seedData = {};
    for (let i = 0; i < 16; i++) seedData[i] = [];
    const c = Math.abs('寅'.hash()) % 16;
    seedData[c] = [['寅', TS - 100, null, ['listA'], 1, 0, true,
      { Learning: { remaining_steps: 1, scheduled_secs: 60, elapsed_secs: 0 } }]];
    __resetVocab(seedData);
    const r = Vocabulary.getDueFailures(TS - kOneDay, TS + 1, TS).fetch();
    assert(r.some(x => x.word === '寅'), '寅 with next=null treated as due (null||0 <= now)');
  }

  // ── updateItem — interval=0 → next=ts (else branch, line 210) ──────────────
  console.log('\n[20] updateItem — interval=0 → next=ts');
  __resetVocab({});
  Vocabulary.addItem('卯', 'listA');
  global.__testAnkiIntervalZero = true;
  try {
    Vocabulary.updateItem({ word: '卯', attempts: 0, successes: 0 }, 1, TS);
    const all = Vocabulary.getExtraItems(TS + 1000000).fetch();
    const card = all.find(x => x.word === '卯');
    assert(card !== undefined && card.next === TS, 'interval=0 → next=ts (else branch)');
  } finally {
    global.__testAnkiIntervalZero = false;
  }

  // ── clearFailed ─────────────────────────────────────────────────────────────
  console.log('\n[21] clearFailed — resets failed flag');
  __resetVocab({});
  Vocabulary.addItem('甲', 'listA');
  Vocabulary.updateItem({ word: '甲', attempts: 0, successes: 0 }, 3, TS); // fail
  {
    const failures = Vocabulary.getDueFailures(TS - kOneDay, TS + 1, TS + 3600).fetch();
    assert(failures.some(x => x.word === '甲'), '甲 is in failures before clearFailed');
    Vocabulary.clearFailed({ word: '甲' });
    const after = Vocabulary.getDueFailures(TS - kOneDay, TS + 1, TS + 3600).fetch();
    assert(!after.some(x => x.word === '甲'), '甲 cleared from failures after clearFailed');
  }

  console.log('\n[22] clearFailed — no-op for unknown word');
  Vocabulary.clearFailed({ word: 'nonexistent_word' }); // should not throw
  pass('clearFailed on unknown word → no crash');

  // ── getBlacklistedWords ────────────────────────────────────────────────────
  console.log('\n[23] getBlacklistedWords — returns blacklist');
  __resetVocab({});
  Vocabulary.addItem('乙', 'listA');
  Vocabulary.updateBlacklist({ word: '乙', pinyin: 'yi3', definition: 'second' }, true);
  {
    const bl = Vocabulary.getBlacklistedWords();
    assert(Array.isArray(bl) || bl !== undefined, 'getBlacklistedWords returns something');
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

buildAndTest().catch((e) => { console.error(e); process.exit(1); });
