// Inkstone model layer — TypeScript runtime patch.
//
// Loads the Anki SM-2 WASM scheduler and overrides Vocabulary.updateItem
// in the Meteor bundle to use Anki's scheduling algorithm.
//
// Built with: npx esbuild src/index.ts --bundle --outfile=www/inkstone-model.js --format=iife

import { loadWasm } from './anki/wasm';
import { getSchedulingResult, type AdapterItem } from './anki/adapter';
import type { InkstoneResult } from './anki/types';

const NUM_CHUNKS = 16;

/** Java-style string hash (matches String.prototype.hash in lib/base.js). */
function strHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}

/** Read Settings.get from the Meteor module. */
function getSettingsGetter(): (key: string) => any {
  try {
    const settingsMod = require('/client/model/settings');
    return settingsMod.Settings.get.bind(settingsMod.Settings);
  } catch {
    // Fallback defaults
    const defaults: Record<string, any> = {
      learn_steps: '1 10', relearn_steps: '10',
      graduating_interval_good: 1, graduating_interval_easy: 4,
      starting_ease: 250, hard_multiplier: 120, easy_multiplier: 130,
      interval_multiplier: 100, maximum_review_interval: 36500,
      lapse_multiplier: 0, minimum_lapse_interval: 1, leech_threshold: 8,
    };
    return (key: string) => defaults[key];
  }
}

/** Write ankiState + corrected fields to localStorage after Meteor.defer settles. */
function writeAnkiState(
  word: string,
  ts: number,
  interval: number,
  failed: boolean,
  ankiState: any,
): void {
  setTimeout(() => {
    const chunkIdx = Math.abs(strHash(word)) % NUM_CHUNKS;
    const key = `table.vocabulary.${chunkIdx}`;
    const raw = localStorage.getItem(key);
    if (!raw) return;

    const chunk: any[][] = JSON.parse(raw);
    for (const entry of chunk) {
      if (entry[0] === word) {
        // Extend to 8 columns if needed
        while (entry.length < 8) entry.push(null);
        // [2]=next, [6]=failed, [7]=ankiState
        entry[2] = interval > 0 ? ts + interval : ts;
        entry[6] = failed;
        entry[7] = ankiState;
        break;
      }
    }
    localStorage.setItem(key, JSON.stringify(chunk));
  }, 50);
}

/** Patch Vocabulary.updateItem to use the Anki scheduler. */
function patchVocabulary(): void {
  try {
    const vocabMod = require('/client/model/vocabulary');
    const Vocabulary = vocabMod.Vocabulary;
    if (!Vocabulary?.updateItem) {
      console.error('[anki] Vocabulary.updateItem not found');
      return;
    }

    const origUpdateItem: Function = Vocabulary.updateItem.bind(Vocabulary);
    const getSetting = getSettingsGetter();

    Vocabulary.updateItem = function (
      item: AdapterItem,
      result: InkstoneResult,
      ts: number,
    ): void {
      // Compute Anki scheduling
      const scheduling = getSchedulingResult(item, result, ts, getSetting);

      // Override getNextInterval so the original updateItem uses our interval
      const iqMod = require('/client/external/inkren/interval_quantifier');
      const origGNI = iqMod.getNextInterval;
      iqMod.getNextInterval = () => scheduling.interval;

      // Call original (updates in-memory cache + defers localStorage write)
      origUpdateItem(item, result, ts);

      // Restore
      iqMod.getNextInterval = origGNI;

      // Write ankiState after Meteor's deferred persistence
      writeAnkiState(item.word, ts, scheduling.interval, scheduling.failed, scheduling.ankiState);
    };

    console.log('[anki] Vocabulary.updateItem patched with Anki SM-2 scheduler');
    (window as any).__ankiSchedulerActive = true;
  } catch (e) {
    console.error('[anki] Failed to patch:', e);
  }
}

/** Entry point — loads WASM then patches. */
function init(): void {
  loadWasm('/wasm/anki_scheduler_bg.wasm')
    .then(patchVocabulary)
    .catch((e: Error) => console.error('[anki] init failed:', e));
}

if (typeof Meteor !== 'undefined' && Meteor.startup) {
  Meteor.startup(init);
} else {
  document.addEventListener('DOMContentLoaded', () => setTimeout(init, 500));
}
