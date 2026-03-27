#!/usr/bin/env node
/**
 * Runs all unit and integration tests sequentially.
 * Exit code is non-zero if any test fails.
 */
const { execSync } = require('child_process');
const path = require('path');

const tests = [
  // Phase 1: Pure unit tests
  'test-unit-base.cjs',
  'test-unit-pinyin.cjs',
  'test-unit-decomposition.cjs',
  'test-unit-animation.cjs',
  'test-unit-characters.cjs',
  'test-wasm-scheduler.cjs',
  'test-unit-recognizer.cjs',
  // Phase 2: Data flow test
  'test-study-flow.cjs',
  // Phase 3: Browser integration tests (require puppeteer)
  'test-session-duration.cjs',
  'test-failed-cards.cjs',
  'test-browser-e2e.cjs',
];

let totalPassed = 0;
let totalFailed = 0;
let testsFailed = [];

console.log('=== Running all tests ===\n');

for (const test of tests) {
  const script = path.join(__dirname, test);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Running: ${test}`);
  console.log('='.repeat(60));
  try {
    const output = execSync(`node "${script}"`, {
      cwd: path.join(__dirname, '..'),
      stdio: 'pipe',
      timeout: 180000,
    }).toString();
    console.log(output);
    // Parse results from output
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

console.log('\n' + '='.repeat(60));
console.log('TOTAL RESULTS');
console.log('='.repeat(60));
console.log(`  ${totalPassed} passed, ${totalFailed} failed across ${tests.length} test files`);
if (testsFailed.length > 0) {
  console.log(`  Failed: ${testsFailed.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('  All tests passed!');
}
