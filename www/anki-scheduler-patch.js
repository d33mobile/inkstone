// Anki SM-2 scheduler runtime patch.
// Loads the WASM module, then monkey-patches Vocabulary.updateItem to use
// the Anki algorithm. Writes ankiState directly to localStorage entries.
(function() {
  'use strict';

  // === WASM glue (from wasm-pack, inlined) ===
  var cachedUint8ArrayMemory0 = null;
  var cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
  cachedTextDecoder.decode();
  var MAX_SAFARI_DECODE_BYTES = 2146435072;
  var numBytesDecoded = 0;
  var cachedTextEncoder = new TextEncoder();
  if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function(a, v) {
      var b = cachedTextEncoder.encode(a); v.set(b);
      return { read: a.length, written: b.length };
    };
  }
  var WASM_VECTOR_LEN = 0, wasmModule, wasm;

  function getUint8ArrayMemory0() {
    if (!cachedUint8ArrayMemory0 || cachedUint8ArrayMemory0.byteLength === 0)
      cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    return cachedUint8ArrayMemory0;
  }
  function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
      cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
      cachedTextDecoder.decode(); numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
  }
  function passStringToWasm0(arg, malloc, realloc) {
    var len = arg.length, ptr = malloc(len, 1) >>> 0;
    var mem = getUint8ArrayMemory0(), offset = 0;
    for (; offset < len; offset++) {
      var code = arg.charCodeAt(offset);
      if (code > 0x7F) break;
      mem[ptr + offset] = code;
    }
    if (offset !== len) {
      if (offset !== 0) arg = arg.slice(offset);
      ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
      var ret = cachedTextEncoder.encodeInto(arg, getUint8ArrayMemory0().subarray(ptr + offset, ptr + len));
      offset += ret.written;
      ptr = realloc(ptr, len, offset, 1) >>> 0;
    }
    WASM_VECTOR_LEN = offset;
    return ptr;
  }
  function __wbg_get_imports() {
    return { __proto__: null, "./anki_scheduler_bg.js": { __proto__: null,
      __wbindgen_init_externref_table: function() {
        var t = wasm.__wbindgen_externrefs, o = t.grow(4);
        t.set(0, undefined); t.set(o, undefined); t.set(o+1, null); t.set(o+2, true); t.set(o+3, false);
      }
    }};
  }
  function __wbg_finalize_init(instance, module) {
    wasm = instance.exports; wasmModule = module;
    cachedUint8ArrayMemory0 = null; wasm.__wbindgen_start(); return wasm;
  }
  function ankiNextStates(sJ, cJ) {
    var d0, d1;
    try {
      var p0 = passStringToWasm0(sJ, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc), l0 = WASM_VECTOR_LEN;
      var p1 = passStringToWasm0(cJ, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc), l1 = WASM_VECTOR_LEN;
      var r = wasm.next_states(p0, l0, p1, l1); d0 = r[0]; d1 = r[1];
      return getStringFromWasm0(r[0], r[1]);
    } finally { wasm.__wbindgen_free(d0, d1, 1); }
  }
  function ankiIntervalSecs(sJ, sur) {
    var p = passStringToWasm0(sJ, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    return wasm.interval_secs(p, WASM_VECTOR_LEN, sur) >>> 0;
  }

  // === Adapter ===
  var kOneDay = 86400;
  var ratingMap = ['easy', 'good', 'hard', 'again'];

  function getConfig() {
    return JSON.stringify({
      learn_steps: [1, 10], relearn_steps: [10],
      graduating_interval_good: 1, graduating_interval_easy: 4,
      initial_ease_factor: 2.5, hard_multiplier: 1.2, easy_multiplier: 1.3,
      interval_multiplier: 1.0, maximum_review_interval: 36500, leech_threshold: 8,
      lapse_multiplier: 0.0, minimum_lapse_interval: 1,
      fuzz_factor: (Date.now() % 10000) / 10000,
    });
  }

  function reconstructState(item, ts) {
    var s = item.ankiState;
    if (!s) {
      if (!item.attempts || item.attempts === 0) return JSON.stringify({New:{position:0}});
      var sd = (item.last && item.next > item.last) ? Math.max(1, Math.round((item.next - item.last) / kOneDay)) : 1;
      var ed = item.last ? Math.max(0, Math.floor((ts - item.last) / kOneDay)) : sd;
      return JSON.stringify({Review:{scheduled_days:sd, elapsed_days:ed, ease_factor:2.5, lapses:Math.max(0,(item.attempts||0)-(item.successes||0)), leeched:false}});
    }
    if (s.Review) return JSON.stringify({Review:{scheduled_days:s.Review.scheduled_days, elapsed_days: item.last ? Math.max(0, Math.floor((ts - item.last) / kOneDay)) : s.Review.scheduled_days, ease_factor:s.Review.ease_factor, lapses:s.Review.lapses, leeched:s.Review.leeched}});
    if (s.Learning) return JSON.stringify({Learning:{remaining_steps:s.Learning.remaining_steps, scheduled_secs:s.Learning.scheduled_secs, elapsed_secs: item.last ? Math.max(0, ts - item.last) : 0}});
    if (s.Relearning) return JSON.stringify({Relearning:{learning:{remaining_steps:s.Relearning.learning.remaining_steps, scheduled_secs:s.Relearning.learning.scheduled_secs, elapsed_secs: item.last ? Math.max(0, ts - item.last) : 0}, review:{scheduled_days:s.Relearning.review.scheduled_days, elapsed_days: item.last ? Math.max(0, Math.floor((ts - item.last) / kOneDay)) : s.Relearning.review.scheduled_days, ease_factor:s.Relearning.review.ease_factor, lapses:s.Relearning.review.lapses, leeched:s.Relearning.review.leeched}}});
    return JSON.stringify(s);
  }

  // Java-style string hash (matches Meteor bundle's String.prototype.hash)
  function strHash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h;
  }

  // === Main patch: completely replaces updateItem ===
  function patchVocabulary() {
    try {
      var vocabMod = require('/client/model/vocabulary');
      var Vocabulary = vocabMod.Vocabulary;
      if (!Vocabulary || !Vocabulary.updateItem) {
        console.error('[anki] Vocabulary.updateItem not found');
        return;
      }
      var origUpdateItem = Vocabulary.updateItem.bind(Vocabulary);

      Vocabulary.updateItem = function(item, result, ts) {
        if (!wasm) return origUpdateItem(item, result, ts);

        // Compute Anki scheduling
        var rating = ratingMap[result] || 'again';
        var stateJson = reconstructState(item, ts);
        var statesJson = ankiNextStates(stateJson, getConfig());
        var states = JSON.parse(statesJson);
        if (states.error) {
          console.error('[anki] error:', states.error);
          return origUpdateItem(item, result, ts);
        }
        var newState = states[rating];
        var interval = ankiIntervalSecs(JSON.stringify(newState), 43200);
        var failed = !!(newState.Learning || newState.Relearning);

        // Call original — this updates the in-memory cache + defers localStorage write
        // We override getNextInterval so the original uses our interval
        var iqMod = require('/client/external/inkren/interval_quantifier');
        var origGNI = iqMod.getNextInterval;
        iqMod.getNextInterval = function() { return interval; };
        origUpdateItem(item, result, ts);
        iqMod.getNextInterval = origGNI;

        // Now fix up the entry AFTER the deferred write.
        // We use setTimeout(0) to run after Meteor.defer has flushed.
        var word = item.word;
        setTimeout(function() {
          var chunkIdx = Math.abs(strHash(word)) % 16;
          var key = 'table.vocabulary.' + chunkIdx;
          var raw = localStorage.getItem(key);
          if (!raw) return;
          var chunk = JSON.parse(raw);
          for (var i = 0; i < chunk.length; i++) {
            if (chunk[i][0] === word) {
              // Extend to 8 columns if needed
              while (chunk[i].length < 8) chunk[i].push(null);
              // [6] = failed, [7] = ankiState
              chunk[i][6] = failed;
              chunk[i][7] = newState;
              // Fix next timestamp
              if (interval > 0) {
                chunk[i][2] = ts + interval;
              } else {
                chunk[i][2] = ts;
              }
              break;
            }
          }
          localStorage.setItem(key, JSON.stringify(chunk));
        }, 50); // 50ms — well after Meteor.defer

        // Schedule a shuffle when this learning card becomes due.
        // After the timer, dirty the vocabulary to trigger reactive re-computation
        // which causes the remainder autorun → shuffle autorun to re-fire.
        // When a learning card becomes due, re-trigger shuffle.
        // Use Timing.shuffle() which is safe (just re-picks next card).
        // The old shuffle checks adds/reviews first, so this only helps
        // When a learning card becomes due, force the Meteor reactive chain
        // to re-evaluate. We re-write the vocabulary chunk to trigger
        // PersistentDict's reactive dependency → remainder autorun re-fires
        // → calls our overridden getNewItems (returns empty when due failure
        // exists) → shuffle falls through to failures.
        if (failed && interval > 0 && interval < 3600) {
          var _word = word;
          setTimeout(function() {
            try {
              var idx = Math.abs(strHash(_word)) % 16;
              var key = 'table.vocabulary.' + idx;
              var raw = localStorage.getItem(key);
              if (!raw) return;
              // Re-set the same data to trigger PersistentDict reactivity
              var vocabDict = require('/client/model/persistence').PersistentDict;
              // Can't access the instance, so touch localStorage + flush
              localStorage.setItem(key, raw);
              // Force Tracker to notice the change
              var vocabMod = require('/client/model/vocabulary');
              // The vocab PersistentDict watches localStorage via its cache.
              // We need to invalidate the cache. The simplest way: call
              // Vocabulary.clearFailed on a dummy to trigger dirty().
              // Actually, just call Timing.shuffle() — but we need remainder
              // to reflect the override. The override is synchronous in
              // getNewItems/getItemsDueBy. The remainder autorun will call
              // them when it re-runs. We need to MAKE it re-run.
              // Trigger: modify a setting to poke Settings' reactive dep.
              var Settings = require('/client/model/settings').Settings;
              var dur = Settings.get('session_duration');
              Settings.set('session_duration', dur); // no-op write triggers reactivity
              console.log('[anki] Learning card due — triggered reactive refresh');
            } catch(e) {
              console.error('[anki] Timer error:', e);
            }
          }, (interval + 1) * 1000);
        }
      };

      console.log('[anki] Vocabulary.updateItem patched with Anki SM-2 scheduler');
      window.__ankiSchedulerActive = true;
    } catch (e) {
      console.error('[anki] Failed to patch:', e);
    }
  }

  // === Part 2: Override getNextCard for Anki-style ordering ===
  // The old shuffle checks adds/reviews BEFORE failures. We override
  // Timing.getNextCard() to check for due learning cards first.
  // Key: cache the card object by word to prevent Tracker.autorun re-fires.
  function patchGetNextCard() {
    try {
      var Timing = require('/client/model/timing').Timing;
      var origGetNext = Timing.getNextCard;
      var cachedDueCard = null;
      var cachedDueWord = null;

      function findDueLearningCard(now) {
        var best = null;
        for (var i = 0; i < 16; i++) {
          var raw = localStorage.getItem('table.vocabulary.' + i);
          if (!raw) continue;
          try {
            var chunk = JSON.parse(raw);
            for (var j = 0; j < chunk.length; j++) {
              var e = chunk[j];
              // [6]=failed, [2]=next, [3]=lists, [0]=word
              if (!e[6]) continue;
              if (!e[3] || e[3].length === 0) continue;
              if ((e[2] || 0) > now) continue;
              if (!best || (e[2] || 0) < (best[2] || 0)) best = e;
            }
          } catch(ex) {}
        }
        if (!best) return null;
        return {
          word: best[0], last: best[1], next: best[2], lists: best[3],
          attempts: best[4], successes: best[5], failed: best[6],
          ankiState: best[7] || null,
        };
      }

      Timing.getNextCard = function() {
        // Check for due learning card FIRST — before calling origGetNext
        // to avoid creating a reactive dependency on next_card when preempting.
        var now = Math.floor(Date.now() / 1000);
        var due = findDueLearningCard(now);
        if (due) {
          // Reuse cached object if same word (prevents Tracker autorun re-fire)
          if (cachedDueWord === due.word && cachedDueCard) {
            return cachedDueCard;
          }
          // Need session ts — read from timing PersistentVar directly
          var timingData = JSON.parse(localStorage.getItem('table.timing.value') || '{}');
          cachedDueWord = due.word;
          cachedDueCard = { data: due, deck: 'failures', ts: timingData.ts || now };
          console.log('[anki] Preempting with due learning card:', due.word);
          return cachedDueCard;
        }
        // No due card — fall through to original (creates reactive dep)
        cachedDueCard = null;
        cachedDueWord = null;
        return origGetNext.call(Timing);
      };

      console.log('[anki] getNextCard patched for learning card priority');
    } catch(e) {
      console.error('[anki] Failed to patch getNextCard:', e);
    }
  }

  // === Init: load WASM then patch ===
  function initAnkiScheduler() {
    fetch('/wasm/anki_scheduler_bg.wasm')
      .then(function(r) { return r.arrayBuffer(); })
      .then(function(bytes) {
        // WebView (Android 13+) disallows synchronous WebAssembly.Module()
        // for buffers >4 KB on the main thread. Use the async API.
        var imports = __wbg_get_imports();
        return WebAssembly.instantiate(bytes, imports).then(function(res) {
          __wbg_finalize_init(res.instance, res.module);
          console.log('[anki] WASM loaded (' + bytes.byteLength + ' bytes)');
          patchVocabulary();
          console.log('[anki] patchVocabulary done, calling patchGetNextCard');
          try { patchGetNextCard(); } catch(ex) { console.error('[anki] patchGetNextCard THREW:', ex); }
        });
      })
      .catch(function(e) {
        console.error('[anki] WASM load failed:', e);
        // Even if WASM fails, the getNextCard preempt wrapper is
        // independent (it only reads localStorage); install it anyway
        // so failures-queue cards still preempt correctly.
        try { patchGetNextCard(); } catch(ex) { console.error('[anki] patchGetNextCard THREW:', ex); }
      });
  }

  if (typeof Meteor !== 'undefined' && Meteor.startup) {
    Meteor.startup(initAnkiScheduler);
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      setTimeout(initAnkiScheduler, 500);
    });
  }
})();
