// Anki SM-2 scheduler types — mirrors the Rust WASM module's JSON interface.

export interface ReviewState {
  scheduled_days: number;
  elapsed_days: number;
  ease_factor: number;
  lapses: number;
  leeched: boolean;
}

export interface LearnState {
  remaining_steps: number;
  scheduled_secs: number;
  elapsed_secs: number;
}

export interface RelearnState {
  learning: LearnState;
  review: ReviewState;
}

export type NormalState =
  | { New: { position: number } }
  | { Learning: LearnState }
  | { Review: ReviewState }
  | { Relearning: RelearnState };

export interface SchedulingStates {
  current: NormalState;
  again: NormalState;
  hard: NormalState;
  good: NormalState;
  easy: NormalState;
  error?: string;
}

export interface SchedulerConfig {
  learn_steps: number[];
  relearn_steps: number[];
  graduating_interval_good: number;
  graduating_interval_easy: number;
  initial_ease_factor: number;
  hard_multiplier: number;
  easy_multiplier: number;
  interval_multiplier: number;
  maximum_review_interval: number;
  leech_threshold: number;
  lapse_multiplier: number;
  minimum_lapse_interval: number;
  fuzz_factor: number | null;
}

export interface SchedulingResult {
  interval: number;
  ankiState: NormalState;
  failed: boolean;
}

export type Rating = 'easy' | 'good' | 'hard' | 'again';
export type InkstoneResult = 0 | 1 | 2 | 3;

// Type guards
export function isNew(s: NormalState): s is { New: { position: number } } {
  return 'New' in s;
}
export function isLearning(s: NormalState): s is { Learning: LearnState } {
  return 'Learning' in s;
}
export function isReview(s: NormalState): s is { Review: ReviewState } {
  return 'Review' in s;
}
export function isRelearning(s: NormalState): s is { Relearning: RelearnState } {
  return 'Relearning' in s;
}
export function isInLearningPhase(s: NormalState): boolean {
  return isLearning(s) || isRelearning(s);
}
