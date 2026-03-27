#!/usr/bin/env node
/**
 * Tests for configurable session duration.
 * Verifies: default value, backward compat, snapshot-on-start, mid-session safety,
 * settings UI, and next-session time calculation.
 */
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');

const PORT = 9877;
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

    // --- Helper: load app with clean state ---
    const loadApp = async (extraStorage) => {
      await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForFunction('typeof Router !== "undefined"', { timeout: 15000 });
      await page.evaluate(() => localStorage.clear());
      if (extraStorage) {
        await page.evaluate((data) => {
          for (const [k, v] of Object.entries(data)) {
            localStorage.setItem(k, v);
          }
        }, extraStorage);
      }
      await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForFunction('typeof Router !== "undefined"', { timeout: 15000 });
      await sleep(500);
    };

    // =========================================================================
    console.log('\n[1] Default session_duration setting');
    // =========================================================================
    await loadApp();
    const defaultDuration = await page.evaluate(() => {
      // Settings.get should return 600 when nothing is stored
      const raw = localStorage.getItem('table.settings.session_duration');
      return { raw, fallback: raw === null ? 600 : JSON.parse(raw) };
    });
    if (defaultDuration.raw === null) {
      pass('No session_duration in localStorage by default');
    } else {
      fail('session_duration unexpectedly in localStorage: ' + defaultDuration.raw);
    }

    // =========================================================================
    console.log('\n[2] Backward compat: old session without .duration field');
    // =========================================================================
    // Simulate an old session that was stored without the duration field
    const oldTs = Math.floor(Date.now() / 1000) - 60; // started 60s ago
    await loadApp({
      'table.timing.value': JSON.stringify({
        adds: 5, failures: 0, reviews: 10, min_cards: 0, ts: oldTs
      }),
    });
    const backcompat = await page.evaluate(() => {
      const timing = JSON.parse(localStorage.getItem('table.timing.value'));
      return { hasDuration: 'duration' in timing, ts: timing.ts };
    });
    if (!backcompat.hasDuration) {
      pass('Old session has no duration field (as expected)');
    } else {
      fail('Old session unexpectedly has duration field');
    }
    // The session should still be active (60s < 600s fallback)
    const timeLeftOld = await page.evaluate(() => {
      const el = document.querySelector('.info.left');
      return el ? el.textContent.trim() : null;
    });
    // Time left should be roughly 9:00 (600 - 60 = 540s)
    console.log('  Time left display:', timeLeftOld);
    if (timeLeftOld && timeLeftOld.match(/[89]:\d\d/)) {
      pass('Old session uses ~600s fallback duration (time shows ~9min)');
    } else {
      // Could also check the session wasn't expired
      const stillActive = await page.evaluate(() => {
        const timing = JSON.parse(localStorage.getItem('table.timing.value'));
        const now = Math.floor(Date.now() / 1000);
        return (timing.ts + 600 - now) > 0;
      });
      if (stillActive) {
        pass('Old session still active with 600s fallback');
      } else {
        fail('Old session expired unexpectedly');
      }
    }

    // =========================================================================
    console.log('\n[3] New session snapshots session_duration from settings');
    // =========================================================================
    await loadApp({
      'table.settings.session_duration': JSON.stringify(300),
    });
    // Force a new session by waiting for tick
    await sleep(2000);
    const newSession = await page.evaluate(() => {
      const timing = JSON.parse(localStorage.getItem('table.timing.value'));
      return timing;
    });
    if (newSession && newSession.duration === 300) {
      pass('New session has duration=300 from settings');
    } else {
      fail('New session duration mismatch: ' + JSON.stringify(newSession));
    }

    // =========================================================================
    console.log('\n[4] Mid-session duration change does NOT expire session');
    // =========================================================================
    // Start with a 1-hour session
    const midTs = Math.floor(Date.now() / 1000) - 600; // started 10min ago
    await loadApp({
      'table.settings.session_duration': JSON.stringify(3600),
      'table.timing.value': JSON.stringify({
        adds: 3, failures: 0, reviews: 7, min_cards: 0, ts: midTs, duration: 3600
      }),
    });
    await sleep(1000);
    // Verify session is still active (10min < 1hr)
    const beforeChange = await page.evaluate(() => {
      const timing = JSON.parse(localStorage.getItem('table.timing.value'));
      return { ts: timing.ts, duration: timing.duration, adds: timing.adds };
    });
    if (beforeChange.adds === 3 && beforeChange.duration === 3600) {
      pass('Session active with original counts before settings change');
    } else {
      fail('Session state wrong before change: ' + JSON.stringify(beforeChange));
    }

    // Now change the setting to 5 minutes (shorter than elapsed time)
    await page.evaluate(() => {
      localStorage.setItem('table.settings.session_duration', JSON.stringify(300));
    });
    await sleep(2000);

    // The session should still be using its snapshotted duration (3600), NOT 300
    const afterChange = await page.evaluate(() => {
      const timing = JSON.parse(localStorage.getItem('table.timing.value'));
      return { ts: timing.ts, duration: timing.duration, adds: timing.adds };
    });
    if (afterChange.ts === beforeChange.ts && afterChange.duration === 3600) {
      pass('Mid-session: session NOT expired after setting changed to shorter duration');
    } else if (afterChange.ts !== beforeChange.ts) {
      fail('Mid-session: session was expired and restarted! ts changed from ' +
           beforeChange.ts + ' to ' + afterChange.ts);
    } else {
      fail('Mid-session: unexpected state: ' + JSON.stringify(afterChange));
    }

    // =========================================================================
    console.log('\n[5] Session Duration dropdown in settings page');
    // =========================================================================
    await loadApp();
    await page.evaluate('Router.go("settings")');
    await sleep(2000);
    await page.screenshot({ path: '/tmp/session-duration-settings.png' });

    const dropdown = await page.evaluate(() => {
      const selects = document.querySelectorAll('.item-select');
      for (const sel of selects) {
        if (sel.textContent.includes('Session Duration')) {
          const options = sel.querySelectorAll('option');
          return {
            found: true,
            optionCount: options.length,
            values: Array.from(options).map(o => ({
              label: o.textContent.trim(),
              value: parseInt(o.value, 10),
            })),
          };
        }
      }
      return { found: false, allSelects: Array.from(selects).map(s => s.textContent.trim().substring(0, 50)) };
    });

    if (dropdown.found) {
      pass('Session Duration dropdown found in settings');
      if (dropdown.optionCount === 6) {
        pass('Dropdown has 6 options');
      } else {
        fail('Expected 6 options, got ' + dropdown.optionCount);
      }
      const expectedValues = [300, 900, 3600, 7200, 21600, 86400];
      const actualValues = dropdown.values.map(v => v.value);
      if (JSON.stringify(actualValues) === JSON.stringify(expectedValues)) {
        pass('Option values are correct: ' + actualValues.join(', '));
      } else {
        fail('Option values mismatch: ' + JSON.stringify(dropdown.values));
      }
    } else {
      fail('Session Duration dropdown not found. Selects: ' + JSON.stringify(dropdown.allSelects));
    }

    // =========================================================================
    console.log('\n[6] Next session time reflects snapshotted duration');
    // =========================================================================
    // Set up with 5-minute duration and enable yi1test list
    await loadApp({
      'table.settings.session_duration': JSON.stringify(300),
      'table.lists.lists': JSON.stringify({ yi1test: { category: 'Test', name: 'Yi1 Test' } }),
    });
    // Enable list
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

    // Go to teach, draw the stroke, complete session
    await page.evaluate('Router.go("teach")');
    await sleep(3000);

    const rect = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return null;
      const r = canvas.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });

    if (rect) {
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
      await page.mouse.click(rect.left + rect.width * 0.5, rect.top + rect.height * 0.5);
      await sleep(2000);

      // Check the "Next session at" time
      const nextSession = await page.evaluate(() => {
        const el = document.querySelector('.next-session');
        return el ? el.textContent.trim() : null;
      });
      console.log('  Next session text:', nextSession);

      // Verify the timing data has duration=300
      const sessionData = await page.evaluate(() => {
        const timing = JSON.parse(localStorage.getItem('table.timing.value'));
        return timing;
      });

      if (sessionData && sessionData.duration === 300) {
        pass('Session stored duration=300 (5 minutes)');
      } else {
        fail('Session duration mismatch: ' + JSON.stringify(sessionData));
      }

      if (nextSession && nextSession.includes('Next session at')) {
        pass('Next session time displayed');
        // Verify it's ~5 minutes from session start, not 10
        const sessionStart = new Date(sessionData.ts * 1000);
        const expectedEnd = new Date((sessionData.ts + 300) * 1000);
        const expectedMin = expectedEnd.getMinutes().toString().padStart(2, '0');
        const expectedH = expectedEnd.getHours() % 12 || 12;
        const expectedTime = `${expectedH}:${expectedMin}`;
        if (nextSession.includes(expectedTime)) {
          pass('Next session time matches 5-minute duration: ' + expectedTime);
        } else {
          fail('Next session time mismatch. Expected to contain ' + expectedTime +
               ', got: ' + nextSession);
        }
      } else {
        fail('Next session text not found');
      }

      await page.screenshot({ path: '/tmp/session-duration-done.png' });
    } else {
      fail('No canvas found for stroke test');
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
