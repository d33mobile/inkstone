// Anki SM-2 adapter — bridges the WASM scheduler to Inkstone's vocabulary model.

import {
  type NormalState,
  type SchedulerConfig,
  type SchedulingResult,
  type Rating,
  type InkstoneResult,
  isReview,
  isLearning,
  isRelearning,
  isInLearningPhase,
} from './types';
import { nextStates, intervalSecs } from './wasm';

const ONE_DAY = 86400;

/** Maps Inkstone result code (0=perfect..3=fail) to Anki rating name. */
const RATING_MAP: Rating[] = ['easy', 'good', 'hard', 'again'];

/** Minimal vocab item shape needed by the adapter. */
export interface AdapterItem {
  word: string;
  last: number | null;
  next: number | null;
  attempts: number;
  successes: number;
  ankiState: NormalState | null;
}

/** Build scheduler config from a settings getter. */
export function buildConfig(getSetting: (key: string) => any): SchedulerConfig {
  const parseSteps = (s: any): number[] => {
    if (!s || typeof s !== 'string') return [];
    return s.split(/\s+/).map(Number).filter((n: number) => !isNaN(n) && n > 0);
  };
  return {
    learn_steps: parseSteps(getSetting('learn_steps')),
    relearn_steps: parseSteps(getSetting('relearn_steps')),
    graduating_interval_good: getSetting('graduating_interval_good'),
    graduating_interval_easy: getSetting('graduating_interval_easy'),
    initial_ease_factor: getSetting('starting_ease') / 100,
    hard_multiplier: getSetting('hard_multiplier') / 100,
    easy_multiplier: getSetting('easy_multiplier') / 100,
    interval_multiplier: getSetting('interval_multiplier') / 100,
    maximum_review_interval: getSetting('maximum_review_interval'),
    leech_threshold: getSetting('leech_threshold'),
    lapse_multiplier: getSetting('lapse_multiplier') / 100,
    minimum_lapse_interval: getSetting('minimum_lapse_interval'),
    fuzz_factor: (Date.now() % 10000) / 10000,
  };
}

/** Reconstruct an Anki NormalState from stored item, injecting elapsed time. */
export function reconstructState(item: AdapterItem, ts: number): NormalState {
  const s = item.ankiState;

  if (!s) {
    // No stored state — synthesize from legacy data
    if (!item.attempts || item.attempts === 0) {
      return { New: { position: 0 } };
    }
    const scheduledDays = (item.last && item.next && item.next > item.last)
      ? Math.max(1, Math.round((item.next - item.last) / ONE_DAY))
      : 1;
    const elapsedDays = item.last
      ? Math.max(0, Math.floor((ts - item.last) / ONE_DAY))
      : scheduledDays;
    return {
      Review: {
        scheduled_days: scheduledDays,
        elapsed_days: elapsedDays,
        ease_factor: 2.5,
        lapses: Math.max(0, (item.attempts || 0) - (item.successes || 0)),
        leeched: false,
      },
    };
  }

  // Inject dynamic elapsed time into stored state
  if (isReview(s)) {
    const elapsedDays = item.last
      ? Math.max(0, Math.floor((ts - item.last) / ONE_DAY))
      : s.Review.scheduled_days;
    return { Review: { ...s.Review, elapsed_days: elapsedDays } };
  }

  if (isLearning(s)) {
    const elapsedSecs = item.last ? Math.max(0, ts - item.last) : 0;
    return { Learning: { ...s.Learning, elapsed_secs: elapsedSecs } };
  }

  if (isRelearning(s)) {
    const elapsedSecs = item.last ? Math.max(0, ts - item.last) : 0;
    const elapsedDays = item.last
      ? Math.max(0, Math.floor((ts - item.last) / ONE_DAY))
      : s.Relearning.review.scheduled_days;
    return {
      Relearning: {
        learning: { ...s.Relearning.learning, elapsed_secs: elapsedSecs },
        review: { ...s.Relearning.review, elapsed_days: elapsedDays },
      },
    };
  }

  return s;
}

/** Compute scheduling result for a completed card. */
export function getSchedulingResult(
  item: AdapterItem,
  result: InkstoneResult,
  ts: number,
  getSetting: (key: string) => any,
): SchedulingResult {
  const rating = RATING_MAP[result] || 'again';
  const currentState = reconstructState(item, ts);
  const config = buildConfig(getSetting);

  const states = nextStates(currentState, config);
  if (!states) {
    // WASM not loaded — fallback
    console.warn('[anki] WASM not ready, using fallback interval');
    const fallbackIntervals = [28 * ONE_DAY, 7 * ONE_DAY, ONE_DAY, 600];
    return {
      interval: fallbackIntervals[result] || 600,
      ankiState: currentState,
      failed: result >= 3,
    };
  }

  const newState = states[rating];
  const interval = intervalSecs(newState, 43200);
  const failed = isInLearningPhase(newState);

  return { interval, ankiState: newState, failed };
}
