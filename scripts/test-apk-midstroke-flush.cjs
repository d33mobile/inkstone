#!/usr/bin/env node
/**
 * Targeted regression test for the pre-2db5579b `getNextCard` preempt-
 * reactivity bug.
 *
 * Mechanism of the bug (per NOTES.md on the anki-scheduler branch):
 *   1. The wrapper around Timing.getNextCard read `next_card.get()`
 *      *before* checking for a due learning card, registering a
 *      reactive dependency on next_card even when it was about to be
 *      preempted.
 *   2. teach/code.js runs `Tracker.autorun(updateCard)` which calls
 *      Timing.getNextCard().
 *   3. Whenever next_card changed (or `Tracker.flush()` ran with a
 *      pending invalidation), updateCard re-evaluated.
 *   4. Because the wrapper returned a brand-new object each call, the
 *      autorun considered the value changed → the `task` reactive was
 *      replaced → the {{> handwriting}} helper recomputed → the canvas
 *      widget was destroyed and re-created mid-stroke. The pointer
 *      handlers that were holding `task.recording` pointed at a dead
 *      object.
 *
 * To force the exact firing the bug needs, this test drives the gesture
 * one touch event at a time over the Chrome DevTools `Input.
 * dispatchTouchEvent` protocol, and between move events it calls
 * `Tracker.flush()` from inside the page so any pending invalidation
 * runs synchronously.
 *
 * If the bug is present, the canvas reference held by the handwriting
 * widget goes stale between touchstart and touchend → the stroke is
 * never recorded → the character never completes → the per-card
 * scheduler state is wrong.
 */
const WebSocket = require('ws');
const { spawnSync } = require('child_process');

