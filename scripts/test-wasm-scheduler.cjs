#!/usr/bin/env node
// Quick test: verify the Anki scheduler WASM module works correctly.
const path = require('path');
const wasm = require(path.join(__dirname, '..', 'rust', 'anki-scheduler', 'pkg-node', 'anki_scheduler.js'));

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

const { next_states, interval_secs, default_config } = wasm;

console.log('=== WASM Anki Scheduler Tests ===\n');

// [1] Default config
console.log('[1] Default config');
const config = JSON.parse(default_config());
assert(config.initial_ease_factor === 2.5, 'initial_ease_factor = 2.5');
assert(config.hard_multiplier === 1.2, 'hard_multiplier = 1.2');
assert(config.easy_multiplier === 1.3, 'easy_multiplier = 1.3');
assert(JSON.stringify(config.learn_steps) === '[1,10]', 'learn_steps = [1, 10]');
assert(JSON.stringify(config.relearn_steps) === '[10]', 'relearn_steps = [10]');
assert(config.graduating_interval_good === 1, 'graduating_interval_good = 1');
assert(config.graduating_interval_easy === 4, 'graduating_interval_easy = 4');
assert(config.maximum_review_interval === 36500, 'maximum_review_interval = 36500');
assert(config.leech_threshold === 8, 'leech_threshold = 8');

// [2] New card → learning steps
console.log('\n[2] New card states');
const newState = JSON.stringify({ New: { position: 0 } });
const configJson = JSON.stringify(config);
const result = JSON.parse(next_states(newState, configJson));
assert(!result.error, 'no error');
// Again should be Learning with step[0] = 60 secs
assert(result.again.Learning !== undefined, 'again → Learning');
assert(result.again.Learning.scheduled_secs === 60, 'again → 60 secs (1 min step)');
// Hard should be Learning with averaged delay
assert(result.hard.Learning !== undefined, 'hard → Learning');
assert(result.hard.Learning.scheduled_secs === 330, 'hard → 330 secs (avg of 1m and 10m)');
// Good should be Learning with step[1] = 600 secs
assert(result.good.Learning !== undefined, 'good → Learning');
assert(result.good.Learning.scheduled_secs === 600, 'good → 600 secs (10 min step)');
// Easy should graduate to Review
assert(result.easy.Review !== undefined, 'easy → Review (graduate)');
assert(result.easy.Review.scheduled_days === 4, 'easy → 4 days (graduating_interval_easy)');
assert(result.easy.Review.ease_factor === 2.5, 'ease_factor = 2.5');

// [3] Learning card, last step → graduation on Good
console.log('\n[3] Learning card graduation');
const learnState = JSON.stringify({
  Learning: { remaining_steps: 1, scheduled_secs: 600, elapsed_secs: 0 }
});
const learnResult = JSON.parse(next_states(learnState, configJson));
// Good with remaining_steps=1 and 2 steps → no more steps → graduate
assert(learnResult.good.Review !== undefined, 'good → Review (graduate from last step)');
assert(learnResult.good.Review.scheduled_days === 1, 'good → 1 day (graduating_interval_good)');

// [4] Review card intervals (no fuzz)
console.log('\n[4] Review card intervals');
const reviewConfig = JSON.stringify({ ...config, fuzz_factor: null });
const reviewState = JSON.stringify({
  Review: { scheduled_days: 10, elapsed_days: 10, ease_factor: 2.5, lapses: 0, leeched: false }
});
const reviewResult = JSON.parse(next_states(reviewState, reviewConfig));
// Hard: 10 * 1.2 = 12
assert(reviewResult.hard.Review.scheduled_days === 12, 'hard → 12 days (10 * 1.2)');
// Good: 10 * 2.5 = 25
assert(reviewResult.good.Review.scheduled_days === 25, 'good → 25 days (10 * 2.5)');
// Easy: 10 * 2.5 * 1.3 = 32.5 → 33
assert(reviewResult.easy.Review.scheduled_days === 33, 'easy → 33 days (10 * 2.5 * 1.3)');
// Again → Relearning with relearn step
assert(reviewResult.again.Relearning !== undefined, 'again → Relearning');
assert(reviewResult.again.Relearning.learning.scheduled_secs === 600, 'again → 600s relearn step');

