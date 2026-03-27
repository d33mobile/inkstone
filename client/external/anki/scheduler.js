// Anki SM-2 scheduler — WASM loader and API wrapper.
// Loads the WASM module at Meteor startup and provides synchronous access
// to the scheduler functions.

import {Meteor} from 'meteor/meteor';
import {init, isInitialized, next_states, interval_secs, default_config}
  from '/client/external/anki/wasm_glue';

// Load WASM at startup. The module loads fast (~107KB) and will be ready
// long before a user could complete their first card review.
Meteor.startup(() => {
  init('/wasm/anki_scheduler_bg.wasm').then(() => {
    console.log('Anki scheduler WASM loaded');
  }).catch((e) => {
    console.error('Failed to load Anki scheduler WASM:', e);
  });
});

// Re-export the WASM functions with JS-friendly wrappers.

export function nextStates(state, config) {
  if (!isInitialized()) {
    console.error('Anki scheduler WASM not yet loaded');
    return null;
  }
  const stateJson = typeof state === 'string' ? state : JSON.stringify(state);
  const configJson = typeof config === 'string' ? config : JSON.stringify(config);
  const resultJson = next_states(stateJson, configJson);
  const result = JSON.parse(resultJson);
  if (result.error) {
    console.error('Anki scheduler error:', result.error);
    return null;
  }
  return result;
}

export function intervalSecs(state, secsUntilRollover) {
  if (!isInitialized()) return 0;
  const stateJson = typeof state === 'string' ? state : JSON.stringify(state);
  return interval_secs(stateJson, secsUntilRollover || 43200);
}

export function defaultConfig() {
  if (!isInitialized()) return null;
  return JSON.parse(default_config());
}