const ADB = process.env.ADB || '/opt/android-sdk/platform-tools/adb';
const CDP_PORT = process.env.CDP_PORT || '9222';
const PKG = process.env.PKG || 'me.skishore.inkstone';
const STATUS_BAR_PX = parseInt(process.env.STATUS_BAR_PX || '63', 10);
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || '/tmp';
const FLUSHES_PER_STROKE = parseInt(process.env.FLUSHES_PER_STROKE || '4', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

let passed = 0, failed = 0;
const pass = (m) => { passed++; log('PASS:', m); };
const fail = (m) => { failed++; log('FAIL:', m); };
const assertEq = (got, want, label) => {
  if (got === want) pass(`${label} = ${JSON.stringify(got)}`);
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

function makeCDP(wsUrl) {
  const ws = new WebSocket(wsUrl);
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
  const r = spawnSync('curl', ['-s', `http://localhost:${CDP_PORT}/json`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('curl devtools list failed: ' + r.stderr);
  const arr = JSON.parse(r.stdout);
  const tgt = arr.find((t) => t.type === 'page' || t.type === 'webview');
  if (!tgt) throw new Error('no inkstone WebView devtools target visible');
  const cdp = makeCDP(tgt.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  return cdp;
}

async function installErrorTrap(cdp) {
  await ev(cdp, `
    window.__ms_errs = window.__ms_errs || [];
    if (!window.__ms_listener) {
      window.addEventListener('error', (e) => window.__ms_errs.push('error: ' + (e.message || String(e))));
      window.addEventListener('unhandledrejection', (e) =>
        window.__ms_errs.push('rej: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason))));
      window.__ms_listener = true;
    }
  `);
}

async function readErrs(cdp) {
  return (await ev(cdp, `window.__ms_errs || []`)) || [];
}

async function bodySnippet(cdp) {
  return ev(cdp, `document.body.innerText.slice(0, 250)`);
}

async function seedListsAndGotoTeach(cdp, lists) {
  const listsJson = JSON.stringify(Object.fromEntries(
    lists.map(({ key, name }) => [key, { category: 'Test', name }])
  ));
  await ev(cdp, `
    Object.keys(localStorage).forEach((k) => { if (k.startsWith('table.')) localStorage.removeItem(k); });
    localStorage.setItem('table.lists.lists', ${JSON.stringify(listsJson)});
  `);
  await ev(cdp, `location.href = location.origin + '/'`);
  await sleep(2000);
  for (let i = 0; i < 40; i++) {
    try { if (await ev(cdp, `typeof Router !== 'undefined'`)) break; } catch (e) {}
    await sleep(500);
  }
  await installErrorTrap(cdp);
  await ev(cdp, `Router.go('lists')`);
  await sleep(3500);
  for (const { name } of lists) {
    const r = await ev(cdp, `(() => {
      for (const it of document.querySelectorAll('.item-toggle, .item')) {
        if (it.textContent.indexOf(${JSON.stringify(name)}) >= 0) {
          const i = it.querySelector('input[type=checkbox]');
          if (i) { i.click(); return 'clicked'; }
        }
      }
      return 'notfound';
    })()`);
    if (r !== 'clicked') throw new Error(`toggle for ${name}: ${r}`);
    await sleep(2000);
  }
  await sleep(6000);
  await ev(cdp, `Router.go('teach')`);
  await sleep(5500);
  await installErrorTrap(cdp);
}

async function getGeom(cdp) {
  return ev(cdp, `(() => {
    const c = document.querySelector('canvas'); if (!c) return null;
    const r = c.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, dpr: window.devicePixelRatio };
  })()`);
}

async function currentCardChar(cdp) {
  const body = await bodySnippet(cdp);
  if (body.includes('yī')) return '一';
  if (body.includes('shí')) return '十';
  if (body.includes('sān')) return '三';
  return null;
}

// Dispatch the gesture from inside the page so each touch event is
// observed by handwriting.js, and between sub-segments call
// Tracker.flush() to drain pending reactivity (the exact thing that
// the pre-fix bug needed to fire mid-stroke).
async function strokeWithMidstrokeFlushes(cdp, points, flushesAt) {
  // points: array of {xf, yf} in canvas-relative fractions
  // flushesAt: indices into points after which to call Tracker.flush
  const flushSet = new Set(flushesAt);
  const expr = `(async () => {
    const c = document.querySelector('canvas');
    const rect = c.getBoundingClientRect();
    const pts = ${JSON.stringify(points)};
    const flush_at = ${JSON.stringify([...flushSet])};
    const flush_set = new Set(flush_at);
    const make = (x, y, type) => {
      const ev = new TouchEvent(type, {
        bubbles: true, cancelable: true, view: window,
        touches: type === 'touchend' ? [] : [new Touch({
          identifier: 1, target: c,
          clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y,
          radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1
        })],
        targetTouches: type === 'touchend' ? [] : [new Touch({
          identifier: 1, target: c,
          clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y,
          radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1
        })],
        changedTouches: [new Touch({
          identifier: 1, target: c,
          clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y,
          radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1
        })],
      });
      return ev;
    };
    const flush = () => {
      try {
        // Force the next_card dep to invalidate, then drain pending
        // reactivity synchronously. This is the in-page equivalent of
        // the periodic Meteor.setInterval(Tracker.flush, 10000) that
        // surfaced the original bug — but deterministic and synchronous.
        if (window.Timing && window.Timing.next_card && window.Timing.next_card.dep) {
          window.Timing.next_card.dep.changed();
        }
        Tracker.flush();
      } catch (e) { window.__ms_errs.push('flush: ' + e.message); }
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const px = (p) => ({ x: rect.left + rect.width * p.xf, y: rect.top + rect.height * p.yf });
    let i = 0;
    const first = px(pts[0]);
    c.dispatchEvent(make(first.x, first.y, 'touchstart'));
    for (i = 1; i < pts.length; i++) {
      const p = px(pts[i]);
      c.dispatchEvent(make(p.x, p.y, 'touchmove'));
      if (flush_set.has(i)) flush();
      await sleep(40);
    }
    const last = px(pts[pts.length - 1]);
    c.dispatchEvent(make(last.x, last.y, 'touchend'));
    flush();
    return 'ok';
  })()`;
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('stroke: ' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function tapCanvasCenter(geom) {
  const c = { x: Math.round((geom.left + geom.width / 2) * geom.dpr), y: Math.round((geom.top + geom.height / 2) * geom.dpr) + STATUS_BAR_PX };
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

function parseAll(vocab) {
  const out = {};
  for (const raw of Object.values(vocab)) {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const e = arr[0];
    out[e[0]] = {
      word: e[0], attempts: e[4], successes: e[5], failed: e[6],
      interval: e[2] - e[1],
    };
  }
  return out;
}

// Sample N intermediate points evenly from (x0,y0) to (x1,y1).
function linePoints(x0, y0, x1, y1, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ xf: x0 + (x1 - x0) * t, yf: y0 + (y1 - y0) * t });
  }
  return pts;
}

(async () => {
  log('=== Mid-stroke Tracker.flush regression test ===');
  log('FLUSHES_PER_STROKE =', FLUSHES_PER_STROKE);

  const cdp = await getCDP();
  await seedListsAndGotoTeach(cdp, [
    { key: 'yi1test', name: 'Yi1 Test' },
    { key: 'shi2test', name: 'Shi2 Test' },
    { key: 'san1test', name: 'San1 Test' },
  ]);

  // First, drive 三 into the failures queue. Three wrong straight-line
  // strokes overshoot kMaxMistakes; then three correct horizontals
  // complete it as a lapse → it lands in the failures deck with
  // next == last → due *immediately*, so subsequent getNextCard calls
  // take the preempt path (which is where the bug lives).
  let char = await currentCardChar(cdp);
  let geom = await getGeom(cdp);
  if (char !== '三') {
    // san1test ought to be the first card via its category order; if
    // not, just complete whatever's on screen and try again.
    log(`Note: first card was ${char}, not 三 — completing it to surface 三.`);
    // Treat as a single horizontal anyway.
    await strokeWithMidstrokeFlushes(cdp, linePoints(0.13, 0.56, 0.87, 0.56, 8), []);
    await sleep(1500);
    await tapCanvasCenter(geom);
    char = await currentCardChar(cdp);
    geom = await getGeom(cdp);
  }
  log(`Lapsing card: ${char}`);
  for (const [a, b, c, d] of [[0.10, 0.10, 0.90, 0.90], [0.10, 0.90, 0.90, 0.10], [0.05, 0.50, 0.50, 0.05]]) {
    await strokeWithMidstrokeFlushes(cdp, linePoints(a, b, c, d, 6), []);
    await sleep(800);
  }
  // Now complete it with 三-shaped strokes (top, middle, bottom horiz).
  for (const [a, b, c, d] of [[0.31, 0.34, 0.71, 0.32], [0.32, 0.60, 0.68, 0.58], [0.12, 0.85, 0.93, 0.83]]) {
    await strokeWithMidstrokeFlushes(cdp, linePoints(a, b, c, d, 6), []);
    await sleep(800);
  }
  await tapCanvasCenter(geom);
  adbScreencap(`${ARTIFACTS_DIR}/midstroke-1-after-lapse.png`);

  // Confirm the lapse landed.
  let vocab = parseAll(await readVocab(cdp));
  log('Vocab after lapsing the first card:', JSON.stringify(vocab));
  const lapsedChar = Object.keys(vocab).find((c) => vocab[c].failed) || char;
  if (!vocab[lapsedChar] || !vocab[lapsedChar].failed) {
    fail(`expected one card to be in failures queue, got ${JSON.stringify(vocab)}`);
  } else {
    pass(`${lapsedChar} is in failures queue (next == last)`);
  }

  // Now we should be on a different card. Draw it with mid-stroke
  // Tracker.flush() calls. If the pre-fix bug is present the canvas
  // helper recomputes between touchstart and touchend and the stroke
  // is discarded (the handwriting widget points at a dead canvas);
  // result: the card never completes → no successes recorded.
  const targetChar = await currentCardChar(cdp);
  geom = await getGeom(cdp);
  log(`\nMid-stroke flush target: ${targetChar} (geom ${JSON.stringify({w: geom.width, h: geom.height})})`);
  if (!targetChar) { fail('no card on screen for mid-stroke flush'); process.exit(1); }

  // Build the stroke path for whichever card came up. Each card needs
  // ALL its strokes drawn for it to complete — so we drive every
  // stroke with mid-stroke flushes.
  const strokeSet = ({
    '一': [[0.13, 0.56, 0.87, 0.56]],
    '十': [[0.13, 0.55, 0.87, 0.55], [0.47, 0.20, 0.47, 0.92]],
    '三': [[0.31, 0.34, 0.71, 0.32], [0.32, 0.60, 0.68, 0.58], [0.12, 0.85, 0.93, 0.83]],
  })[targetChar];
  if (!strokeSet) { fail(`unknown target ${targetChar}`); process.exit(1); }

  // 12 sub-points per stroke; flush after the 3rd, 6th, 9th, … one.
  for (const [a, b, c, d] of strokeSet) {
    const pts = linePoints(a, b, c, d, 12);
    const flushIdx = [];
    const step = Math.max(1, Math.floor(pts.length / (FLUSHES_PER_STROKE + 1)));
    for (let i = step; i < pts.length; i += step) flushIdx.push(i);
    log(`stroke ${a}->${c} with flushes at indices ${JSON.stringify(flushIdx)}`);
    await strokeWithMidstrokeFlushes(cdp, pts, flushIdx);
    await sleep(1200);
  }
  await tapCanvasCenter(geom);
  await sleep(1500);
  adbScreencap(`${ARTIFACTS_DIR}/midstroke-2-after-flushed-card.png`);

  vocab = parseAll(await readVocab(cdp));
  log('\nVocab after mid-stroke-flushed card:', JSON.stringify(vocab));

  const entry = vocab[targetChar];
  if (!entry) {
    fail(`no vocab entry for ${targetChar}`);
  } else if (entry.attempts !== 1) {
    fail(`${targetChar}.attempts=${entry.attempts} (expected 1 — the card never completed; strokes likely lost mid-flush)`);
  } else if (entry.successes !== 1) {
    fail(`${targetChar}.successes=${entry.successes} (expected 1; the bug discards mid-flush strokes so the character never matched)`);
  } else if (entry.failed !== false) {
    fail(`${targetChar}.failed=${entry.failed} (expected false; mid-flush stroke loss can also produce false-positive lapses)`);
  } else {
    pass(`${targetChar}: card completed cleanly through ${FLUSHES_PER_STROKE} mid-stroke Tracker.flush()es per stroke`);
  }

  const errs = await readErrs(cdp);
  if (errs.length === 0) pass('no JS errors / unhandled rejections across the mid-flushed session');
  else fail(`${errs.length} JS errors during mid-flush stroke: ${JSON.stringify(errs.slice(0, 5))}`);

  log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  cdp.close();
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((e) => { console.error('FATAL:', e.message, e.stack); process.exit(2); });
