#!/usr/bin/env node
/**
 * Unit test: card selection ordering.
 *
 * Tests the logic that decides which card to show next.
 * Due learning cards must preempt new cards and reviews.
 * Uses the same card store simulation as test-unit-session.cjs.
 */
const path = require('path');
const wasm = require(path.join(__dirname, '..', 'rust', 'anki-scheduler', 'pkg-node', 'anki_scheduler.js'));
const { next_states, interval_secs } = wasm;

let passed = 0, failed = 0;
const pass = (msg) => { passed++; console.log(`  ✓ ${msg}`); };
const fail = (msg) => { failed++; console.error(`  ✗ ${msg}`); };
const assert = (cond, msg) => cond ? pass(msg) : fail(msg);

// === Mock card store ===
const cards = {};
function addCard(word, overrides) {
  cards[word] = {
    word, last: null, next: null, attempts: 0, successes: 0,
    failed: false, ankiState: null, ...overrides,
  };
}
function clearCards() { Object.keys(cards).forEach(k => delete cards[k]); }

// === WASM adapter (same as adapter.js) ===
const kOneDay = 86400;
const ratingMap = ['easy', 'good', 'hard', 'again'];
const config = JSON.stringify({
  learn_steps: [1, 10], relearn_steps: [10],
  graduating_interval_good: 1, graduating_interval_easy: 4,
  initial_ease_factor: 2.5, hard_multiplier: 1.2, easy_multiplier: 1.3,
  interval_multiplier: 1.0, maximum_review_interval: 36500, leech_threshold: 8,
  lapse_multiplier: 0.0, minimum_lapse_interval: 1, fuzz_factor: null,
});

function reconstructState(item, ts) {
  const s = item.ankiState;
  if (!s) {
    if (!item.attempts) return { New: { position: 0 } };
    const sd = (item.last && item.next > item.last) ? Math.max(1, Math.round((item.next - item.last) / kOneDay)) : 1;
    return { Review: { scheduled_days: sd, elapsed_days: item.last ? Math.max(0, Math.floor((ts - item.last) / kOneDay)) : sd, ease_factor: 2.5, lapses: Math.max(0, item.attempts - item.successes), leeched: false } };
  }
  if (s.Review) return { Review: { ...s.Review, elapsed_days: item.last ? Math.max(0, Math.floor((ts - item.last) / kOneDay)) : s.Review.scheduled_days } };
  if (s.Learning) return { Learning: { ...s.Learning, elapsed_secs: item.last ? Math.max(0, ts - item.last) : 0 } };
  if (s.Relearning) return { Relearning: { learning: { ...s.Relearning.learning, elapsed_secs: item.last ? Math.max(0, ts - item.last) : 0 }, review: { ...s.Relearning.review, elapsed_days: item.last ? Math.max(0, Math.floor((ts - item.last) / kOneDay)) : s.Relearning.review.scheduled_days } } };
  return s;
}

function reviewCard(word, result, ts) {
  const item = cards[word];
  const state = reconstructState(item, ts);
  const states = JSON.parse(next_states(JSON.stringify(state), config));
  const newState = states[ratingMap[result]];
  const interval = interval_secs(JSON.stringify(newState), 43200);
  const isLearning = !!(newState.Learning || newState.Relearning);
  item.last = ts;
  item.next = interval > 0 ? ts + interval : ts;
  item.attempts += 1;
  item.successes += (result < 3 ? 1 : 0);
  item.failed = isLearning;
  item.ankiState = newState;
}

// === Card selection logic (what the runtime patch should implement) ===

function getNewCards() {
  return Object.values(cards).filter(c => c.attempts === 0);
}

function getReviewCards(ts) {
  return Object.values(cards).filter(c => c.attempts > 0 && !c.failed && c.next <= ts);
}

function getDueFailures(ts) {
  return Object.values(cards).filter(c => c.failed && c.next <= ts);
}

function getNotYetDueFailures() {
  return Object.values(cards).filter(c => c.failed);
}

/**
 * Correct card selection (Anki-style):
 * 1. Due learning cards first
 * 2. New + review cards
 * 3. Not-yet-due failures (wait)
 * 4. Done
 */
function selectNextCard(ts) {
  // Priority 1: due learning cards
  const due = getDueFailures(ts);
  if (due.length > 0) {
    due.sort((a, b) => (a.next || 0) - (b.next || 0));
    return { card: due[0], source: 'due_failure' };
  }
  // Priority 2: new + review
  const newCards = getNewCards();
  const reviews = getReviewCards(ts);
  if (newCards.length + reviews.length > 0) {
    // Alternate — pick first available
    if (newCards.length > 0) return { card: newCards[0], source: 'new' };
    return { card: reviews[0], source: 'review' };
  }
  // Priority 3: not-yet-due failures exist → waiting
  const notYet = getNotYetDueFailures();
  if (notYet.length > 0) return { card: null, source: 'waiting' };
  // Done
  return { card: null, source: 'done' };
}

// === TESTS ===

console.log('=== Card Ordering Unit Tests ===\n');

// [1] Due learning card preempts new cards
console.log('[1] Due learning card preempts new cards');
clearCards();
addCard('一'); // new
addCard('二'); // new
addCard('三', { // failed learning card, due in past
  last: 1000000 - 120, next: 1000000 - 60,
  attempts: 1, successes: 0, failed: true,
  ankiState: { Learning: { remaining_steps: 2, scheduled_secs: 60, elapsed_secs: 0 } },
});
let pick = selectNextCard(1000000);
assert(pick.source === 'due_failure', `due_failure selected (got ${pick.source})`);
assert(pick.card.word === '三', `card 三 selected (got ${pick.card?.word})`);

