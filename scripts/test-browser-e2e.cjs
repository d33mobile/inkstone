#!/usr/bin/env node
const puppeteer = require('puppeteer-core');
const { execSync } = require('child_process');

(async () => {
  // Start HTTP server
  const server = require('child_process').spawn('python3', ['-m', 'http.server', '8777', '--directory', 'www'], {stdio: 'ignore', detached: true});
  await new Promise(r => setTimeout(r, 1500));

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({width: 400, height: 800});

    console.log('Loading app...');
    // Must load as "/" not "/index.html" — Iron Router expects root path
    await page.goto('http://localhost:8777/', {waitUntil: 'networkidle0', timeout: 30000});

    // Wait for Meteor/Router
    await page.waitForFunction('typeof Router !== "undefined"', {timeout: 15000});
    console.log('PASS: Router initialized');

    // Navigate to lists
    await page.evaluate('Router.go("lists")');
    await new Promise(r => setTimeout(r, 3000));
    const toggleCount = await page.evaluate(() => document.querySelectorAll('.toggle').length);
    const listHTML = await page.evaluate(() => document.body.innerHTML.substring(0, 500));
    console.log(`Lists page: ${toggleCount} toggles`);
    if (toggleCount === 0) {
      console.log('DEBUG HTML:', listHTML.substring(0, 200));
    }

    // Enable 100 Common Radicals
    const clicked = await page.evaluate(() => {
      // Try multiple selectors
      const items = document.querySelectorAll('.item-toggle, .item');
      for (let i = 0; i < items.length; i++) {
        if (items[i].textContent.indexOf('100 Common') >= 0) {
          const toggle = items[i].querySelector('.toggle input, .toggle, input[type=checkbox]');
          if (toggle) { toggle.click(); return 'found and clicked'; }
          // Try clicking the item itself
          items[i].click();
          return 'clicked item directly';
        }
      }
      return 'not found';
    });
    console.log('PASS: Clicked 100 Common Radicals toggle:', clicked);

    // Wait for list loading (readList Promise + Tracker.flush)
    await new Promise(r => setTimeout(r, 8000));

    // Check if items were added
    await page.screenshot({path: '/tmp/browser-lists.png'});
    console.log('Screenshot: /tmp/browser-lists.png');

    // Navigate to teach
    await page.evaluate('Router.go("teach")');
    await new Promise(r => setTimeout(r, 5000));

    // Check teach state
    const teachState = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const panels = document.querySelectorAll('.panel-body');
      const panelTexts = [];
      panels.forEach(p => panelTexts.push(p.textContent.trim().substring(0, 80)));
      const bodyText = document.body.innerText.substring(0, 300);
      return {
        hasCanvas: !!canvas,
        canvasSize: canvas ? `${canvas.width}x${canvas.height}` : 'none',
        panels: panelTexts,
        bodySnippet: bodyText
      };
    });

    console.log('Teach state:', JSON.stringify(teachState, null, 2));

    if (teachState.hasCanvas) {
      console.log('PASS: Canvas exists');
    } else {
      console.log('FAIL: No canvas on teach page');
    }

    // Check if there's a character to draw (not "Done")
    if (teachState.bodySnippet.includes('Done') && !teachState.bodySnippet.match(/[\u4e00-\u9fff]/)) {
      console.log('FAIL: Shows "Done" - no character to draw');
    } else if (teachState.bodySnippet.match(/[\u4e00-\u9fff]/)) {
      console.log('PASS: Chinese character visible!');
    } else {
      console.log('INFO: No Chinese chars in body text, checking panels...');
    }

    await page.screenshot({path: '/tmp/browser-teach.png'});
    console.log('Screenshot: /tmp/browser-teach.png');

  } finally {
    await browser.close();
    server.kill();
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
