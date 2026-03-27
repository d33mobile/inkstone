// Shared test helpers for unit tests.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let _passed = 0, _failed = 0;
const pass = (msg) => { _passed++; console.log(`  PASS: ${msg}`); };
const fail = (msg) => { _failed++; console.log(`  FAIL: ${msg}`); };

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const approx = (a, b, eps) => Math.abs(a - b) < (eps || 0.001);

const assert = (cond, msg) => cond ? pass(msg) : fail(msg);

const summary = () => {
  console.log(`\n=== Results: ${_passed} passed, ${_failed} failed ===`);
  if (_failed > 0) process.exitCode = 1;
  return { passed: _passed, failed: _failed };
};

// Load an ES module source file by stripping import/export and eval'ing.
// Returns an object with all exports.
const loadModule = (relPath, deps) => {
  deps = deps || {};
  let code = fs.readFileSync(path.join(ROOT, relPath), 'utf-8');
  // Remove import lines
  code = code.replace(/^import\s+.*$/gm, '');
  // Collect export names and remove export lines
  const exportNames = [];
  code = code.replace(/^export\s+\{([^}]+)\};?\s*$/gm, (_, names) => {
    names.split(',').forEach(n => exportNames.push(n.trim()));
    return '';
  });
  // Build the function body: inject deps, run code, return exports
  const depsCode = Object.entries(deps)
    .map(([k, v]) => `const ${k} = __deps__['${k}'];`)
    .join('\n');
  const returnCode = exportNames.length
    ? `return {${exportNames.join(',')}};`
    : 'return {};';
  const fn = new Function('__deps__', `${depsCode}\n${code}\n${returnCode}`);
  return fn(deps);
};

module.exports = { pass, fail, assert, eq, approx, summary, loadModule, ROOT };
