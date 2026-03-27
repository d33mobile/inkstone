#!/usr/bin/env node
/**
 * E2E browser test: enable yi1test list (一 only), draw the single horizontal
 * stroke, confirm the session ends with "You're done for now!".
 */
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');

const HEADED = process.argv.includes('--headed') || process.env.HEADED === '1';
const PORT = 9876;
const URL = `http://localhost:${PORT}/`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// In headed mode, pauses are longer so you can watch
const pause = (ms) => sleep(HEADED ? ms * 3 : ms);

(async () => {
  // --- 1. Start HTTP server -------------------------------------------------
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', 'www'], {
    stdio: 'ignore', detached: true,
  });
  await sleep(1500);

  if (HEADED) console.log('=== HEADED MODE: browser will be visible on $DISPLAY ===');

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: HEADED ? false : 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  let passed = 0;
  let failed = 0;
  const pass = (msg) => { passed++; console.log(`PASS: ${msg}`); };
  const fail = (msg) => { failed++; console.log(`FAIL: ${msg}`); };

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 400, height: 800 });

    // Collect console messages for debugging
    page.on('console', (m) => {
      if (m.type() === 'error') console.log('  [page error]', m.text());
    });

    // --- 2. Initial load ----------------------------------------------------
    console.log('Loading app...');
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForFunction('typeof Router !== "undefined"', { timeout: 15000 });
    pass('Router initialized');

    // --- 3. Seed state: register yi1test list via localStorage ---------------
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      localStorage.setItem('table.lists.lists', JSON.stringify({
        yi1test: { category: 'Test', name: 'Yi1 Test' },
      }));
    });
    console.log('Seeded yi1test list in localStorage, reloading...');

    // Reload so the app picks up the seeded state
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForFunction('typeof Router !== "undefined"', { timeout: 15000 });
    pass('App reloaded with seeded state');

    // --- 4. Navigate to lists page and click the toggle ---------------------
    await page.evaluate('Router.go("lists")');
    await pause(3000);

    await page.screenshot({ path: '/tmp/browser-01-lists.png' });
    console.log('Screenshot: /tmp/browser-01-lists.png');

    // Find the toggle for "Yi1 Test"
    const toggleResult = await page.evaluate(() => {
      const items = document.querySelectorAll('.item-toggle, .item');
      for (const item of items) {
        if (item.textContent.indexOf('Yi1 Test') >= 0) {
          const input = item.querySelector('input[type="checkbox"]');
          if (input) {
            input.click();
            return 'clicked checkbox';
          }
          // Try the toggle div
          const toggle = item.querySelector('.toggle');
          if (toggle) { toggle.click(); return 'clicked toggle div'; }
          item.click();
          return 'clicked item';
        }
      }
      // Debug: list all item text
      const texts = [];
      document.querySelectorAll('.item-toggle, .item').forEach(
        (el) => texts.push(el.textContent.trim().substring(0, 60)));
      return 'not found, items: ' + JSON.stringify(texts);
    });
    console.log('Toggle result:', toggleResult);

    if (toggleResult.startsWith('clicked')) {
      pass('Clicked Yi1 Test toggle');
    } else {
      fail('Could not find Yi1 Test toggle: ' + toggleResult);
    }

    // Wait for enableList to fetch the .list file and add vocab
    await pause(8000);
    await page.screenshot({ path: '/tmp/browser-02-lists-enabled.png' });
    console.log('Screenshot: /tmp/browser-02-lists-enabled.png');

    // Verify the list got enabled (vocab item added)
    const vocabCheck = await page.evaluate(() => {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('table.vocabulary.'));
      return { keyCount: keys.length, keys: keys.slice(0, 5) };
    });
    console.log('Vocabulary keys:', JSON.stringify(vocabCheck));

    // --- 5. Navigate to teach page ------------------------------------------
    await page.evaluate('Router.go("teach")');
    await pause(5000);

    await page.screenshot({ path: '/tmp/browser-03-teach.png' });
    console.log('Screenshot: /tmp/browser-03-teach.png');

    // Check for canvas
    const teachState = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const body = document.body.innerText.substring(0, 500);
      return {
        hasCanvas: !!canvas,
        canvasSize: canvas ? `${canvas.width}x${canvas.height}` : 'none',
        bodySnippet: body,
      };
    });

    console.log('Teach state:', JSON.stringify(teachState, null, 2));

    if (teachState.hasCanvas) {
      pass('Canvas present on teach page');
    } else {
      fail('No canvas on teach page');
    }

    // Check for character prompt (pinyin/definition) — the character itself is on canvas, not in text
    if (teachState.bodySnippet.includes('y\u012B') || teachState.bodySnippet.match(/[\u4e00-\u9fff]/)) {
      pass('Character prompt visible (pinyin/definition for 一)');
    } else if (teachState.bodySnippet.includes("done for now")) {
      fail('Shows "done for now" before we drew anything — no cards available');
    } else {
      fail('No character prompt visible in body: ' + teachState.bodySnippet.substring(0, 100));
    }

    // --- 6. Draw horizontal stroke (一) on the canvas -----------------------
    const rect = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return null;
      const r = canvas.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });

    if (!rect) {
      fail('Cannot draw: no canvas found');
    } else {
      console.log('Canvas rect:', JSON.stringify(rect));

      // 一 median is roughly at y≈400 in 0-900 space (bottom-up).
      // In top-down canvas space: 900-400 = 500, normalized: 500/900 ≈ 0.56
      // Horizontal sweep from 13% to 87% of width
      const startX = rect.left + rect.width * 0.13;
      const endX = rect.left + rect.width * 0.87;
      const y = rect.top + rect.height * 0.56;

      console.log(`Drawing stroke from (${startX.toFixed(0)}, ${y.toFixed(0)}) to (${endX.toFixed(0)}, ${y.toFixed(0)})`);

      await page.mouse.move(startX, y);
      await page.mouse.down();
      const steps = 20;
      for (let i = 1; i <= steps; i++) {
        const x = startX + (endX - startX) * (i / steps);
        await page.mouse.move(x, y);
        await sleep(30);
      }
      await page.mouse.up();
      pass('Horizontal stroke drawn');

      await sleep(1500);
      await page.screenshot({ path: '/tmp/browser-04-stroke-drawn.png' });
      console.log('Screenshot: /tmp/browser-04-stroke-drawn.png');

      // Check if the character was completed (glow visible, or task.missing empty)
      const afterStroke = await page.evaluate(() => {
        return document.body.innerText.substring(0, 500);
      });
      console.log('After stroke body:', afterStroke.substring(0, 200));

      // --- 7. Click to advance (triggers maybeAdvance -> transition) ---------
      const clickX = rect.left + rect.width * 0.5;
      const clickY = rect.top + rect.height * 0.5;
      await page.mouse.click(clickX, clickY);
      console.log('Clicked canvas to advance');

      await sleep(3000);
      await page.screenshot({ path: '/tmp/browser-05-after-advance.png' });
      console.log('Screenshot: /tmp/browser-05-after-advance.png');

      // --- 8. Verify "done" message -----------------------------------------
      const finalState = await page.evaluate(() => {
        const error = document.querySelector('.error');
        const body = document.body.innerText;
        return {
          errorText: error ? error.textContent.trim() : null,
          bodySnippet: body.substring(0, 500),
        };
      });

      console.log('Final state:', JSON.stringify(finalState, null, 2));

      if (finalState.bodySnippet.includes("done for now") ||
          finalState.bodySnippet.includes("Done") ||
          (finalState.errorText && finalState.errorText.includes("done"))) {
        pass('Session ended: "done for now" displayed');
      } else {
        // Maybe we need another click or more time
        console.log('Did not see "done" yet, trying another click...');
        await page.mouse.click(clickX, clickY);
        await sleep(3000);

        const retryState = await page.evaluate(() => {
          return document.body.innerText.substring(0, 500);
        });
        console.log('Retry body:', retryState.substring(0, 200));
        await page.screenshot({ path: '/tmp/browser-06-retry.png' });

        if (retryState.includes("done for now") || retryState.includes("Done")) {
          pass('Session ended after retry click');
        } else {
          fail('Session did not show "done" message. Body: ' + retryState.substring(0, 150));
        }
      }
    }

    // --- Summary ------------------------------------------------------------
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exitCode = 1;

    // In headed mode, keep the browser open so you can inspect
    if (HEADED) {
      console.log('\nHeaded mode: browser stays open. Press Ctrl+C to exit.');
      await new Promise(() => {}); // block forever until Ctrl+C
    }

  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill();
  }
})();
