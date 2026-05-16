#!/usr/bin/env node
/**
 * E2E test against the installed inkstone APK in a running emulator.
 *
 * Drives the WebView via Chrome DevTools Protocol over `adb forward`, and
 * sends real touch events via `adb shell input swipe/tap`. Three scenarios:
 *
 *   A) yi1 (一) drawn perfectly         → expect successes=1, next≫last
 *   B) shi2 (十) drawn perfectly        → expect successes=1, next≫last
 *   C) shi2 with ≥3 wrong strokes then  → expect successes=0, next==last,
 *      correct strokes                     failed=true (lapse)
 *
 * Pre-requisites: APK installed, emulator booted, no foreground app blocking.
 *
 * Environment:
 *   ADB         — path to adb (default: /opt/android-sdk/platform-tools/adb)
 *   CDP_HOST    — host for chrome devtools (default: localhost)
 *   CDP_PORT    — port forwarded to webview_devtools_remote_$PID (default: 9222)
 *   PKG         — Android package name (default: me.skishore.inkstone)
 *
 * Exit code: 0 if all assertions pass, non-zero otherwise.
 */
const WebSocket = require('ws');
const { spawnSync } = require('child_process');

const ADB = process.env.ADB || '/opt/android-sdk/platform-tools/adb';
const CDP_HOST = process.env.CDP_HOST || 'localhost';
const CDP_PORT = process.env.CDP_PORT || '9222';
const PKG = process.env.PKG || 'me.skishore.inkstone';
const STATUS_BAR_PX = parseInt(process.env.STATUS_BAR_PX || '63', 10);
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || '/tmp';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

