#!/usr/bin/env node
const { assert, approx, summary, loadModule } = require('./test-helpers.cjs');

console.log('=== Unit Tests: lib/animation.js ===\n');

const { getAnimationData } = loadModule('lib/animation.js');

// [1] Single stroke
console.log('[1] Single stroke');
const strokes1 = ['M 0 0 L 100 0'];
const medians1 = [[[0, 0], [100, 0]]];
const result1 = getAnimationData(strokes1, medians1);
assert(result1.animations.length === 1, '1 animation for 1 stroke');
assert(result1.strokes.length === 1, '1 stroke');
assert(result1.animations[0].d === 'M 0 0 L 100 0', 'median path correct');
assert(result1.animations[0].length === 228, 'length = sqrt(100^2) + 128 = 228');
assert(result1.animations[0].width === 128, 'width is 128');
assert(result1.animations[0].clip_id.includes('clip-0'), 'clip_id has index');
assert(result1.animations[0].animation_id.includes('animation-0'), 'animation_id has index');

// [2] Multiple strokes
console.log('\n[2] Multiple strokes');
const strokes2 = ['M 0 0 L 100 0', 'M 0 0 L 0 100'];
const medians2 = [[[0, 0], [100, 0]], [[0, 0], [0, 100]]];
const result2 = getAnimationData(strokes2, medians2);
assert(result2.animations.length === 2, '2 animations');
assert(result2.animations[1].clip_id.includes('clip-1'), 'second clip index');
// Second animation should have a delay > first's delay
const d0 = parseFloat(result2.animations[0].delay);
const d1 = parseFloat(result2.animations[1].delay);
assert(d1 > d0, 'second stroke delayed after first');

// [3] Median path format
console.log('\n[3] Median path format');
const medians3 = [[[10, 20], [30, 40], [50, 60]]];
const result3 = getAnimationData(['X'], medians3);
assert(result3.animations[0].d === 'M 10 20 L 30 40 L 50 60', 'first M, then L');

// [4] Custom options
console.log('\n[4] Custom options');
const result4a = getAnimationData(strokes1, medians1, { speed: 0.06 });
const result4b = getAnimationData(strokes1, medians1, { speed: 0.03 });
const dur4a = parseFloat(result4a.animations[0].duration);
const dur4b = parseFloat(result4b.animations[0].duration);
assert(dur4a < dur4b, 'higher speed → shorter duration');

// [5] Empty strokes
console.log('\n[5] Edge: empty input');
const result5 = getAnimationData([], []);
assert(result5.animations.length === 0, 'no animations for empty input');
assert(result5.strokes.length === 0, 'no strokes');

// [6] Single point median
console.log('\n[6] Single point median');
const result6 = getAnimationData(['X'], [[[50, 50]]]);
assert(result6.animations[0].d === 'M 50 50', 'single point → M only');
assert(result6.animations[0].length === 128, 'length = 0 + kWidth = 128');

summary();