// [2] No due learning card → new card selected
console.log('\n[2] No due learning card → new card');
clearCards();
addCard('一');
addCard('二');
pick = selectNextCard(1000000);
assert(pick.source === 'new', `new selected (got ${pick.source})`);

// [3] After answering due failure, normal cards resume
console.log('\n[3] After answering due failure, normal flow resumes');
clearCards();
addCard('一');
addCard('三', {
  last: 1000000 - 120, next: 1000000 - 60,
  attempts: 1, successes: 0, failed: true,
  ankiState: { Learning: { remaining_steps: 2, scheduled_secs: 60, elapsed_secs: 0 } },
});
// First pick: due failure
pick = selectNextCard(1000000);
assert(pick.card.word === '三', 'first pick: 三 (due failure)');
// Answer it with Good → advances to next learning step (600s)
reviewCard('三', 1, 1000000);
assert(cards['三'].failed === true, '三 still in learning (600s step)');
assert(cards['三'].next === 1000000 + 600, 'next = +600s');
// Second pick: 三 is NOT due yet (600s hasn't passed)
pick = selectNextCard(1000000 + 1);
assert(pick.source === 'new', `normal flow: ${pick.source} (got ${pick.card?.word})`);
assert(pick.card.word === '一', 'new card 一 selected');

// [4] Timer expiry: learning card becomes due → preempts again
console.log('\n[4] Timer expiry → card comes back');
pick = selectNextCard(1000000 + 601);
assert(pick.source === 'due_failure', `after 601s: due_failure (got ${pick.source})`);
assert(pick.card.word === '三', 'card 三 comes back');

// [5] Not-yet-due failure → waiting state
console.log('\n[5] Not-yet-due failure → waiting');
clearCards();
addCard('三', {
  last: 1000000, next: 1000000 + 300,
  attempts: 1, successes: 0, failed: true,
  ankiState: { Learning: { remaining_steps: 1, scheduled_secs: 600, elapsed_secs: 0 } },
});
pick = selectNextCard(1000000 + 100);
assert(pick.source === 'waiting', `not yet due: ${pick.source}`);
assert(pick.card === null, 'no card to show');

// [6] Multiple due failures → pick most overdue
console.log('\n[6] Multiple due failures → most overdue first');
clearCards();
addCard('一', {
  last: 1000000 - 200, next: 1000000 - 100,
  attempts: 1, successes: 0, failed: true,
  ankiState: { Learning: { remaining_steps: 2, scheduled_secs: 60, elapsed_secs: 0 } },
});
addCard('二', {
  last: 1000000 - 500, next: 1000000 - 400,
  attempts: 1, successes: 0, failed: true,
  ankiState: { Learning: { remaining_steps: 2, scheduled_secs: 60, elapsed_secs: 0 } },
});
pick = selectNextCard(1000000);
assert(pick.card.word === '二', `most overdue: 二 (got ${pick.card?.word})`);

// [7] Full lifecycle: new → fail → wait → comes back → pass → graduated
console.log('\n[7] Full lifecycle');
clearCards();
addCard('一');
addCard('二');
let ts = 2000000;

// Pick new card
pick = selectNextCard(ts);
assert(pick.source === 'new', 'start: new card');

// Fail it → Learning(60s)
reviewCard('一', 3, ts);
assert(cards['一'].failed === true, '一 failed=true');
assert(cards['一'].ankiState.Learning.scheduled_secs === 60, 'step=60s');

// Next pick: 一 is NOT due yet, pick 二 (new)
pick = selectNextCard(ts + 1);
assert(pick.card.word === '二', 'while 一 timer: pick 二');

// Advance clock past 一's timer
ts += 61;
pick = selectNextCard(ts);
assert(pick.source === 'due_failure', 'after 61s: due_failure');
assert(pick.card.word === '一', '一 comes back');

// Answer Good → Learning(600s, step 2)
reviewCard('一', 1, ts);
assert(cards['一'].ankiState.Learning.scheduled_secs === 600, 'step=600s');

// Advance past 600s
ts += 601;
pick = selectNextCard(ts);
assert(pick.card.word === '一', '一 comes back again (step 2)');

// Answer Good → graduates to Review(1 day)
reviewCard('一', 1, ts);
assert(!!cards['一'].ankiState.Review, 'graduated to Review');
assert(cards['一'].failed === false, 'no longer failed');

// Next pick: normal flow
pick = selectNextCard(ts + 1);
assert(pick.source !== 'due_failure', 'normal flow after graduation');

// [8] Review card → fail → relearning → comes back
console.log('\n[8] Review card lapse');
clearCards();
addCard('一');
ts = 3000000;
// Graduate via Easy
reviewCard('一', 0, ts);
assert(!!cards['一'].ankiState.Review, 'Review state');
ts += kOneDay;
// Fail on review → Relearning
reviewCard('一', 3, ts);
assert(!!cards['一'].ankiState.Relearning, 'Relearning state');
assert(cards['一'].failed === true, 'failed=true');
// Wait for relearn step
ts += 601;
pick = selectNextCard(ts);
assert(pick.source === 'due_failure', 'relearning card comes back');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