let passed = 0, failed = 0;
const pass = (m) => { passed++; log('PASS:', m); };
const fail = (m) => { failed++; log('FAIL:', m); };
const assertEq = (got, want, label) => {
  if (got === want) pass(`${label} = ${got}`);
  else fail(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

const adb = (...args) => {
  const r = spawnSync(ADB, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`adb ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const adbSwipe = (x1, y1, x2, y2, dur = 400) =>
  adb('shell', 'input', 'swipe', `${x1 | 0}`, `${y1 | 0}`, `${x2 | 0}`, `${y2 | 0}`, `${dur}`);
const adbTap = (x, y) => adb('shell', 'input', 'tap', `${x | 0}`, `${y | 0}`);
const adbScreencap = (out) => {
  const r = spawnSync('bash', ['-c', `${ADB} exec-out screencap -p > ${out}`]);
  if (r.status !== 0) throw new Error('screencap failed');
};

function makeCDP(wsUrl, wsOpts = {}) {
  const ws = new WebSocket(wsUrl, wsOpts);
  const pending = new Map();
  let id = 0;
  const ready = new Promise((res) => ws.once('open', res));
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const myId = ++id;
      pending.set(myId, { res, rej });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  return { ready, send, close: () => ws.close() };
}

async function ev(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error('eval: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  }
  return r.result && r.result.value;
}

async function getCDP() {
  // Chrome DevTools enforces a strict Host-header check (only localhost
  // / 127.0.0.1 are accepted), and the ws library doesn't reliably
  // forge the Host header on the upgrade request. Easiest fix is to
  // forward CDP_HOST:CDP_PORT to 127.0.0.1:CDP_PORT inside the container
  // via socat (started by the caller's before_script), then talk to
  // localhost only.
  const r = spawnSync('curl', ['-s', `http://localhost:${CDP_PORT}/json`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('curl devtools list failed: ' + r.stderr);
  const arr = JSON.parse(r.stdout);
  const tgt = arr.find((t) => t.type === 'page' || t.type === 'webview');
  if (!tgt) throw new Error('no inkstone WebView devtools target visible — is the app foregrounded?');
  const wsUrl = tgt.webSocketDebuggerUrl;  // ws://localhost:<port>/...
  const cdp = makeCDP(wsUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  return cdp;
}

async function setupListAndGotoTeach(cdp, listKey, listName) {
  await ev(cdp, `
    Object.keys(localStorage).forEach((k) => { if (k.startsWith('table.')) localStorage.removeItem(k); });
    localStorage.setItem('table.lists.lists', JSON.stringify({
      [${JSON.stringify(listKey)}]: { category: 'Test', name: ${JSON.stringify(listName)} },
    }));
  `);
  await ev(cdp, `location.href = location.origin + '/'`);
  await sleep(2000);
  for (let i = 0; i < 40; i++) {
    try {
      if (await ev(cdp, `typeof Router !== 'undefined'`)) break;
    } catch (e) {}
    await sleep(500);
  }
  await ev(cdp, `Router.go('lists')`);
  await sleep(3500);
  const clickRes = await ev(cdp, `(() => {
    for (const it of document.querySelectorAll('.item-toggle, .item')) {
      if (it.textContent.indexOf(${JSON.stringify(listName)}) >= 0) {
        const i = it.querySelector('input[type=checkbox]');
        if (i) { i.click(); return 'clicked'; }
      }
    }
    return 'notfound';
  })()`);
  if (clickRes !== 'clicked') throw new Error(`toggle for ${listName}: ${clickRes}`);
  await sleep(8000);
  await ev(cdp, `Router.go('teach')`);
  await sleep(5500);
}

async function getGeom(cdp) {
  return ev(cdp, `(() => {
    const c = document.querySelector('canvas'); if (!c) return null;
    const r = c.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, dpr: window.devicePixelRatio,
             body: document.body.innerText.slice(0, 200) };
  })()`);
}

const toDev = (geom, x, y) => ({
  x: Math.round(x * geom.dpr),
  y: Math.round(y * geom.dpr) + STATUS_BAR_PX,
});

async function drawStrokeFromTo(geom, xfStart, yfStart, xfEnd, yfEnd, dur = 400) {
  const a = toDev(geom, geom.left + geom.width * xfStart, geom.top + geom.height * yfStart);
  const b = toDev(geom, geom.left + geom.width * xfEnd, geom.top + geom.height * yfEnd);
  adbSwipe(a.x, a.y, b.x, b.y, dur);
  await sleep(1500);
}

async function tapCanvasCenter(geom) {
  const c = toDev(geom, geom.left + geom.width / 2, geom.top + geom.height / 2);
  adbTap(c.x, c.y);
  await sleep(2500);
}

async function readVocab(cdp) {
  return ev(cdp, `(() => {
    const out = {};
    Object.keys(localStorage).forEach((k) => {
      if (k.startsWith('table.vocabulary.')) out[k] = localStorage.getItem(k);
    });
    return out;
  })()`);
}

function parseEntry(raw) {
  // [[word, last, next, lists, attempts, successes, failed, ankiState?]]
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const e = arr[0];
  return {
    word: e[0],
    last: e[1],
    next: e[2],
    lists: e[3],
    attempts: e[4],
    successes: e[5],
    failed: e[6],
    ankiState: e[7],
    interval: e[2] - e[1],
  };
}

(async () => {
  log('=== APK E2E test: yi1 + shi2 + wrong-stroke ===');

  // === A: yi1 perfect ===
  log('\n--- Scenario A: yi1 (一) drawn perfectly ---');
  {
    const cdp = await getCDP();
    await setupListAndGotoTeach(cdp, 'yi1test', 'Yi1 Test');
    const g = await getGeom(cdp);
    if (!g) { fail('A: no canvas'); cdp.close(); }
    else {
      log('Canvas:', JSON.stringify({ w: g.width, h: g.height, dpr: g.dpr }));
      if (!g.body.includes('yī') && !g.body.includes('one')) fail(`A: no 一 prompt: ${g.body.slice(0, 80)}`);
      else pass('A: 一 card prompt visible');
      await drawStrokeFromTo(g, 0.13, 0.56, 0.87, 0.56, 400);
      await tapCanvasCenter(g);
      adbScreencap(`${ARTIFACTS_DIR}/e2e-A-yi1.png`);
      const vocab = await readVocab(cdp);
      const e = parseEntry(Object.values(vocab)[0]);
      log('A entry:', JSON.stringify(e));
      if (!e) fail('A: no vocab entry written');
      else {
        assertEq(e.word, '一', 'A.word');
        assertEq(e.attempts, 1, 'A.attempts');
        assertEq(e.successes, 1, 'A.successes');
        assertEq(e.failed, false, 'A.failed');
        if (e.interval > 0) pass(`A.interval=${e.interval}s (>0; Anki learning step or legacy fallback)`);
        else fail(`A.interval=${e.interval}s (expected >0)`);
      }
      cdp.close();
    }
  }

  // === B: shi2 perfect ===
  log('\n--- Scenario B: shi2 (十) drawn perfectly ---');
  {
    const cdp = await getCDP();
    await setupListAndGotoTeach(cdp, 'shi2test', 'Shi2 Test');
    const g = await getGeom(cdp);
    if (!g) { fail('B: no canvas'); cdp.close(); }
    else {
      if (!g.body.includes('shí') && !g.body.includes('ten')) fail(`B: no 十 prompt: ${g.body.slice(0, 80)}`);
      else pass('B: 十 card prompt visible');
      // stroke 1 horizontal, stroke 2 vertical
      await drawStrokeFromTo(g, 0.13, 0.55, 0.87, 0.55, 400);
      await drawStrokeFromTo(g, 0.47, 0.20, 0.47, 0.92, 500);
      await tapCanvasCenter(g);
      adbScreencap(`${ARTIFACTS_DIR}/e2e-B-shi2.png`);
      const vocab = await readVocab(cdp);
      const e = parseEntry(Object.values(vocab)[0]);
      log('B entry:', JSON.stringify(e));
      if (!e) fail('B: no vocab entry written');
      else {
        assertEq(e.word, '十', 'B.word');
        assertEq(e.attempts, 1, 'B.attempts');
        assertEq(e.successes, 1, 'B.successes');
        assertEq(e.failed, false, 'B.failed');
        if (e.interval > 0) pass(`B.interval=${e.interval}s (>0; Anki learning step or legacy fallback)`);
        else fail(`B.interval=${e.interval}s (expected >0)`);
      }
      cdp.close();
    }
  }

  // === C: shi2 with ≥3 wrong strokes then correct (lapse) ===
  log('\n--- Scenario C: shi2 (十) with 3 wrong strokes then correct ---');
  {
    const cdp = await getCDP();
    await setupListAndGotoTeach(cdp, 'shi2test', 'Shi2 Test');
    const g = await getGeom(cdp);
    if (!g) { fail('C: no canvas'); cdp.close(); }
    else {
      // Install an error listener now (after teach load), to detect JS crashes
      await ev(cdp, `window.__c_errs = []; window.addEventListener('error', (e) => window.__c_errs.push(e.message));
        window.addEventListener('unhandledrejection', (e) => window.__c_errs.push('rej:' + (e.reason && e.reason.message || e.reason)));`);

      // Three obviously wrong strokes — none match either stroke of 十
      await drawStrokeFromTo(g, 0.10, 0.10, 0.90, 0.90, 400);
      await drawStrokeFromTo(g, 0.10, 0.90, 0.90, 0.10, 400);
      await drawStrokeFromTo(g, 0.05, 0.50, 0.50, 0.05, 400);
      adbScreencap(`${ARTIFACTS_DIR}/e2e-C-3wrong.png`);

      const errsMid = await ev(cdp, `window.__c_errs.length`);
      assertEq(errsMid, 0, 'C: no JS errors after 3 wrong strokes');

      // Now draw the correct strokes
      await drawStrokeFromTo(g, 0.13, 0.55, 0.87, 0.55, 400);
      await drawStrokeFromTo(g, 0.47, 0.20, 0.47, 0.92, 500);
      await tapCanvasCenter(g);
      adbScreencap(`${ARTIFACTS_DIR}/e2e-C-done.png`);

      const errsEnd = await ev(cdp, `window.__c_errs`);
      if (Array.isArray(errsEnd) && errsEnd.length === 0) pass('C: no JS errors throughout');
      else fail('C: JS errors: ' + JSON.stringify(errsEnd));

      const vocab = await readVocab(cdp);
      const e = parseEntry(Object.values(vocab)[0]);
      log('C entry:', JSON.stringify(e));
      if (!e) fail('C: no vocab entry written');
      else {
        assertEq(e.word, '十', 'C.word');
        assertEq(e.attempts, 1, 'C.attempts');
        assertEq(e.successes, 0, 'C.successes (lapse → no success counted)');
        assertEq(e.failed, true, 'C.failed (lapse marker)');
        if (e.interval === 0) pass(`C.interval=0s (lapse: next==last)`);
        else fail(`C.interval=${e.interval}s (expected 0 for lapse)`);
      }
      cdp.close();
    }
  }

  log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((e) => {
  console.error('FATAL:', e.message, e.stack);
  process.exit(2);
});
