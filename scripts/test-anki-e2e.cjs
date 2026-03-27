#!/usr/bin/env node
/**
 * E2E browser test for Anki SM-2 scheduler integration.
 *
 * Injects the WASM scheduler into the running app, patches Vocabulary.updateItem,
 * then tests the full card lifecycle: new → learning → graduation → review → lapse.
 */
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HEADED = process.argv.includes('--headed') || process.env.HEADED === '1';
const PORT = 9880;
const URL = `http://localhost:${PORT}/`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const pass = (msg) => { passed++; console.log(`  ✓ ${msg}`); };
const fail = (msg) => { failed++; console.error(`  ✗ ${msg}`); };
const assert = (cond, msg) => cond ? pass(msg) : fail(msg);

// Read the web-target JS glue (strip ES module syntax for eval in page context)
const webGlue = fs.readFileSync(
  path.join(__dirname, '..', 'rust', 'anki-scheduler', 'pkg', 'anki_scheduler.js'), 'utf8'
)
  // Remove ES module export statements
  .replace(/^export /gm, '')
  // Remove the final "export { ... }" line with "as" syntax
  .replace(/\n\s*\{[^}]*\bas\b[^}]*\}\s*;?\s*$/gm, '')
  // Remove import.meta.url reference (we use initSync, not async init)
  .replace(/import\.meta\.url/g, '"unused"')
  // Make functions available as globals
  + '\nwindow.__anki_initSync = initSync;\n'
  + 'window.__anki_next_states = next_states;\n'
  + 'window.__anki_interval_secs = interval_secs;\n'
  + 'window.__anki_default_config = default_config;\n';

const wasmBytes = fs.readFileSync(
  path.join(__dirname, '..', 'rust', 'anki-scheduler', 'pkg', 'anki_scheduler_bg.wasm')
);
const wasmB64 = wasmBytes.toString('base64');

