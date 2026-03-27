#!/usr/bin/env node
/**
 * System test: simulates a full Anki-style session in Node.js.
 *
 * Mocks the Vocabulary data structures and shuffle logic to test:
 * - Learning cards come back at the right time
 * - Due learning cards preempt reviews
 * - Full card lifecycle: New → Learning → Review → Relearning
 *
 * Uses the real WASM scheduler for interval/state computation.
 */
const path = require('path');
const wasm = require(path.join(__dirname, '..', 'rust', 'anki-scheduler', 'pkg-node', 'anki_scheduler.js'));

const { next_states, interval_secs } = wasm;

let passed = 0, failed = 0;
const pass = (msg) => { passed++; console.log(`  ✓ ${msg}`); };
const fail = (msg) => { failed++; console.error(`  ✗ ${msg}`); };
const assert = (cond, msg) => cond ? pass(msg) : fail(msg);

// === Mock vocabulary store ===
// Each entry: { word, last, next, attempts, successes, failed, ankiState }
const cards = {};

function addCard(word) {
  cards[word] = {
    word, last: null, next: null, attempts: 0, successes: 0,
    failed: false, ankiState: null,
  };
}

// === WASM scheduler adapter (same logic as adapter.js) ===
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
    if (!item.attempts || item.attempts === 0) return { New: { position: 0 } };
    const sd = (item.last && item.next > item.last)
      ? Math.max(1, Math.round((item.next - item.last) / kOneDay)) : 1;
    const ed = item.last ? Math.max(0, Math.floor((ts - item.last) / kOneDay)) : sd;
    return { Review: { scheduled_days: sd, elapsed_days: ed, ease_factor: 2.5,
      lapses: Math.max(0, (item.attempts||0) - (item.successes||0)), leeched: false } };
  }
  if (s.Review) return { Review: { ...s.Review, elapsed_days: item.last
    ? Math.max(0, Math.floor((ts - item.last) / kOneDay)) : s.Review.scheduled_days } };
  if (s.Learning) return { Learning: { ...s.Learning,
    elapsed_secs: item.last ? Math.max(0, ts - item.last) : 0 } };
  if (s.Relearning) return { Relearning: {
    learning: { ...s.Relearning.learning, elapsed_secs: item.last ? Math.max(0, ts - item.last) : 0 },
    review: { ...s.Relearning.review, elapsed_days: item.last
      ? Math.max(0, Math.floor((ts - item.last) / kOneDay))
      : s.Relearning.review.scheduled_days } } };
  return s;
}

function reviewCard(word, result, ts) {
  const item = cards[word];
  const rating = ratingMap[result];
  const state = reconstructState(item, ts);
  const statesJson = next_states(JSON.stringify(state), config);
  const states = JSON.parse(statesJson);
  const newState = states[rating];
  const interval = interval_secs(JSON.stringify(newState), 43200);
  const isLearning = !!(newState.Learning || newState.Relearning);

  item.last = ts;
  item.next = interval > 0 ? ts + interval : ts;
  item.attempts += 1;
  item.successes += (result < 3 ? 1 : 0);
  item.failed = isLearning;
  item.ankiState = newState;
  return { interval, ankiState: newState, failed: isLearning };
}

// === Mock session/shuffle logic ===
// Simulates Inkstone's card selection with the proposed fix:
// Priority: due learning > adds/reviews > not-yet-due learning > done

function getNewCards() {
  return Object.values(cards).filter(c => c.attempts === 0);
}

function getReviewCards(ts) {
  return Object.values(cards).filter(c => c.attempts > 0 && !c.failed && c.next <= ts);
}

function getDueFailures(ts) {
  return Object.values(cards).filter(c => c.failed && c.next <= ts);
}

function getAllFailures() {
  return Object.values(cards).filter(c => c.failed);
}

function shuffle(ts) {
  // PROPOSED FIX: due learning cards first
  const dueLearn = getDueFailures(ts);
  if (dueLearn.length > 0) {
    // Pick the most overdue one
    dueLearn.sort((a, b) => (a.next || 0) - (b.next || 0));
    return { card: dueLearn[0], deck: 'failures' };
  }

  const newCards = getNewCards();
  const reviews = getReviewCards(ts);
  if (newCards.length + reviews.length > 0) {
    const idx = Math.random() * (newCards.length + reviews.length);
    if (idx < newCards.length) return { card: newCards[0], deck: 'adds' };
    return { card: reviews[0], deck: 'reviews' };
  }

  const allFail = getAllFailures();
  if (allFail.length > 0) {
    return { card: allFail[0], deck: 'failures_waiting' };
  }

  return null; // session done
}

// OLD shuffle (current broken behavior): failures last
function shuffleOld(ts) {
  const newCards = getNewCards();
  const reviews = getReviewCards(ts);
  if (newCards.length + reviews.length > 0) {
    const idx = Math.random() * (newCards.length + reviews.length);
    if (idx < newCards.length) return { card: newCards[0], deck: 'adds' };
    return { card: reviews[0], deck: 'reviews' };
  }
  const allFail = getAllFailures();
  if (allFail.length > 0) return { card: allFail[0], deck: 'failures' };
  return null;
}

function stateType(ankiState) {
  if (!ankiState) return 'null';
  return Object.keys(ankiState)[0];
}

// === TESTS ===
console.log('=== Session Scheduling Tests ===\n');

