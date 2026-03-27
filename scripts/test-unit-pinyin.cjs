#!/usr/bin/env node
const { assert, eq, summary, loadModule } = require('./test-helpers.cjs');

console.log('=== Unit Tests: lib/pinyin.js ===\n');

const { numbersToTones } = loadModule('lib/pinyin.js');

const t = (input, expected, desc) => {
  const r = numbersToTones(input);
  assert(r.result === expected, `${desc}: "${input}" → "${expected}" (got "${r.result || r.error}")`);
};
const terr = (input, desc) => {
  const r = numbersToTones(input);
  assert(r.error !== undefined, `${desc}: "${input}" → error (got "${r.result || r.error}")`);
};

// [1] Basic tones 1-4 + neutral
console.log('[1] Basic tone marks');
t('ma1', 'mā', 'tone 1');
t('ma2', 'má', 'tone 2');
t('ma3', 'mǎ', 'tone 3');
t('ma4', 'mà', 'tone 4');
t('ma5', 'ma', 'tone 5 (neutral)');
t('ma', 'ma', 'no tone number = neutral');

// [2] Tone placement — a/e always get the mark
console.log('\n[2] Tone placement rules');
t('bai4', 'bài', 'a gets tone in ai');
t('lei2', 'léi', 'e gets tone in ei');
t('gao1', 'gāo', 'a gets tone in ao');
t('mei2', 'méi', 'e gets tone in ei');

// [3] Tone placement — ou: o gets the mark
t('dou1', 'dōu', 'o gets tone in ou');
t('gou3', 'gǒu', 'o gets tone in ou');

// [4] Two-syllable vowels — second vowel gets mark
console.log('\n[3] Two-syllable vowels');
t('lian2', 'lián', 'ia: a gets tone');
t('dui4', 'duì', 'ui: i gets tone');
t('xue2', 'xué', 'ue: e gets tone');
t('luo4', 'luò', 'uo: o gets tone');
t('gui4', 'guì', 'ui: i gets tone');

// [5] ü handling
console.log('\n[4] ü handling');
t('nv3', 'nǚ', 'nv → nü with tone');
t('lv4', 'lǜ', 'lv → lü with tone');

// [6] Multi-syllable
console.log('\n[5] Multi-syllable');
t('ni3hao3', 'nǐhǎo', 'ni3hao3 two syllables');
t('zhong1guo2', 'zhōngguó', 'zhong1guo2');
t('bei3jing1', 'běijīng', 'bei3jing1');

// [7] Consonant clusters: zh, ch, sh
console.log('\n[6] Consonant clusters');
t('zhi1', 'zhī', 'zh consonant');
t('chi1', 'chī', 'ch consonant');
t('shi4', 'shì', 'sh consonant');

// [8] r special case
console.log('\n[7] r special case');
t('r', 'r', 'bare r');
t('r5', 'r', 'r5 = r');

// [9] er suffix (erhua)
console.log('\n[8] er suffix');
t('er2', 'ér', 'er with tone');

// [10] Separator characters
console.log('\n[9] Separators');
t("xi1'an1", "xī'ān", 'apostrophe separator');

// [11] u: notation → ü
console.log('\n[10] u: notation');
t('nu:3', 'nǚ', 'u: converts to ü');

// [12] Capitalization
console.log('\n[11] Capitalization');
// numberToTone lowercases, but numbersToTones preserves initial cap
t('Yi1', 'Yī', 'Capital initial preserved');

// [13] Error cases
console.log('\n[12] Error cases');
terr('XX1', 'uppercase input → error');

summary();
