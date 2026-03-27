#!/usr/bin/env node
const { assert, eq, summary, loadModule } = require('./test-helpers.cjs');

console.log('=== Unit Tests: lib/decomposition.js ===\n');

const { Decomposition } = loadModule('lib/decomposition.js');
const D = Decomposition;

// [1] IDS data
console.log('[1] IDS operators');
assert(Object.keys(D.ids_data).length === 12, '12 IDS operators defined');
assert(D.ids_data['⿰'].arity === 2, '⿰ has arity 2');
assert(D.ids_data['⿳'].arity === 3, '⿳ has arity 3');

// [2] Simple character → tree → decomposition round-trip
console.log('\n[2] Round-trip: simple character');
const tree1 = D.convertDecompositionToTree('木');
assert(tree1.type === 'character', 'single char → character node');
assert(tree1.value === '木', 'value is 木');
assert(D.convertTreeToDecomposition(tree1) === '木', 'round-trip identity');

// [3] Binary compound
console.log('\n[3] Round-trip: binary compound');
const tree2 = D.convertDecompositionToTree('⿰木木');
assert(tree2.type === 'compound', 'compound type');
assert(tree2.value === '⿰', 'operator ⿰');
assert(tree2.children.length === 2, '2 children');
assert(tree2.children[0].value === '木', 'left child');
assert(tree2.children[1].value === '木', 'right child');
assert(D.convertTreeToDecomposition(tree2) === '⿰木木', 'round-trip identity');

// [4] Ternary compound
console.log('\n[4] Round-trip: ternary compound');
const tree3 = D.convertDecompositionToTree('⿳一二三');
assert(tree3.children.length === 3, '3 children for ⿳');
assert(D.convertTreeToDecomposition(tree3) === '⿳一二三', 'round-trip identity');

// [5] Nested compound
console.log('\n[5] Round-trip: nested');
const input5 = '⿰⿱一二三';
const tree5 = D.convertDecompositionToTree(input5);
assert(tree5.type === 'compound', 'root is compound');
assert(tree5.children[0].type === 'compound', 'left child is compound');
assert(tree5.children[0].children[0].value === '一', 'nested child');
assert(D.convertTreeToDecomposition(tree5) === input5, 'round-trip identity');

// [6] Unknown component
console.log('\n[6] Unknown component (？)');
const tree6 = D.convertDecompositionToTree('⿰木？');
assert(tree6.children[1].type === 'character', 'unknown is character type');
assert(tree6.children[1].value === '?', 'unknown value is ?');
assert(D.convertTreeToDecomposition(tree6) === '⿰木？', 'round-trip with unknown');

// [7] Null/undefined input
console.log('\n[7] Null input');
const tree7 = D.convertDecompositionToTree(null);
assert(tree7.type === 'character' && tree7.value === '?', 'null → unknown component');

// [8] collectComponents
console.log('\n[8] collectComponents()');
const tree8 = D.convertDecompositionToTree('⿰⿱木火水');
const comps = D.collectComponents(tree8);
assert(eq(comps, ['木', '火', '水']), 'collects all leaf characters');

const tree8b = D.convertDecompositionToTree('⿰木？');
const comps8b = D.collectComponents(tree8b);
assert(eq(comps8b, ['木']), 'excludes ? from components');

// [9] getSubtree
console.log('\n[9] getSubtree()');
const tree9 = D.convertDecompositionToTree('⿰⿱一二三');
assert(D.getSubtree(tree9, []).value === '⿰', 'empty path → root');
assert(D.getSubtree(tree9, [0]).value === '⿱', 'path [0] → left child');
assert(D.getSubtree(tree9, [0, 0]).value === '一', 'path [0,0] → 一');
assert(D.getSubtree(tree9, [0, 1]).value === '二', 'path [0,1] → 二');
assert(D.getSubtree(tree9, [1]).value === '三', 'path [1] → 三');

// [10] Path data augmentation
console.log('\n[10] Path augmentation');
assert(eq(tree9.path, []), 'root path is []');
assert(eq(tree9.children[0].path, [0]), 'first child path is [0]');
assert(eq(tree9.children[0].children[1].path, [0, 1]), 'nested path is [0,1]');

// [11] All IDS operators round-trip
console.log('\n[11] All operators round-trip');
for (const [op, data] of Object.entries(D.ids_data)) {
  const chars = '木火水'.substring(0, data.arity);
  const input = op + chars;
  const tree = D.convertDecompositionToTree(input);
  const output = D.convertTreeToDecomposition(tree);
  assert(output === input, `${op} (arity ${data.arity}) round-trips`);
}

summary();