// [1] New card → Good → Learning(600s)
console.log('[1] New card + Good → Learning with 10min step');
addCard('一');
let ts = 1000000;
let res = reviewCard('一', 1, ts); // Good
assert(stateType(res.ankiState) === 'Learning', `state = Learning (got ${stateType(res.ankiState)})`);
assert(res.ankiState.Learning.scheduled_secs === 600, `step = 600s`);
assert(res.failed === true, 'failed = true (needs retry)');
assert(cards['一'].next === ts + 600, `next = ts + 600`);

// [2] Not-yet-due: 300s later, card should NOT be picked
console.log('\n[2] 300s later → learning card NOT yet due');
ts += 300;
let pick = shuffle(ts);
assert(!pick || pick.card.word !== '一' || pick.deck === 'failures_waiting',
  'card not picked as due (timer not expired)');

// [3] Due: 600s later, card SHOULD be picked
console.log('\n[3] 600s later → learning card IS due');
ts += 300; // total +600 from review
pick = shuffle(ts);
assert(pick && pick.card.word === '一' && pick.deck === 'failures',
  'due learning card picked with priority');

// [4] Priority over reviews: add a review card, learning card still goes first
console.log('\n[4] Due learning card preempts reviews');
addCard('二');
cards['二'].attempts = 1;
cards['二'].successes = 1;
cards['二'].last = ts - kOneDay;
cards['二'].next = ts - 100; // overdue review
cards['二'].ankiState = { Review: { scheduled_days: 1, elapsed_days: 1, ease_factor: 2.5, lapses: 0, leeched: false } };
pick = shuffle(ts);
assert(pick && pick.card.word === '一' && pick.deck === 'failures',
  `learning card (一) picked over review (二): got ${pick ? pick.card.word : 'null'}`);

// [5] Old shuffle: would pick review instead
console.log('\n[5] OLD shuffle (broken): review picked instead of due learning');
let oldPick = shuffleOld(ts);
assert(oldPick && oldPick.card.word === '二',
  `old shuffle picks review: got ${oldPick ? oldPick.card.word : 'null'}`);

// [6] Full lifecycle: New → Again(60s) → Good(600s) → Good(graduates)
console.log('\n[6] Full lifecycle: New → learning steps → graduation');
// Reset
Object.keys(cards).forEach(k => delete cards[k]);
addCard('三');
ts = 2000000;

// Step 1: New → Again → Learning(60s, step 0)
res = reviewCard('三', 3, ts); // Again
assert(stateType(res.ankiState) === 'Learning', 'Again → Learning');
assert(res.ankiState.Learning.scheduled_secs === 60, 'Again → 60s step');
assert(res.ankiState.Learning.remaining_steps === 2, 'remaining_steps = 2');

// Wait 60s
ts += 60;
pick = shuffle(ts);
assert(pick && pick.card.word === '三', 'card due after 60s');

// Step 2: Learning → Good → Learning(600s, step 1)
res = reviewCard('三', 1, ts); // Good
assert(stateType(res.ankiState) === 'Learning', 'Good → still Learning');
assert(res.ankiState.Learning.scheduled_secs === 600, 'Good → 600s step');
assert(res.ankiState.Learning.remaining_steps === 1, 'remaining_steps = 1');

// Not due yet at +300s
ts += 300;
pick = shuffle(ts);
assert(!pick || pick.deck === 'failures_waiting', 'not due at +300s');

// Due at +600s
ts += 300;
pick = shuffle(ts);
assert(pick && pick.card.word === '三', 'card due after 600s');

// Step 3: Learning (last step) → Good → Review (graduation!)
res = reviewCard('三', 1, ts); // Good
assert(stateType(res.ankiState) === 'Review', `graduated to Review (got ${stateType(res.ankiState)})`);
assert(res.ankiState.Review.scheduled_days === 1, 'graduating interval = 1 day');
assert(res.ankiState.Review.ease_factor === 2.5, 'ease = 2.5');
assert(res.failed === false, 'not failed (no longer in learning)');
assert(cards['三'].next === ts + kOneDay, 'next review in 1 day');

// [7] Review → Again → Relearning with step
console.log('\n[7] Review card → Again → Relearning');
ts += kOneDay; // next day
res = reviewCard('三', 3, ts); // Again on review card
assert(stateType(res.ankiState) === 'Relearning', `Again → Relearning (got ${stateType(res.ankiState)})`);
assert(res.ankiState.Relearning.learning.scheduled_secs === 600, 'relearn step = 600s');
assert(res.failed === true, 'failed = true');
assert(Math.abs(res.ankiState.Relearning.review.ease_factor - 2.3) < 0.01, 'ease dropped to 2.3');

// Wait for relearn step
ts += 600;
pick = shuffle(ts);
assert(pick && pick.card.word === '三', 'relearn card due after 600s');

// Good on relearn → back to Review
res = reviewCard('三', 1, ts); // Good
assert(stateType(res.ankiState) === 'Review', `re-graduated to Review (got ${stateType(res.ankiState)})`);
assert(res.failed === false, 'no longer in learning');

// [8] Ease accumulation: Hard on review
console.log('\n[8] Ease decreases on Hard');
ts += kOneDay;
const easeBefore = cards['三'].ankiState.Review.ease_factor;
res = reviewCard('三', 2, ts); // Hard
assert(stateType(res.ankiState) === 'Review', 'Hard → stays Review');
assert(Math.abs(res.ankiState.Review.ease_factor - (easeBefore - 0.15)) < 0.01,
  `ease ${easeBefore} → ${res.ankiState.Review.ease_factor} (-0.15)`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
