#!/usr/bin/env node
const T = require('./test-helpers.cjs');

console.log('=== Unit Tests: lib/base.js ===\n');

// Load base.js — it sets Date.timestamp and String.prototype.hash globally
const fs = require('fs');
const path = require('path');
let code = fs.readFileSync(path.join(__dirname, '..', 'lib/base.js'), 'utf-8');
code = code.replace(/^import.*$/gm, '').replace(/^export.*$/gm, '');
// Rename assert to _baseAssert to avoid conflict
code = code.replace(/const assert\b/, 'const _baseAssert');
const fn = new Function(code + '\nreturn { kHomePage, _baseAssert };');
const mod = fn();

// [1] assert
console.log('[1] _baseAssert()');
T.assert((() => { try { mod._baseAssert(true, 'ok'); return true; } catch(e) { return false; } })(),
  'assert(true) does not throw');
T.assert((() => { try { mod._baseAssert(false, 'fail'); return false; } catch(e) { return true; } })(),
  'assert(false) throws Error');
T.assert((() => { try { mod._baseAssert(1, 'ok'); return true; } catch(e) { return false; } })(),
  'assert(1) truthy does not throw');
T.assert((() => { try { mod._baseAssert(0, 'fail'); return false; } catch(e) { return true; } })(),
  'assert(0) falsy throws');
T.assert((() => { try { mod._baseAssert(null, 'fail'); return false; } catch(e) { return true; } })(),
  'assert(null) throws');

// [2] Date.timestamp
console.log('\n[2] Date.timestamp()');
const ts = Date.timestamp();
const now = Math.floor(Date.now() / 1000);
T.assert(Math.abs(ts - now) <= 1, 'returns current Unix seconds');
T.assert(typeof ts === 'number' && ts > 1700000000, 'reasonable timestamp value');
T.assert(Number.isInteger(ts), 'returns integer (floor)');

// [3] String.prototype.hash
console.log('\n[3] String.prototype.hash()');
T.assert(typeof ''.hash() === 'number', 'hash returns a number');
T.assert(''.hash() === 0, 'empty string → 0');
T.assert('a'.hash() === 97, '"a" → 97');
T.assert('ab'.hash() === 97 * 31 + 98, '"ab" → Java algorithm');
T.assert('hello'.hash() === 'hello'.hash(), 'deterministic');
T.assert('hello'.hash() !== 'world'.hash(), 'different strings differ');
T.assert('Hello'.hash() === 69609650, '"Hello" matches Java hashCode');
// Negative hashes are valid (Java behavior)
T.assert(typeof '这是一个很长的字符串'.hash() === 'number', 'Chinese string hashes');

// [4] kHomePage
console.log('\n[4] kHomePage');
T.assert(typeof mod.kHomePage === 'string', 'kHomePage is a string');
T.assert(mod.kHomePage.includes('skishore'), 'kHomePage contains skishore');

T.summary();
