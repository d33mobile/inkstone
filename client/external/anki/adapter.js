// Anki SM-2 adapter — bridges the WASM scheduler to Inkstone's vocabulary model.
//
// Maps Inkstone's result codes (0-3) to Anki ratings and converts between
// Inkstone's per-card data and Anki's NormalState representation.

import {nextStates, intervalSecs} from '/client/external/anki/scheduler';
import {Settings} from '/client/model/settings';

const kOneDay = 86400;

// Inkstone result → Anki rating name
const kRatingMap = ['easy', 'good', 'hard', 'again'];

// Build Anki scheduler config from Inkstone settings.
function buildConfig() {
  const parseSteps = (s) => {
    if (!s || typeof s !== 'string') return [];
    return s.split(/\s+/).map(Number).filter(n => !isNaN(n) && n > 0);
  };
  return {
    learn_steps: parseSteps(Settings.get('learn_steps')),
    relearn_steps: parseSteps(Settings.get('relearn_steps')),
    graduating_interval_good: Settings.get('graduating_interval_good'),
    graduating_interval_easy: Settings.get('graduating_interval_easy'),
    initial_ease_factor: Settings.get('starting_ease') / 100,
    hard_multiplier: Settings.get('hard_multiplier') / 100,
    easy_multiplier: Settings.get('easy_multiplier') / 100,
    interval_multiplier: Settings.get('interval_multiplier') / 100,
    maximum_review_interval: Settings.get('maximum_review_interval'),
    leech_threshold: Settings.get('leech_threshold'),
    lapse_multiplier: Settings.get('lapse_multiplier') / 100,
    minimum_lapse_interval: Settings.get('minimum_lapse_interval'),
    // Use a pseudo-random fuzz factor based on timestamp to avoid clustering.
    // Anki uses card_id + reps; we approximate with timestamp fractional part.
    fuzz_factor: (Date.now() % 10000) / 10000,
  };
}

// Reconstruct an Anki NormalState from an item's stored ankiState field.
// Injects the elapsed time which changes dynamically.
function reconstructState(item, ts) {
  const ankiState = item.ankiState;

  // No stored state — synthesize from legacy data
  if (!ankiState) {
    if (!item.attempts || item.attempts === 0) {
      return {New: {position: 0}};
    }
    // Migrated card: treat as Review
    const scheduledDays = (item.last && item.next > item.last)
      ? Math.max(1, Math.round((item.next - item.last) / kOneDay))
      : 1;
    const elapsedDays = item.last
      ? Math.max(0, Math.floor((ts - item.last) / kOneDay))
      : scheduledDays;
    return {
      Review: {
        scheduled_days: scheduledDays,
        elapsed_days: elapsedDays,
        ease_factor: 2.5,
        lapses: Math.max(0, (item.attempts || 0) - (item.successes || 0)),
        leeched: false,
      }
    };
  }

  // Inject current elapsed time into the stored state
  if (ankiState.Review) {
    const elapsedDays = item.last
      ? Math.max(0, Math.floor((ts - item.last) / kOneDay))
      : ankiState.Review.scheduled_days;
    return {
      Review: {
        ...ankiState.Review,
        elapsed_days: elapsedDays,
      }
    };
  }

  if (ankiState.Learning) {
    const elapsedSecs = item.last
      ? Math.max(0, ts - item.last)
      : 0;
    return {
      Learning: {
        ...ankiState.Learning,
        elapsed_secs: elapsedSecs,
      }
    };
  }

  if (ankiState.Relearning) {
    const elapsedSecs = item.last
      ? Math.max(0, ts - item.last)
      : 0;
    return {
      Relearning: {
        learning: {
          ...ankiState.Relearning.learning,
          elapsed_secs: elapsedSecs,
        },
        review: {
          ...ankiState.Relearning.review,
          elapsed_days: item.last
            ? Math.max(0, Math.floor((ts - item.last) / kOneDay))
            : ankiState.Relearning.review.scheduled_days,
        },
      }
    };
  }

  // New state or unknown — default to New
  return ankiState;
}

// Determine if a state represents Learning or Relearning (needs failure deck).
function isLearningState(state) {
  return !!(state.Learning || state.Relearning);
}

// Main export: compute scheduling result for a completed card.
//
// Arguments:
//   item - materialized vocabulary item (word, last, next, ..., ankiState)
//   result - Inkstone grade: 0=perfect, 1=good, 2=ok, 3=fail
//   ts - current unix timestamp in seconds
//
// Returns: { interval, ankiState, failed }
//   interval - seconds until next review
//   ankiState - new NormalState object to store
//   failed - whether card should enter the failures deck
export function getSchedulingResult(item, result, ts) {
  const ratingName = kRatingMap[result] || 'again';
  const currentState = reconstructState(item, ts);
  const config = buildConfig();

  const states = nextStates(currentState, config);
  if (!states) {
    // WASM not loaded yet — fallback: use a simple interval
    console.warn('Anki WASM not ready, using fallback interval');
    const fallbackIntervals = [28 * kOneDay, 7 * kOneDay, kOneDay, 600];
    return {
      interval: fallbackIntervals[result] || 600,
      ankiState: null,
      failed: result >= 3,
    };
  }

  const newState = states[ratingName];
  if (!newState) {
    console.error('Invalid rating:', ratingName, 'from result:', result);
    return { interval: 600, ankiState: null, failed: true };
  }

  // Compute interval in seconds from the new state.
  // Use 12 hours as a default secs_until_rollover (conservative).
  const interval = intervalSecs(newState, 43200);

  // Cards in Learning or Relearning state should re-enter via the failures deck
  // so they can be shown again within the session.
  const failed = isLearningState(newState);

  return {
    interval,
    ankiState: newState,
    failed,
  };
}
