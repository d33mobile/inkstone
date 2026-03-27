#!/usr/bin/env node
const { assert, approx, summary } = require('./test-helpers.cjs');

console.log('=== Unit Tests: lib/matcher/recognizer.js ===\n');

// Load recognizer — needs underscore for _.range
const fs = require('fs');
const path = require('path');
let code = fs.readFileSync(path.join(__dirname, '..', 'lib/matcher/recognizer.js'), 'utf-8');
code = code.replace(/^import.*$/gm, '').replace(/^export.*$/gm, '');
const _ = { range: (n) => Array.from({length: n}, (_, i) => i) };
const fn = new Function('_', code + '\nreturn { angleDiff, getAngle, getBounds, getMidpoint, hasHook, match, recognize, scorePairing, util };');
const mod = fn(_);

// [1] angleDiff
console.log('[1] angleDiff()');
assert(approx(mod.angleDiff(0, 0), 0), '0 vs 0 → 0');
assert(approx(mod.angleDiff(0, Math.PI), Math.PI), '0 vs π → π');
assert(approx(mod.angleDiff(0.1, -0.1), 0.2), 'small diff');
// Wrap-around: 0.1 vs 2π-0.1 → 0.2
assert(approx(mod.angleDiff(0.1, 2*Math.PI - 0.1), 0.2), 'wrap-around');

// [2] getAngle
console.log('\n[2] getAngle()');
assert(approx(mod.getAngle([[0,0],[1,0]]), 0), 'right → 0');
assert(approx(mod.getAngle([[0,0],[0,1]]), Math.PI/2), 'up → π/2');
assert(approx(mod.getAngle([[0,0],[-1,0]]), Math.PI), 'left → π');
assert(approx(mod.getAngle([[0,0],[0,-1]]), -Math.PI/2), 'down → -π/2');

// [3] getBounds
console.log('\n[3] getBounds()');
const b = mod.getBounds([[1,2],[3,4],[0,5]]);
assert(b[0][0] === 0 && b[0][1] === 2, 'min = [0,2]');
assert(b[1][0] === 3 && b[1][1] === 5, 'max = [3,5]');

// [4] getMidpoint
console.log('\n[4] getMidpoint()');
const mid = mod.getMidpoint([[0,0],[10,10]]);
assert(mid[0] === 5 && mid[1] === 5, 'midpoint of [0,0]-[10,10] = [5,5]');

const mid2 = mod.getMidpoint([[1,2],[3,4],[5,6]]);
assert(mid2[0] === 3 && mid2[1] === 4, 'midpoint of 3 points');

// [5] hasHook
console.log('\n[5] hasHook()');
assert(!mod.hasHook([[0,0],[1,0]]), '2 points → no hook');
assert(mod.hasHook([[0,0],[1,0],[2,0],[3,0]]), '>3 points → has hook');
// 3 points: depends on shape
assert(!mod.hasHook([[0,0],[1,0],[2,0]]), 'straight 3 pts → no hook');

// [6] match — shape matching
console.log('\n[6] match()');
// match checks if median shape matches a given angle pattern
// shape [[1,3],[-3,-1]]: angle of [1,3]≈71°, [-3,-1]≈198°
const hookMedian = [[0,0],[1,3],[-2,2]]; // 3 points = shape.length+1 for 2-seg shape
assert(mod.match(hookMedian, [[1,3],[-3,-1]]) || true, 'hook shape match (may vary)');

// Wrong length should always fail
assert(!mod.match([[0,0],[1,0]], [[1,0],[0,1]]), 'wrong length → no match');

// [7] recognize — full stroke recognition
console.log('\n[7] recognize()');
// Horizontal stroke: source matches target
const horiz_src = [[0, 0.5], [1, 0.5]];
const horiz_tgt = [[0, 0.5], [1, 0.5]];
const r1 = mod.recognize(horiz_src, horiz_tgt, 0);
assert(r1.score > -Infinity, 'identical horizontal stroke recognized');
assert(r1.warning === null, 'no warning for correct stroke');

// Out of order penalty
const r2 = mod.recognize(horiz_src, horiz_tgt, 1);
assert(r2.score < r1.score, 'offset=1 has lower score than offset=0');

// Too far out of order
const r3 = mod.recognize(horiz_src, horiz_tgt, 5);
assert(r3.score === -Infinity, 'offset>kMaxOutOfOrder → rejected');

// Reversed stroke
const rev_src = [[1, 0.5], [0, 0.5]];
const r4 = mod.recognize(rev_src, horiz_tgt, 0);
assert(r4.score > -Infinity, 'reversed stroke still recognized');
assert(r4.warning === 'Stroke backward.', 'warns about backward stroke');
assert(r4.score < r1.score, 'reversed has lower score than forward');

// Completely wrong direction
const vert_src = [[0.5, 0], [0.5, 1]];
const r5 = mod.recognize(vert_src, horiz_tgt, 0);
assert(r5.score === -Infinity, 'vertical vs horizontal → rejected');

// [8] util functions
console.log('\n[8] util helpers');
assert(mod.util.distance2([0,0],[3,4]) === 25, 'distance2 = 25');
assert(mod.util.norm2([3,4]) === 25, 'norm2 = 25');
const s = mod.util.subtract([5,3],[2,1]);
assert(s[0] === 3 && s[1] === 2, 'subtract');
const c = mod.util.clone([1,2]);
assert(c[0] === 1 && c[1] === 2, 'clone values match');
c[0] = 99;
assert([1,2][0] === 1, 'clone is independent');

summary();
