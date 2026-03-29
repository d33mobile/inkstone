#!/usr/bin/env node
// Tests the character data loading flow that the app performs at runtime.
// Simulates: readAsset → readList → readCharacter for the demo list.

const http = require('http');
const fs = require('fs');
const path = require('path');

const WWW = path.join(__dirname, '..', 'www');
let PASS = 0, FAIL = 0;
const pass = (msg) => { console.log(`  PASS: ${msg}`); PASS++; };
const fail = (msg) => { console.log(`  FAIL: ${msg}`); FAIL++; };

const readFile = (p) => fs.readFileSync(path.join(WWW, p), 'utf-8');

console.log('=== Study Flow Test ===\n');

// 1. Load characters.txt
console.log('[1] characters.txt');
try {
  const charsTxt = readFile('assets/characters.txt');
  const chars = {};
  charsTxt.split('\n').forEach(line => {
    if (!line || line.startsWith('#')) return;
    chars[line] = (chars[line] || 0) + 1;
  });
  const count = Object.keys(chars).length;
  if (count > 9000) pass(`Loaded ${count} characters`);
  else fail(`Only ${count} characters (expected 9000+)`);
} catch(e) { fail(`Cannot read characters.txt: ${e.message}`); }

// 2. Load demo list
console.log('\n[2] demo.list');
const kListColumns = ['simplified', 'traditional', 'numbered', 'pinyin', 'definition'];
let firstWord = null;
try {
  const listData = readFile('assets/lists/demo.list');
  const rows = [];
  listData.split('\n').forEach(line => {
    const vals = line.split('\t');
    if (vals.length !== kListColumns.length) return;
    const row = {};
    kListColumns.forEach((col, i) => row[col] = vals[i]);
    rows.push(row);
  });
  if (rows.length > 0) {
    pass(`Loaded demo list (${rows.length} words)`);
    firstWord = rows[0].simplified;
    pass(`First word: ${firstWord} (${rows[0].pinyin} - ${rows[0].definition})`);
  } else {
    fail('Demo list is empty');
  }
} catch(e) { fail(`Cannot read demo.list: ${e.message}`); }

// 3. Load character data for first word
console.log('\n[3] Character data loading');
if (firstWord) {
  for (const char of Array.from(firstWord)) {
    const codePoint = char.codePointAt(0);
    const assetNum = Math.floor(codePoint / 256);
    const assetPath = `assets/characters_v2/${assetNum}.json`;
    
    try {
      const data = readFile(assetPath);
      const lines = data.split('\n').filter(x => x);
      let found = null;
      for (const line of lines) {
        const parsed = JSON.parse(line);
        if (parsed.character === char) { found = parsed; break; }
      }
      
      if (!found) {
        fail(`Character ${char} (U+${codePoint.toString(16)}) not found in ${assetPath}`);
        continue;
      }
      
      // Verify character has required fields
      const required = ['character', 'strokes', 'medians', 'decomposition', 'radical'];
      const missing = required.filter(f => !found[f]);
      if (missing.length > 0) {
        fail(`Character ${char} missing fields: ${missing.join(', ')}`);
      } else {
        pass(`${char}: ${found.strokes.length} strokes, ${found.medians.length} medians, radical=${found.radical}`);
      }
      
      // Verify strokes are valid SVG paths
      if (found.strokes.every(s => s.startsWith('M') || s.startsWith('m'))) {
        pass(`${char}: all strokes are valid SVG paths`);
      } else {
        fail(`${char}: some strokes are not valid SVG paths`);
      }
      
    } catch(e) {
      fail(`Cannot load character ${char}: ${e.message}`);
    }
  }
}

// 4. Load nhsk1 (bigger list)
console.log('\n[4] nhsk1.list (full HSK1)');
try {
  const nhsk1 = readFile('assets/lists/nhsk1.list');
  const rows = nhsk1.split('\n').filter(l => l.split('\t').length === 5);
  pass(`nhsk1 has ${rows.length} words`);
  
  // Sample: check 5 random characters from the list have stroke data
  const allChars = new Set();
  rows.forEach(row => {
    const word = row.split('\t')[0]; // simplified
    Array.from(word).filter(c => c.codePointAt(0) > 0xff && c.codePointAt(0) !== 0xfeff).forEach(c => allChars.add(c));
  });
  
  let checked = 0, found = 0;
  for (const char of allChars) {
    if (checked >= 10) break;
    const assetNum = Math.floor(char.codePointAt(0) / 256);
    try {
      const data = readFile(`assets/characters_v2/${assetNum}.json`);
      const lines = data.split('\n').filter(x => x);
      for (const line of lines) {
        const p = JSON.parse(line);
        if (p.character === char) { found++; break; }
      }
    } catch(e) {}
    checked++;
  }
  if (found === checked) pass(`All ${checked} sampled chars found in bundled data`);
  else fail(`Only ${found}/${checked} sampled chars found`);
  
} catch(e) { fail(`Cannot read nhsk1.list: ${e.message}`); }

// 5. radicals.json
console.log('\n[5] radicals.json');
try {
  const radicals = JSON.parse(readFile('assets/radicals.json'));
  if (radicals.radical_to_index_map) {
    const count = Object.keys(radicals.radical_to_index_map).length;
    pass(`radicals.json loaded (${count} entries)`);
  } else {
    fail('radicals.json missing radical_to_index_map');
  }
} catch(e) { fail(`Cannot read radicals.json: ${e.message}`); }

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===`);
process.exit(FAIL > 0 ? 1 : 0);
