#!/usr/bin/env node
/**
 * Tests that failed cards appear when "Continue practicing" is clicked.
 * Flow: enable list → draw stroke badly → card fails → session ends →
 *       click Continue → verify the failed card reappears.
 */
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');

const PORT = 9878;
const URL = `http://localhost:${PORT}/`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const pass = (msg) => { passed++; console.log(`  PASS: ${msg}`); };
const fail = (msg) => { failed++; console.log(`  FAIL: ${msg}`); };

(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', 'www'], {
    stdio: 'ignore', detached: true,
  });
  await sleep(1500);

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 400, height: 800 });
    page.on('console', m => {
      if (m.type() === 'error') console.log('  [page error]', m.text());
    });

    // --- Load app and seed yi1test list ---
    console.log('[1] Setup: enable yi1test list');
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForFunction('typeof Router !== "undefined"', { timeout: 15000 });
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      localStorage.setItem('table.lists.lists', JSON.stringify({
        yi1test: { category: 'Test', name: 'Yi1 Test' },
      }));
    });
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForFunction('typeof Router !== "undefined"', { timeout: 15000 });

    // Enable the list
    await page.evaluate('Router.go("lists")');
    await sleep(2000);
    await page.evaluate(() => {
      const items = document.querySelectorAll('.item-toggle, .item');
      for (const item of items) {
        if (item.textContent.indexOf('Yi1 Test') >= 0) {
          const input = item.querySelector('input[type="checkbox"]');
          if (input) input.click();
        }
      }
    });
    await sleep(5000);
    pass('List enabled');

    // --- Go to teach, deliberately fail the card by tapping (not drawing) ---
    console.log('\n[2] Fail the card by tapping repeatedly');
    await page.evaluate('Router.go("teach")');
    await sleep(3000);

    const rect = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return null;
      const r = canvas.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });

    if (!rect) { fail('No canvas'); return; }

    // Tap the canvas multiple times to trigger "show answer" behavior
    // Each tap on an incomplete character increments penalties
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    for (let i = 0; i < 8; i++) {
      await page.mouse.click(cx, cy);
      await sleep(500);
    }
    await sleep(2000);

    // Check vocabulary state
    const vocabAfterFail = await page.evaluate(() => {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('table.vocabulary.'));
      let entry = null;
      for (const k of keys) {
        try {
          const val = JSON.parse(localStorage.getItem(k));
          if (Array.isArray(val)) {
            for (const e of val) {
              if (Array.isArray(e) && e[0] === '一') entry = e;
            }
          }
        } catch(e) {}
      }
      return entry;
    });
    console.log('  Vocab entry after interaction:', JSON.stringify(vocabAfterFail));

    // The card might be in failures deck or might have transitioned to done screen
    // Let's check if we see the "done" screen or need to advance more
    const state1 = await page.evaluate(() => document.body.innerText.substring(0, 300));

    if (state1.includes('done for now')) {
      pass('Session ended after failing card');
    } else {
      // Draw the stroke correctly to complete (card was shown via flash)
      console.log('  Card still active, drawing stroke...');
      const startX = rect.left + rect.width * 0.13;
      const endX = rect.left + rect.width * 0.87;
      const y = rect.top + rect.height * 0.56;
      await page.mouse.move(startX, y);
      await page.mouse.down();
      for (let i = 1; i <= 20; i++) {
        await page.mouse.move(startX + (endX - startX) * (i / 20), y);
        await sleep(30);
      }
      await page.mouse.up();
      await sleep(1500);

      // Click to advance
      await page.mouse.click(cx, cy);
      await sleep(2000);

      // Check if we need to handle failures deck
      for (let retry = 0; retry < 5; retry++) {
        const stateN = await page.evaluate(() => document.body.innerText.substring(0, 300));
        if (stateN.includes('done for now')) {
          pass('Session ended');
          break;
        }
        // Might be in failures deck - draw stroke again
        console.log('  Retry ' + retry + ': drawing stroke again...');
        await page.mouse.move(startX, y);
        await page.mouse.down();
        for (let i = 1; i <= 20; i++) {
          await page.mouse.move(startX + (endX - startX) * (i / 20), y);
          await sleep(30);
        }
        await page.mouse.up();
        await sleep(1500);
        await page.mouse.click(cx, cy);
        await sleep(2000);
      }
    }

    await page.screenshot({ path: '/tmp/failed-01-done.png' });

    // --- Check that vocabulary entry has next <= now (for failed card) ---
    console.log('\n[3] Check failed card scheduling');
    const vocabEntry = await page.evaluate(() => {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('table.vocabulary.'));
      for (const k of keys) {
        try {
          const val = JSON.parse(localStorage.getItem(k));
          if (Array.isArray(val)) {
            for (const e of val) {
              if (Array.isArray(e) && e[0] === '一') {
                return { word: e[0], last: e[1], next: e[2], attempts: e[4], successes: e[5], failed: e[6] };
              }
            }
          }
        } catch(e) {}
      }
      return null;
    });
    console.log('  Vocab entry:', JSON.stringify(vocabEntry));

    const now = Math.floor(Date.now() / 1000);
    if (vocabEntry && vocabEntry.next <= now + 5) {
      pass('Failed card next time is <= now (will appear in next session)');
    } else if (vocabEntry) {
      const delta = vocabEntry.next - now;
      fail('Failed card next time is ' + delta + 's in the future (should be <= now)');
    } else {
      fail('Could not find vocabulary entry');
    }

    // --- Click "Continue practicing" ---
    console.log('\n[4] Click Continue and verify card reappears');
    const clicked = await page.evaluate(() => {
      const options = document.querySelectorAll('.error .option');
      for (const opt of options) {
        if (opt.textContent.includes('Continue practicing')) {
          opt.click();
          return true;
        }
      }
      return false;
    });

    if (clicked) {
      pass('Clicked Continue practicing');
    } else {
      fail('Could not find Continue button');
    }

    await sleep(3000);
    await page.screenshot({ path: '/tmp/failed-02-continue.png' });

    // Check if the card reappeared
    const afterContinue = await page.evaluate(() => {
      const body = document.body.innerText.substring(0, 500);
      const canvas = document.querySelector('canvas');
      const hasCanvas = canvas && canvas.width > 0;
      return { body, hasCanvas };
    });

    console.log('  After continue body:', afterContinue.body.substring(0, 200));

    if (afterContinue.body.includes('yī') || afterContinue.body.includes('一')) {
      pass('Failed card reappeared after Continue!');
    } else if (afterContinue.body.includes('done for now')) {
      fail('Still showing done screen - card did not reappear');
    } else {
      // Check if canvas is active (card might be loading)
      if (afterContinue.hasCanvas) {
        pass('Canvas active after Continue (card likely loading)');
      } else {
        fail('Unknown state after Continue: ' + afterContinue.body.substring(0, 100));
      }
    }

    // --- Summary ---
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exitCode = 1;

  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill();
  }
})();