// [5] Ease factor changes
console.log('\n[5] Ease factor changes');
assert(Math.abs(reviewResult.hard.Review.ease_factor - 2.35) < 0.001, 'hard: ease -= 0.15 → 2.35');
assert(reviewResult.good.Review.ease_factor === 2.5, 'good: ease unchanged → 2.5');
assert(Math.abs(reviewResult.easy.Review.ease_factor - 2.65) < 0.001, 'easy: ease += 0.15 → 2.65');
assert(Math.abs(reviewResult.again.Relearning.review.ease_factor - 2.3) < 0.001, 'again: ease -= 0.20 → 2.30');

// [6] Days late bonus
console.log('\n[6] Late review bonus');
const lateState = JSON.stringify({
  Review: { scheduled_days: 10, elapsed_days: 20, ease_factor: 2.5, lapses: 0, leeched: false }
});
const lateResult = JSON.parse(next_states(lateState, reviewConfig));
// Good: (10 + 10/2) * 2.5 = 15 * 2.5 = 37.5 → 38
assert(lateResult.good.Review.scheduled_days === 38, 'good late → 38 days ((10+5)*2.5)');
// Hard: 10 * 1.2 = 12
assert(lateResult.hard.Review.scheduled_days === 12, 'hard late → 12 days (10 * 1.2)');
// Easy: (10+10) * 2.5 * 1.3 = 65
assert(lateResult.easy.Review.scheduled_days === 65, 'easy late → 65 days ((10+10)*2.5*1.3)');

// [7] interval_secs function
console.log('\n[7] interval_secs');
const reviewForIvl = JSON.stringify({
  Review: { scheduled_days: 7, elapsed_days: 7, ease_factor: 2.5, lapses: 0, leeched: false }
});
const secs = interval_secs(reviewForIvl, 43200); // 12 hours until rollover
assert(secs === 7 * 86400, `review 7 days → ${secs} secs`);

const learnForIvl = JSON.stringify({
  Learning: { remaining_steps: 2, scheduled_secs: 600, elapsed_secs: 0 }
});
const learnSecs = interval_secs(learnForIvl, 43200);
assert(learnSecs === 600, `learning 600s → ${learnSecs} secs`);

// [8] Ease factor floor
console.log('\n[8] Ease factor floor at 1.3');
const lowEaseState = JSON.stringify({
  Review: { scheduled_days: 10, elapsed_days: 10, ease_factor: 1.35, lapses: 0, leeched: false }
});
const lowEaseResult = JSON.parse(next_states(lowEaseState, reviewConfig));
// Hard: 1.35 - 0.15 = 1.20 → clamped to 1.3
assert(lowEaseResult.hard.Review.ease_factor === 1.3, 'hard: ease floor at 1.3');
// Again: 1.35 - 0.20 = 1.15 → clamped to 1.3
assert(lowEaseResult.again.Relearning.review.ease_factor === 1.3, 'again: ease floor at 1.3');

// [9] Relearning state
console.log('\n[9] Relearning card');
const relearnState = JSON.stringify({
  Relearning: {
    learning: { remaining_steps: 1, scheduled_secs: 600, elapsed_secs: 0 },
    review: { scheduled_days: 5, elapsed_days: 5, ease_factor: 2.0, lapses: 1, leeched: false }
  }
});
const relearnResult = JSON.parse(next_states(relearnState, reviewConfig));
// Good with remaining_steps=1 → no more relearn steps → back to review
assert(relearnResult.good.Review !== undefined, 'good → Review (re-graduate)');
assert(relearnResult.good.Review.scheduled_days === 5, 'good → preserved scheduled_days');
assert(relearnResult.good.Review.ease_factor === 2.0, 'good → preserved ease_factor');
// Easy → review with +1 day
assert(relearnResult.easy.Review !== undefined, 'easy → Review');
assert(relearnResult.easy.Review.scheduled_days === 6, 'easy → scheduled_days + 1');

// [10] Leech detection
console.log('\n[10] Leech detection');
const leechState = JSON.stringify({
  Review: { scheduled_days: 10, elapsed_days: 10, ease_factor: 2.0, lapses: 7, leeched: false }
});
const leechResult = JSON.parse(next_states(leechState, reviewConfig));
// lapses goes from 7 to 8 = leech_threshold → leeched!
assert(leechResult.again.Relearning.review.leeched === true, 'lapses 7→8 hits threshold → leeched');

const notLeechState = JSON.stringify({
  Review: { scheduled_days: 10, elapsed_days: 10, ease_factor: 2.0, lapses: 6, leeched: false }
});
const notLeechResult = JSON.parse(next_states(notLeechState, reviewConfig));
assert(notLeechResult.again.Relearning.review.leeched === false, 'lapses 6→7 not at threshold');

// Summary
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
