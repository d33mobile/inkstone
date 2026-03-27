#!/usr/bin/env node
// E2E test via Chrome DevTools Protocol on Android emulator
// Tests: enable list → verify cards → navigate to teach → check character

const WebSocket = require('ws');
const http = require('http');
const { execSync } = require('child_process');

const ADB = process.env.HOME + '/android-sdk/platform-tools/adb';
const CDP_PORT = 9222;

function getPage() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${CDP_PORT}/json`, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const pages = JSON.parse(d);
        resolve(pages[0]);
      });
    }).on('error', reject);
  });
}

async function main() {
  const page = await getPage();
  console.log(`Connected to: ${page.title} (${page.url})`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;

  function ev(expr, timeout = 15000) {
    return new Promise((resolve) => {
      const myId = ++id;
      ws.send(JSON.stringify({
        id: myId,
        method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true, awaitPromise: true }
      }));
      const h = (data) => {
        const r = JSON.parse(data);
        if (r.id === myId) {
          ws.removeListener('message', h);
          if (r.result && r.result.result) resolve(r.result.result.value);
          else if (r.result && r.result.exceptionDetails) resolve('ERROR: ' + r.result.exceptionDetails.text);
          else resolve(r.result);
        }
      };
      ws.on('message', h);
      setTimeout(() => resolve('TIMEOUT'), timeout);
    });
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const screenshot = (name) => {
    try { execSync(`${ADB} exec-out screencap -p > /tmp/${name}.png`); } catch(e) {}
  };

  return new Promise((resolve) => {
    ws.on('open', async () => {
      console.log('\n=== E2E Test: List → Teach → Draw ===\n');

      // Step 1: Check Router
      let r = await ev('typeof Router');
      console.log(`1. Router: ${r}`);
      if (r !== 'function') { console.log('FAIL: Router not ready'); ws.close(); resolve(); return; }

      // Step 2: Go to lists
      await ev('Router.go("lists")');
      await sleep(5000);
      r = await ev('document.querySelectorAll(".toggle").length');
      console.log(`2. Toggles on lists page: ${r}`);
      screenshot('e2e-02-lists');

      // Step 3: Enable "100 Common Radicals"
      r = await ev(`(function(){
        var items = document.querySelectorAll('.item');
        for (var i = 0; i < items.length; i++) {
          if (items[i].textContent.indexOf('100 Common') >= 0) {
            var t = items[i].querySelector('.toggle');
            if (t) { t.click(); return 'clicked'; }
          }
        }
        return 'not found';
      })()`);
      console.log(`3. Enable list: ${r}`);

      // Step 4: Wait for readList + Tracker.flush
      console.log('4. Waiting 15s for list loading...');
      await sleep(15000);

      // Step 5: Check header for card count
      r = await ev(`(function(){
        var infos = document.querySelectorAll('.info');
        var texts = [];
        infos.forEach(function(i) { texts.push(i.textContent.trim()); });
        return JSON.stringify(texts);
      })()`);
      console.log(`5. Header info: ${r}`);
      screenshot('e2e-05-after-enable');

      // Step 6: Navigate to teach
      await ev('Router.go("teach")');
      console.log('6. Navigated to teach');
      await sleep(8000);

      // Step 7: Check teach page
      r = await ev(`(function(){
        var canvas = document.querySelector('canvas');
        var bodyText = document.body.innerText.substring(0, 300);
        var hasChinese = /[\\u4e00-\\u9fff]/.test(bodyText);
        return JSON.stringify({
          hasCanvas: !!canvas,
          hasChinese: hasChinese,
          bodySnippet: bodyText.substring(0, 150)
        });
      })()`);
      console.log(`7. Teach state: ${r}`);
      screenshot('e2e-07-teach');

      // Parse result
      try {
        const state = JSON.parse(r);
        if (state.hasCanvas && state.hasChinese) {
          console.log('\n*** PASS: Character displayed on teach screen! ***\n');

          // Step 8: Try to simulate a stroke (horizontal swipe for 一-like chars)
          r = await ev(`(function(){
            var canvas = document.querySelector('canvas');
            if (!canvas) return 'no canvas';
            // Dispatch touch/mouse events to simulate drawing
            var rect = canvas.getBoundingClientRect();
            var startX = rect.left + rect.width * 0.15;
            var endX = rect.left + rect.width * 0.85;
            var y = rect.top + rect.height * 0.5;

            // Mouse events
            canvas.dispatchEvent(new MouseEvent('mousedown', {clientX: startX, clientY: y, bubbles: true}));
            for (var x = startX; x <= endX; x += 20) {
              canvas.dispatchEvent(new MouseEvent('mousemove', {clientX: x, clientY: y, bubbles: true}));
            }
            canvas.dispatchEvent(new MouseEvent('mouseup', {clientX: endX, clientY: y, bubbles: true}));
            return 'stroke simulated';
          })()`);
          console.log(`8. Stroke: ${r}`);
          await sleep(2000);
          screenshot('e2e-08-after-stroke');

        } else if (state.hasCanvas && !state.hasChinese) {
          console.log('\nFAIL: Canvas exists but no Chinese character shown');
          console.log('Body text:', state.bodySnippet);
        } else {
          console.log('\nFAIL: No canvas on teach page');
        }
      } catch(e) {
        console.log('Parse error:', e.message);
      }

      ws.close();
      resolve();
    });

    setTimeout(() => { console.log('TIMEOUT'); ws.close(); resolve(); }, 120000);
  });
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
