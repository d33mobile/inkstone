#!/usr/bin/env node
const { assert, summary } = require('./test-helpers.cjs');

console.log('=== Unit Tests: lib/characters.js ===\n');

// Load — need to mock Match since it's a Meteor global
const fs = require('fs');
const path = require('path');
let code = fs.readFileSync(path.join(__dirname, '..', 'lib/characters.js'), 'utf-8');
code = code.replace(/^import.*$/gm, '').replace(/^export.*$/gm, '');
// Mock Match and check
const Match = {
  Where: (fn) => fn,
  Maybe: (x) => x,
  Integer: 'integer',
};
const check = () => {};
const fn = new Function('Match', 'check', code + '\nreturn { CharacterData, assetForCharacter };');
const { assetForCharacter } = fn(Match, check);

// [1] Known character mappings
console.log('[1] assetForCharacter()');
// 一 = U+4E00 = 19968, floor(19968/256) = 78
assert(assetForCharacter('一') === 'characters_v2/78.json', '一 → 78');
// 的 = U+7684 = 30340, floor(30340/256) = 118
assert(assetForCharacter('的') === 'characters_v2/118.json', '的 → 118');
// A = U+0041 = 65, floor(65/256) = 0
assert(assetForCharacter('A') === 'characters_v2/0.json', 'A → 0');
// 龍 = U+9F8D = 40845, floor(40845/256) = 159
assert(assetForCharacter('龍') === 'characters_v2/159.json', '龍 → 159');

// [2] Consistent format
console.log('\n[2] Format check');
const r = assetForCharacter('中');
assert(r.startsWith('characters_v2/'), 'starts with characters_v2/');
assert(r.endsWith('.json'), 'ends with .json');

// [3] Different characters can map to same file
console.log('\n[3] Collision behavior');
// 一 (19968) and 丁 (19969) differ by 1, both floor to 78
assert(assetForCharacter('一') === assetForCharacter('丁'), '一 and 丁 same bucket');

// [4] Verify against actual asset files
console.log('\n[4] Verify against real files');
const assetsDir = path.join(__dirname, '..', 'www', 'assets');
const charsTxt = fs.readFileSync(path.join(assetsDir, 'characters.txt'), 'utf-8');
const chars = charsTxt.trim().split('\n').filter(l => l && !l.startsWith('#'));
// Sample 10 characters and check their asset files exist
let checked = 0;
for (let i = 0; i < Math.min(10, chars.length); i++) {
  const ch = chars[i * Math.floor(chars.length / 10)];
  const file = path.join(assetsDir, assetForCharacter(ch));
  if (fs.existsSync(file)) checked++;
}
assert(checked === 10, `All 10 sampled characters have asset files (${checked}/10)`);

summary();