async function injectWasm(page) {
  // Inject glue code
  await page.evaluate((code) => { eval(code); }, webGlue);
  // Init WASM from base64
  return page.evaluate((b64) => {
    try {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      window.__anki_initSync(bytes.buffer);
      const config = JSON.parse(window.__anki_default_config());
      return { ok: true, ease: config.initial_ease_factor };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, wasmB64);
}

async function patchVocabulary(page) {
  return page.evaluate(() => {
    try {
      const Vocabulary = require('/client/model/vocabulary').Vocabulary;
      if (!Vocabulary) return { error: 'Vocabulary not found' };

      const origUpdate = Vocabulary.updateItem.bind(Vocabulary);
      window.__ankiLog = [];
      const kOneDay = 86400;
      const ratingMap = ['easy', 'good', 'hard', 'again'];

      const config = JSON.stringify({
        learn_steps:[1,10], relearn_steps:[10], graduating_interval_good:1,
        graduating_interval_easy:4, initial_ease_factor:2.5, hard_multiplier:1.2,
        easy_multiplier:1.3, interval_multiplier:1.0, maximum_review_interval:36500,
        leech_threshold:8, lapse_multiplier:0.0, minimum_lapse_interval:1, fuzz_factor:null,
      });

      function reconstructState(item, ts) {
        if (!item.attempts || item.attempts === 0) return { New: { position: 0 } };
        const sd = (item.last && item.next > item.last)
          ? Math.max(1, Math.round((item.next - item.last) / kOneDay)) : 1;
        return {
          Review: {
            scheduled_days: sd,
            elapsed_days: item.last ? Math.max(0, Math.floor((ts - item.last) / kOneDay)) : sd,
            ease_factor: 2.5,
            lapses: Math.max(0, (item.attempts||0) - (item.successes||0)),
            leeched: false,
          }
        };
      }

      Vocabulary.updateItem = function(item, result, ts) {
        const rating = ratingMap[result];
        const state = reconstructState(item, ts);
        const statesJson = window.__anki_next_states(JSON.stringify(state), config);
        const states = JSON.parse(statesJson);
        const newState = states && states[rating];
        const interval = newState
          ? window.__anki_interval_secs(JSON.stringify(newState), 43200) : 0;
        const isLearning = newState && !!(newState.Learning || newState.Relearning);

        window.__ankiLog.push({
          word: item.word, result, rating,
          interval_secs: interval,
          interval_days: Math.round(interval / kOneDay * 100) / 100,
          ankiState: newState,
          failed: isLearning,
          inputState: state,
        });

        // Call original to keep the app flow working
        origUpdate(item, result, ts);
      };

      return { ok: true };
    } catch (e) {
      return { error: e.message };
    }
  });
}

(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', 'www'], {
    stdio: 'ignore', detached: true,
  });
  await sleep(1500);

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: HEADED ? false : 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 400, height: 800 });
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('ERR_UNSAFE_PORT') && !m.text().includes('404'))
        console.log('  [page error]', m.text());
    });

    console.log('=== Anki SM-2 E2E Tests ===\n');

    // --- Phase 1: Load, inject, seed ---
    console.log('[1] Setup');
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForFunction('typeof Router !== "undefined"', { timeout: 15000 });

    // Seed list and reload
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      localStorage.setItem('table.lists.lists', JSON.stringify({
        yi1test: { category: 'Test', name: 'Yi1 Test' },
      }));
    });
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForFunction('typeof Router !== "undefined"', { timeout: 15000 });

    // Navigate to lists page and enable the list
    await page.evaluate('Router.go("lists")');
    await sleep(3000);

    const toggleResult = await page.evaluate(() => {
      const items = document.querySelectorAll('.item-toggle, .item');
      for (const item of items) {
        if (item.textContent.indexOf('Yi1 Test') >= 0) {
          const input = item.querySelector('input[type="checkbox"]');
          if (input) { input.click(); return 'clicked checkbox'; }
          const toggle = item.querySelector('.toggle');
          if (toggle) { toggle.click(); return 'clicked toggle div'; }
          item.click();
          return 'clicked item';
        }
      }
      return 'not found';
    });
    assert(toggleResult.startsWith('clicked'), `Enabled Yi1 Test list (${toggleResult})`);
    await sleep(8000); // Wait for list file fetch + vocab add

    const wasmResult = await injectWasm(page);
    assert(wasmResult.ok, `WASM loaded in browser (ease=${wasmResult.ease})`);

    const patchResult = await patchVocabulary(page);
    assert(patchResult.ok || !patchResult.error, `Vocabulary patched: ${JSON.stringify(patchResult)}`);

    // Navigate to teach page
    await page.evaluate('Router.go("teach")');
    await sleep(5000);

    // --- Phase 2: Draw character ---
    console.log('\n[2] Drawing character 一');

    const canvasRect = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });

    if (canvasRect) {
      const startX = canvasRect.left + canvasRect.width * 0.15;
      const endX = canvasRect.left + canvasRect.width * 0.85;
      const y = canvasRect.top + canvasRect.height * 0.5;
      await page.mouse.move(startX, y);
      await page.mouse.down();
      for (let x = startX; x <= endX; x += 10) {
        await page.mouse.move(x, y);
      }
      await page.mouse.up();
      pass('Drew horizontal stroke');
      await sleep(2000);

      // Click to advance past character completion
      await page.mouse.click(canvasRect.left + canvasRect.width / 2, canvasRect.top + canvasRect.height / 2);
      await sleep(1500);
    } else {
      fail('No canvas found');
    }

    // --- Phase 3: Check scheduling results ---
    console.log('\n[3] Checking Anki scheduling results');
    const log = await page.evaluate(() => window.__ankiLog || []);

    if (log.length > 0) {
      pass(`${log.length} scheduling event(s) recorded`);
      for (const entry of log) {
        console.log(`  Card "${entry.word}": result=${entry.result} (${entry.rating})`);
        console.log(`    Input state: ${JSON.stringify(entry.inputState)}`);
        console.log(`    Anki state: ${JSON.stringify(entry.ankiState)}`);
        console.log(`    Interval: ${entry.interval_secs}s (${entry.interval_days} days)`);
        console.log(`    Needs retry: ${entry.failed}`);

        // Verify the scheduling makes sense
        if (entry.inputState.New) {
          // New card scheduling
          if (entry.rating === 'good') {
            assert(!!entry.ankiState.Learning, 'New+Good → Learning state');
            assert(entry.ankiState.Learning && entry.ankiState.Learning.scheduled_secs === 600,
              'New+Good → 600s (10 min learning step)');
          } else if (entry.rating === 'easy') {
            assert(!!entry.ankiState.Review, 'New+Easy → Review (graduate)');
          } else if (entry.rating === 'again') {
            assert(!!entry.ankiState.Learning, 'New+Again → Learning (first step)');
            assert(entry.ankiState.Learning && entry.ankiState.Learning.scheduled_secs === 60,
              'New+Again → 60s (1 min step)');
          } else if (entry.rating === 'hard') {
            assert(!!entry.ankiState.Learning, 'New+Hard → Learning');
          }
        }
      }
    } else {
      fail('No scheduling events recorded — card may not have been completed');
    }

    // --- Phase 4: Direct WASM tests in browser ---
    console.log('\n[4] Direct WASM scheduler tests in browser');
    const directResults = await page.evaluate(() => {
      const S = window;
      const ns = S.__anki_next_states;
      const is = S.__anki_interval_secs;
      const config = JSON.stringify({
        learn_steps:[1,10], relearn_steps:[10], graduating_interval_good:1,
        graduating_interval_easy:4, initial_ease_factor:2.5, hard_multiplier:1.2,
        easy_multiplier:1.3, interval_multiplier:1.0, maximum_review_interval:36500,
        leech_threshold:8, lapse_multiplier:0.0, minimum_lapse_interval:1, fuzz_factor:null,
      });
      const results = [];

      // New card
      const newS = JSON.parse(ns(JSON.stringify({New:{position:0}}), config));
      results.push({ name: 'new_again_60s', ok: newS.again.Learning?.scheduled_secs === 60 });
      results.push({ name: 'new_hard_330s', ok: newS.hard.Learning?.scheduled_secs === 330 });
      results.push({ name: 'new_good_600s', ok: newS.good.Learning?.scheduled_secs === 600 });
      results.push({ name: 'new_easy_4days', ok: newS.easy.Review?.scheduled_days === 4 });

      // Review card (10 days, ease 2.5, on time)
      const revS = JSON.parse(ns(JSON.stringify({
        Review:{scheduled_days:10,elapsed_days:10,ease_factor:2.5,lapses:0,leeched:false}
      }), config));
      results.push({ name: 'rev_hard_12d', ok: revS.hard.Review?.scheduled_days === 12 });
      results.push({ name: 'rev_good_25d', ok: revS.good.Review?.scheduled_days === 25 });
      results.push({ name: 'rev_easy_33d', ok: revS.easy.Review?.scheduled_days === 33 });
      results.push({ name: 'rev_again_relearn', ok: !!revS.again.Relearning });
      results.push({ name: 'rev_hard_ease_235', ok: Math.abs((revS.hard.Review?.ease_factor||0) - 2.35) < 0.01 });
      results.push({ name: 'rev_easy_ease_265', ok: Math.abs((revS.easy.Review?.ease_factor||0) - 2.65) < 0.01 });

      // Relearning card
      const relS = JSON.parse(ns(JSON.stringify({
        Relearning: {
          learning:{remaining_steps:1,scheduled_secs:600,elapsed_secs:0},
          review:{scheduled_days:5,elapsed_days:5,ease_factor:2.0,lapses:1,leeched:false}
        }
      }), config));
      results.push({ name: 'relearn_good_review', ok: !!relS.good.Review });
      results.push({ name: 'relearn_easy_6d', ok: relS.easy.Review?.scheduled_days === 6 });

      // Late review (10d scheduled, 20d elapsed → 10 days late)
      const lateS = JSON.parse(ns(JSON.stringify({
        Review:{scheduled_days:10,elapsed_days:20,ease_factor:2.5,lapses:0,leeched:false}
      }), config));
      // good: (10 + 10/2) * 2.5 = 37.5 → 38
      results.push({ name: 'late_good_38d', ok: lateS.good.Review?.scheduled_days === 38 });

      return results;
    });

    for (const r of directResults) {
      assert(r.ok, r.name);
    }

    await page.screenshot({ path: '/tmp/anki-e2e-final.png' });
    console.log('\n  Screenshot: /tmp/anki-e2e-final.png');

  } finally {
    await browser.close();
    try { process.kill(-server.pid); } catch (e) {}
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
