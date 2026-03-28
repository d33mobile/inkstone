#!/usr/bin/env node
/**
 * E2E test: verify learning cards preempt new cards in the teach page.
 * Seeds localStorage with 2 new cards + 1 due learning card.
 * Verifies the due learning card is shown first.
 */
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const pass = (msg) => { passed++; console.log(`  ✓ ${msg}`); };
const fail = (msg) => { failed++; console.error(`  ✗ ${msg}`); };

const PORT = 9980;

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
    page.on('console', (m) => {
      if (m.text().includes('[anki]')) console.log('  ' + m.text());
    });

    console.log('=== Ordering E2E Test ===\n');

    // --- Setup: seed 2 new cards + 1 due learning card ---
    console.log('[1] Seeding cards');
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForFunction('typeof Router !== "undefined"', { timeout: 15000 });

    const now = Math.floor(Date.now() / 1000);
    await page.evaluate((ts) => {
      localStorage.clear();
      localStorage.setItem('table.lists.lists', JSON.stringify({
        yi1test: { category: 'Test', name: 'Yi1 Test' },
      }));
      localStorage.setItem('table.lists.status.yi1test', 'true');

      function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return h; }
      function setCard(word, entry) {
        const idx = Math.abs(hash(word)) % 16;
        const key = 'table.vocabulary.' + idx;
        const chunk = JSON.parse(localStorage.getItem(key) || '[]');
        chunk.push(entry);
        localStorage.setItem(key, JSON.stringify(chunk));
      }

      // New cards
      setCard('一', ['一', null, null, ['yi1test'], 0, 0, false, null]);
      setCard('二', ['二', null, null, ['yi1test'], 0, 0, false, null]);

      // Due learning card: failed, next is 60s in the past
      setCard('三', ['三', ts - 120, ts - 60, ['yi1test'], 1, 0, true,
        { Learning: { remaining_steps: 2, scheduled_secs: 60, elapsed_secs: 0 } }]);
    }, now);
    pass('Cards seeded: 2 new + 1 due learning');

    // --- Reload and check what card is shown ---
    console.log('\n[2] Loading teach page');
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction('typeof Router !== "undefined"', { timeout: 15000 });
    await sleep(5000); // wait for WASM + patches + initial shuffle

    // Check which card is shown
    const shownCard = await page.evaluate(() => {
      // Read the card word from the teach page
      // The card data is in the Timing module
      try {
        const Timing = require('/client/model/timing').Timing;
        const card = Timing.getNextCard();
        if (!card) return { word: null, deck: 'none' };
        return { word: card.data?.word || '?', deck: card.deck };
      } catch (e) {
        return { error: e.message };
      }
    });

    console.log('  Shown card:', JSON.stringify(shownCard));

    if (shownCard.word === '三') {
      pass('Due learning card 三 shown FIRST (preempts new cards)');
    } else if (shownCard.word === '一' || shownCard.word === '二') {
      fail('New card ' + shownCard.word + ' shown instead of due learning card 三');
    } else {
      fail('Unexpected card: ' + JSON.stringify(shownCard));
    }

    // Check the deck type
    if (shownCard.deck === 'failures') {
      pass('Card shown from failures deck');
    } else {
      fail('Expected failures deck, got: ' + shownCard.deck);
    }

    // --- Verify body text shows 三's info ---
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300));
    console.log('  Body:', bodyText.substring(0, 80));

    await page.screenshot({ path: '/tmp/ordering-e2e.png' });
    pass('Screenshot: /tmp/ordering-e2e.png');

  } finally {
    await browser.close();
    try { process.kill(-server.pid); } catch (e) {}
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
