#!/usr/bin/env node
/**
 * Runs all Node.js unit tests (no browser required).
 * Used by the coverage script.
 */
'use strict';
const { execSync } = require('child_process');
const path = require('path');

const tests = [
  'test-unit-base.cjs',
  'test-unit-pinyin.cjs',
  'test-unit-decomposition.cjs',
  'test-unit-animation.cjs',
  'test-unit-characters.cjs',
  'test-wasm-scheduler.cjs',
  'test-unit-recognizer.cjs',
  'test-study-flow.cjs',
  'test-unit-session.cjs',
  'test-unit-ordering.cjs',
  'test-unit-adapter.cjs',
  'test-unit-vocabulary.cjs',
];

let totalPassed = 0, totalFailed = 0, testsFailed = [];

console.log('=== Running unit tests ===\n');

for (const test of tests) {
  const script = path.join(__dirname, test);
  console.log(`\n${'='.repeat(50)}\nRunning: ${test}\n${'='.repeat(50)}`);
  try {
    const output = execSync(`node "${script}"`, {
      cwd: path.join(__dirname, '..'),
      stdio: 'pipe',
      timeout: 120000,
    }).toString();
    console.log(output);
    const match = output.match(/(\d+) passed, (\d+) failed/);
    if (match) {
      totalPassed += parseInt(match[1]);
      totalFailed += parseInt(match[2]);
      if (parseInt(match[2]) > 0) testsFailed.push(test);
    }
  } catch (e) {
    const output = (e.stdout || '').toString() + (e.stderr || '').toString();
    console.log(output);
    const match = output.match(/(\d+) passed, (\d+) failed/);
    if (match) {
      totalPassed += parseInt(match[1]);
      totalFailed += parseInt(match[2]);
    }
    testsFailed.push(test);
  }
}

console.log('\n' + '='.repeat(50));
console.log(`TOTAL: ${totalPassed} passed, ${totalFailed} failed`);
if (testsFailed.length > 0) {
  console.log(`Failed: ${testsFailed.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('All unit tests passed!');
}
