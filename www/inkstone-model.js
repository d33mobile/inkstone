"use strict";
(() => {
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });

  // src/anki/wasm.ts
  var cachedUint8ArrayMemory0 = null;
  var cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
  cachedTextDecoder.decode();
  var MAX_SAFARI_DECODE_BYTES = 2146435072;
  var numBytesDecoded = 0;
  var cachedTextEncoder = new TextEncoder();
  var WASM_VECTOR_LEN = 0;
  var wasm = null;
  function getUint8ArrayMemory0() {
    if (!cachedUint8ArrayMemory0 || cachedUint8ArrayMemory0.byteLength === 0)
      cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    return cachedUint8ArrayMemory0;
  }
  function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
      cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
      cachedTextDecoder.decode();
      numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
  }
  function passStringToWasm0(arg, malloc, realloc) {
    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;
    const mem = getUint8ArrayMemory0();
    let offset = 0;
    for (; offset < len; offset++) {
      const code = arg.charCodeAt(offset);
      if (code > 127) break;
      mem[ptr + offset] = code;
    }
    if (offset !== len) {
      if (offset !== 0) arg = arg.slice(offset);
      ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
      const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
      const ret = cachedTextEncoder.encodeInto(arg, view);
      offset += ret.written;
      ptr = realloc(ptr, len, offset, 1) >>> 0;
    }
    WASM_VECTOR_LEN = offset;
    return ptr;
  }
  function getImports() {
    return {
      "./anki_scheduler_bg.js": {
        __wbindgen_init_externref_table() {
          const table = wasm.__wbindgen_externrefs;
          const offset = table.grow(4);
          table.set(0, void 0);
          table.set(offset + 0, void 0);
          table.set(offset + 1, null);
          table.set(offset + 2, true);
          table.set(offset + 3, false);
        }
      }
    };
  }
  async function loadWasm(url = "/wasm/anki_scheduler_bg.wasm") {
    if (wasm) return;
    const response = await fetch(url);
    const bytes = await response.arrayBuffer();
    const imports = getImports();
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, imports);
    wasm = instance.exports;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    console.log(`[anki] WASM loaded (${bytes.byteLength} bytes)`);
  }
  function nextStates(state, config) {
    if (!wasm) return null;
    const stateJson = JSON.stringify(state);
    const configJson = JSON.stringify(config);
    let d0, d1;
    try {
      const p0 = passStringToWasm0(stateJson, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const l0 = WASM_VECTOR_LEN;
      const p1 = passStringToWasm0(configJson, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const l1 = WASM_VECTOR_LEN;
      const ret = wasm.next_states(p0, l0, p1, l1);
      d0 = ret[0];
      d1 = ret[1];
      const resultJson = getStringFromWasm0(ret[0], ret[1]);
      const result = JSON.parse(resultJson);
      if (result.error) {
        console.error("[anki] scheduler error:", result.error);
        return null;
      }
      return result;
    } finally {
      wasm.__wbindgen_free(d0, d1, 1);
    }
  }
  function intervalSecs(state, secsUntilRollover = 43200) {
    if (!wasm) return 0;
    const stateJson = JSON.stringify(state);
    const p0 = passStringToWasm0(stateJson, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    return wasm.interval_secs(p0, WASM_VECTOR_LEN, secsUntilRollover) >>> 0;
  }

  // src/anki/types.ts
  function isLearning(s) {
    return "Learning" in s;
  }
  function isReview(s) {
    return "Review" in s;
  }
  function isRelearning(s) {
    return "Relearning" in s;
  }
  function isInLearningPhase(s) {
    return isLearning(s) || isRelearning(s);
  }

  // src/anki/adapter.ts
  var ONE_DAY = 86400;
  var RATING_MAP = ["easy", "good", "hard", "again"];
  function buildConfig(getSetting) {
    const parseSteps = (s) => {
      if (!s || typeof s !== "string") return [];
      return s.split(/\s+/).map(Number).filter((n) => !isNaN(n) && n > 0);
    };
    return {
      learn_steps: parseSteps(getSetting("learn_steps")),
      relearn_steps: parseSteps(getSetting("relearn_steps")),
      graduating_interval_good: getSetting("graduating_interval_good"),
      graduating_interval_easy: getSetting("graduating_interval_easy"),
      initial_ease_factor: getSetting("starting_ease") / 100,
      hard_multiplier: getSetting("hard_multiplier") / 100,
      easy_multiplier: getSetting("easy_multiplier") / 100,
      interval_multiplier: getSetting("interval_multiplier") / 100,
      maximum_review_interval: getSetting("maximum_review_interval"),
      leech_threshold: getSetting("leech_threshold"),
      lapse_multiplier: getSetting("lapse_multiplier") / 100,
      minimum_lapse_interval: getSetting("minimum_lapse_interval"),
      fuzz_factor: Date.now() % 1e4 / 1e4
    };
  }
  function reconstructState(item, ts) {
    const s = item.ankiState;
    if (!s) {
      if (!item.attempts || item.attempts === 0) {
        return { New: { position: 0 } };
      }
      const scheduledDays = item.last && item.next && item.next > item.last ? Math.max(1, Math.round((item.next - item.last) / ONE_DAY)) : 1;
      const elapsedDays = item.last ? Math.max(0, Math.floor((ts - item.last) / ONE_DAY)) : scheduledDays;
      return {
        Review: {
          scheduled_days: scheduledDays,
          elapsed_days: elapsedDays,
          ease_factor: 2.5,
          lapses: Math.max(0, (item.attempts || 0) - (item.successes || 0)),
          leeched: false
        }
      };
    }
    if (isReview(s)) {
      const elapsedDays = item.last ? Math.max(0, Math.floor((ts - item.last) / ONE_DAY)) : s.Review.scheduled_days;
      return { Review: { ...s.Review, elapsed_days: elapsedDays } };
    }
    if (isLearning(s)) {
      const elapsedSecs = item.last ? Math.max(0, ts - item.last) : 0;
      return { Learning: { ...s.Learning, elapsed_secs: elapsedSecs } };
    }
    if (isRelearning(s)) {
      const elapsedSecs = item.last ? Math.max(0, ts - item.last) : 0;
      const elapsedDays = item.last ? Math.max(0, Math.floor((ts - item.last) / ONE_DAY)) : s.Relearning.review.scheduled_days;
      return {
        Relearning: {
          learning: { ...s.Relearning.learning, elapsed_secs: elapsedSecs },
          review: { ...s.Relearning.review, elapsed_days: elapsedDays }
        }
      };
    }
    return s;
  }
  function getSchedulingResult(item, result, ts, getSetting) {
    const rating = RATING_MAP[result] || "again";
    const currentState = reconstructState(item, ts);
    const config = buildConfig(getSetting);
    const states = nextStates(currentState, config);
    if (!states) {
      console.warn("[anki] WASM not ready, using fallback interval");
      const fallbackIntervals = [28 * ONE_DAY, 7 * ONE_DAY, ONE_DAY, 600];
      return {
        interval: fallbackIntervals[result] || 600,
        ankiState: currentState,
        failed: result >= 3
      };
    }
    const newState = states[rating];
    const interval = intervalSecs(newState, 43200);
    const failed = isInLearningPhase(newState);
    return { interval, ankiState: newState, failed };
  }

  // src/index.ts
  var NUM_CHUNKS = 16;
  function strHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h << 5) - h + s.charCodeAt(i) | 0;
    }
    return h;
  }
  function getSettingsGetter() {
    try {
      const settingsMod = __require("/client/model/settings");
      return settingsMod.Settings.get.bind(settingsMod.Settings);
    } catch {
      const defaults = {
        learn_steps: "1 10",
        relearn_steps: "10",
        graduating_interval_good: 1,
        graduating_interval_easy: 4,
        starting_ease: 250,
        hard_multiplier: 120,
        easy_multiplier: 130,
        interval_multiplier: 100,
        maximum_review_interval: 36500,
        lapse_multiplier: 0,
        minimum_lapse_interval: 1,
        leech_threshold: 8
      };
      return (key) => defaults[key];
    }
  }
  function writeAnkiState(word, ts, interval, failed, ankiState) {
    setTimeout(() => {
      const chunkIdx = Math.abs(strHash(word)) % NUM_CHUNKS;
      const key = `table.vocabulary.${chunkIdx}`;
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const chunk = JSON.parse(raw);
      for (const entry of chunk) {
        if (entry[0] === word) {
          while (entry.length < 8) entry.push(null);
          entry[2] = interval > 0 ? ts + interval : ts;
          entry[6] = failed;
          entry[7] = ankiState;
          break;
        }
      }
      localStorage.setItem(key, JSON.stringify(chunk));
    }, 50);
  }
  function patchVocabulary() {
    try {
      const vocabMod = __require("/client/model/vocabulary");
      const Vocabulary = vocabMod.Vocabulary;
      if (!Vocabulary?.updateItem) {
        console.error("[anki] Vocabulary.updateItem not found");
        return;
      }
      const origUpdateItem = Vocabulary.updateItem.bind(Vocabulary);
      const getSetting = getSettingsGetter();
      Vocabulary.updateItem = function(item, result, ts) {
        const scheduling = getSchedulingResult(item, result, ts, getSetting);
        const iqMod = __require("/client/external/inkren/interval_quantifier");
        const origGNI = iqMod.getNextInterval;
        iqMod.getNextInterval = () => scheduling.interval;
        origUpdateItem(item, result, ts);
        iqMod.getNextInterval = origGNI;
        writeAnkiState(item.word, ts, scheduling.interval, scheduling.failed, scheduling.ankiState);
      };
      console.log("[anki] Vocabulary.updateItem patched with Anki SM-2 scheduler");
      window.__ankiSchedulerActive = true;
    } catch (e) {
      console.error("[anki] Failed to patch:", e);
    }
  }
  function init() {
    loadWasm("/wasm/anki_scheduler_bg.wasm").then(patchVocabulary).catch((e) => console.error("[anki] init failed:", e));
  }
  if (typeof Meteor !== "undefined" && Meteor.startup) {
    Meteor.startup(init);
  } else {
    document.addEventListener("DOMContentLoaded", () => setTimeout(init, 500));
  }
})();
