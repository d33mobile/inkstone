#!/usr/bin/env node
// Standalone script to generate character data files from makemeahanzi.
// Ported from server/characters.js (Meteor) to plain Node.js.
//
// Usage: node scripts/generate-characters.js /path/to/makemeahanzi
//
// Outputs:
//   cordova-build-override/www/assets/characters_v2/  (256 asset files)
//   cordova-build-override/www/assets/characters.txt  (character list)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

// --- Ported from lib/decomposition.js ---
const ids_data = {
  '⿰': {arity: 2}, '⿱': {arity: 2}, '⿴': {arity: 2},
  '⿵': {arity: 2}, '⿶': {arity: 2}, '⿷': {arity: 2},
  '⿸': {arity: 2}, '⿹': {arity: 2}, '⿺': {arity: 2},
  '⿻': {arity: 2}, '⿳': {arity: 3}, '⿲': {arity: 3},
};
const UNKNOWN_COMPONENT = '？';

const parseSubtree = (decomposition, index) => {
  if (index[0] >= decomposition.length) throw new Error(`Not enough chars in ${decomposition}`);
  const current = decomposition[index[0]];
  index[0] += 1;
  if (ids_data.hasOwnProperty(current)) {
    const result = {type: 'compound', value: current, children: []};
    for (let i = 0; i < ids_data[current].arity; i++) {
      result.children.push(parseSubtree(decomposition, index));
    }
    return result;
  } else if (current === UNKNOWN_COMPONENT) {
    return {type: 'character', value: '?'};
  }
  if (decomposition[index[0]] === '[') {
    index[0] += 3; // skip [x] annotations
  }
  return {type: 'character', value: current};
};

const convertDecompositionToTree = (decomposition) => {
  const index = [0];
  decomposition = decomposition || UNKNOWN_COMPONENT;
  return parseSubtree(decomposition, index);
};

// --- Ported from lib/characters.js ---
const assetForCharacter = (x) => `characters_v2/${Math.floor(x.charCodeAt(0) / 256)}.json`;

// --- Ported from server/characters.js ---
const kDelimiter = 'BREAK';

const parseLine = (line, delimiter) => {
  const pieces = line.trim().split(delimiter);
  if (pieces.length !== 2) throw new Error(`Bad line: ${line.substring(0, 80)}`);
  const row = JSON.parse(pieces[0]);
  const row2 = JSON.parse(pieces[1]);
  if (!row.character) throw new Error(`No character in line`);
  if (row.character !== row2.character) throw new Error(`Character mismatch`);
  for (let key in row2) row[key] = row2[key];
  delete row.normalized_medians;
  return row;
};

const computeComponents = (character, index, rows, result) => {
  result = result || {};
  result[character] = index;
  const data = rows[character];
  if (!data) throw new Error(`Computing component for ${character}.`);
  const match = data.matches[index];
  if (!match) return result;

  let node = convertDecompositionToTree(data.decomposition);
  for (let i of match) {
    if (!node.children) { node = null; break; }
    node = node.children[i];
  }
  if (!node || node.type !== 'character' || !rows[node.value]) {
    throw new Error(`Error matching component for ${character}, ${index}`);
  }

  let child_index = 0;
  for (let i = 0; i < index; i++) {
    if (JSON.stringify(data.matches[i]) === JSON.stringify(match)) child_index += 1;
  }
  return computeComponents(node.value, child_index, rows, result);
};

const augmentRows = (all, rows) => {
  for (let character of all) {
    const row = rows[character];
    row.dependencies = {};
    Array.from(row.decomposition).forEach((x) => {
      if (ids_data[x] || x === '？') return;
      const data = rows[x];
      if (!data) throw new Error(`Missing component of ${character}: ${x}`);
      let value = data.definition || '(unknown)';
      if (data.pinyin.length > 0) value = data.pinyin.join(', ') + ' - ' + value;
      row.dependencies[x] = value;
    });
    row.components = row.strokes.map((x, i) => computeComponents(character, i, rows));
  }
};

const dumpCharacters = (all, rows, outputDir) => {
  const assets = [];
  const contents = {};
  for (let character of all) {
    const asset = assetForCharacter(character);
    if (!contents[asset]) {
      assets.push(asset);
      contents[asset] = [];
    }
    contents[asset].push(rows[character]);
  }
  const charV2Dir = path.join(outputDir, 'characters_v2');
  fs.mkdirSync(charV2Dir, {recursive: true});
  for (let asset of assets) {
    const filename = path.join(outputDir, asset);
    fs.writeFileSync(filename, contents[asset].map(JSON.stringify).join('\n'));
  }
  fs.writeFileSync(path.join(outputDir, 'characters.txt'), all.join('\n'));
  console.log(`Wrote ${assets.length} asset files and characters.txt (${all.length} characters)`);
};

// --- Main ---
const main = () => {
  const makemeahanziDir = process.argv[2];
  if (!makemeahanziDir) {
    console.error('Usage: node scripts/generate-characters.js /path/to/makemeahanzi');
    process.exit(1);
  }

  const dictFile = path.join(makemeahanziDir, 'dictionary.txt');
  const graphFile = path.join(makemeahanziDir, 'graphics.txt');
  if (!fs.existsSync(dictFile) || !fs.existsSync(graphFile)) {
    console.error(`Cannot find dictionary.txt and graphics.txt in ${makemeahanziDir}`);
    process.exit(1);
  }

  const outputDir = path.join(__dirname, '..', 'cordova-build-override', 'www', 'assets');

  // Combine dictionary.txt and graphics.txt using paste
  console.log('Preparing...');
  const spacers = Array.from(kDelimiter).slice(1).map(() => '/dev/null').join(' ');
  const tmpFile = path.join('/tmp', 'makemeahanzi-combined.txt');
  execSync(`paste -d ${kDelimiter} "${dictFile}" ${spacers} "${graphFile}" > "${tmpFile}"`);

  // Read combined file
  console.log('Reading...');
  const data = fs.readFileSync(tmpFile, 'utf-8');
  const rows = {};
  const all = [];
  for (const line of data.split('\n')) {
    if (!line.trim()) continue;
    const row = parseLine(line, kDelimiter);
    rows[row.character] = row;
    all.push(row.character);
  }
  fs.unlinkSync(tmpFile);

  console.log(`Read ${all.length} characters`);
  console.log('Augmenting...');
  augmentRows(all, rows);

  console.log('Dumping...');
  dumpCharacters(all, rows, outputDir);
  console.log('Done!');
};

main();
