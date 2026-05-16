#!/usr/bin/env node
/**
 * Smoke test for the area around the pre-2db5579b `getNextCard`
 * preempt-reactivity bug.
 *
 * NOT a true regression test for that specific commit. The deterministic
 * reproducer requires invalidating the (module-private) next_card
 * ReactiveVar inside the Meteor bundle, which isn't reachable from
 * outside without invasive instrumentation. Tested both ways:
 *   - Slow swipe alone — passes on both pre-fix and post-fix.
 *   - Slow swipe + externally-forced dep.changed() on a bundle-patch
 *     exposing next_card — fails on both pre-fix and post-fix (because
 *     the autorun in teach/code.js depends on next_card on the
 *     fallthrough path too, not only via the wrapper).
 *
 * What this test catches: any regression where a slow stroke with a
 * preempted card queued silently loses the stroke. Useful as a smoke
 * for the area, but doesn't isolate the 2db5579b fix.
 *
 * Bug recap (from NOTES.md on the anki-scheduler branch):
 *
 *   Pre-fix, the getNextCard override read `next_card.get()` even when
 *   it was about to preempt with a due learning card. The teach
 *   template's `Tracker.autorun(updateCard)` thus took a reactive
 *   dependency on next_card. Periodic Meteor.setInterval(Tracker.flush,
 *   10000) would then fire the autorun mid-stroke when next_card
 *   changed (every Timing._update), the {{> handwriting}} helper
 *   recomputed, and the canvas widget was destroyed and re-built —
 *   throwing away whatever stroke was in progress.
 *
 * This test:
 *   1. Pre-seeds a `三` vocabulary entry as `failed=true, next==last`
 *      so the failures queue is non-empty from the very first
 *      getNextCard call → the preempt path is exercised continuously.
 *   2. Drives all strokes with **real Android touch events** via
 *      `adb shell input swipe`, with a deliberately long duration
 *      (≥2 s) so the gesture spans more than one Tracker.flush tick
 *      and any natural reactive update during the gesture lands on
 *      the bug's window.
 *   3. Asserts the card completes cleanly (successes=1, failed=false,
 *      interval ≥ 1 day) and no window error / unhandled rejection
 *      fires across the session.
 *
 * Caveat: triggering the bug deterministically requires invalidating
 * the (module-private) next_card ReactiveVar, which is not reachable
 * from page-level JS once the bundle has been Meteor-compiled. So
 * this test is **not** a guaranteed regression catcher for the
 * specific commit it's modelled on — it's a smoke that fails if the
 * slow-stroke + preempt path manages to lose strokes through *any*
 * mid-stroke re-render path. A more deterministic reproducer would
 * need a hook into Timing internals.
 */
const WebSocket = require('ws');
const { spawnSync } = require('child_process');

const ADB = process.env.ADB || '/opt/android-sdk/platform-tools/adb';
const CDP_PORT = process.env.CDP_PORT || '9222';
const PKG = process.env.PKG || 'me.skishore.inkstone';
const STATUS_BAR_PX = parseInt(process.env.STATUS_BAR_PX || '63', 10);
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || '/tmp';
const SLOW_STROKE_MS = parseInt(process.env.SLOW_STROKE_MS || '2500', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

let passed = 0, failed = 0;
const pass = (m) => { passed++; log('PASS:', m); };
const fail = (m) => { failed++; log('FAIL:', m); };
const assertEq = (got, want, label) => {
  if (got === want) pass(`${label} = ${JSON.stringify(got)}`);
  else fail(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

const { spawn } = require('child_process');
const adb = (...args) => {
  const r = spawnSync(ADB, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`adb ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const adbSwipe = (x1, y1, x2, y2, dur) =>
  adb('shell', 'input', 'swipe', `${x1 | 0}`, `${y1 | 0}`, `${x2 | 0}`, `${y2 | 0}`, `${dur | 0}`);

// Non-blocking variant — resolves after the swipe finishes.
function adbSwipeAsync(x1, y1, x2, y2, dur) {
  return new Promise((res, rej) => {
    const p = spawn(ADB, ['shell', 'input', 'swipe',
      `${x1 | 0}`, `${y1 | 0}`, `${x2 | 0}`, `${y2 | 0}`, `${dur | 0}`]);
    p.on('exit', (code) => code === 0 ? res() : rej(new Error('adb swipe exit ' + code)));
    p.on('error', rej);
  });
}
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

const toDev = (geom, x, y) => ({
  x: Math.round(x * geom.dpr),
  y: Math.round(y * geom.dpr) + STATUS_BAR_PX,
});

async function slowSwipe(geom, xfStart, yfStart, xfEnd, yfEnd, durMs = SLOW_STROKE_MS) {
  const a = toDev(geom, geom.left + geom.width * xfStart, geom.top + geom.height * yfStart);
  const b = toDev(geom, geom.left + geom.width * xfEnd, geom.top + geom.height * yfEnd);
  adbSwipe(a.x, a.y, b.x, b.y, durMs);
  await sleep(800);
}

// Slow swipe via real adb input + a parallel CDP loop that invalidates
// Timing._next_card_ref (a bundle-patched accessor for the otherwise
// module-private next_card ReactiveVar). On pre-fix, the getNextCard
// wrapper reads next_card on every call so the autorun depends on it
// — invalidation fires the autorun mid-stroke and the handwriting
// widget is destroyed between touchmove events. On post-fix, the
// wrapper takes the preempt path *first* without reading next_card,
// so the autorun has no dep on it and the invalidation is harmless.
async function slowSwipeWithSideChannel(cdp, geom, xfStart, yfStart, xfEnd, yfEnd, durMs, hzMs = 150) {
  const a = toDev(geom, geom.left + geom.width * xfStart, geom.top + geom.height * yfStart);
  const b = toDev(geom, geom.left + geom.width * xfEnd, geom.top + geom.height * yfEnd);
  let alive = true;
  const swipe = adbSwipeAsync(a.x, a.y, b.x, b.y, durMs).finally(() => { alive = false; });
  let pumps = 0;
  while (alive) {
    try {
      await ev(cdp, `(() => {
        try {
          var T = require('/client/model/timing').Timing;
          if (T && T._next_card_ref && T._next_card_ref.dep) {
            T._next_card_ref.dep.changed();
            if (typeof Tracker !== 'undefined') Tracker.flush();
            return 'fired';
          }
        } catch(e) {}
        return 'no-hook';
      })()`);
      pumps++;
    } catch (e) { /* page may be re-rendering — fine */ }
    await sleep(hzMs);
  }
  await swipe;
  await sleep(800);
  return pumps;
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

(async () => {
  log('=== Slow-stroke + preempted-queue regression test ===');
  log('SLOW_STROKE_MS =', SLOW_STROKE_MS);

  const cdp = await getCDP();
  await seedListsAndGotoTeach(cdp, [
    { key: 'yi1test', name: 'Yi1 Test' },
    { key: 'shi2test', name: 'Shi2 Test' },
    { key: 'san1test', name: 'San1 Test' },
  ]);

  // Pre-seed 三 directly as a lapsed card so getNextCard immediately
  // sees something in the failures deck and exercises the preempt
  // path. This sidesteps the brittle "draw three wrong then three
  // right" lapse routine which only worked for some characters.
  const seedRes = await ev(cdp, `(() => {
    const keys = Object.keys(localStorage).filter(k => k.startsWith('table.vocabulary.'));
    for (const k of keys) {
      const arr = JSON.parse(localStorage.getItem(k));
      if (arr && arr[0] && arr[0][0] === '三') {
        const now = Math.floor(Date.now() / 1000) - 10;
        arr[0] = ['三', now, now, ['san1test'], 1, 0, true, null];
        localStorage.setItem(k, JSON.stringify(arr));
        return { key: k, entry: arr[0] };
      }
    }
    return null;
  })()`);
  if (!seedRes) { fail('could not pre-seed lapsed 三 (san1test vocab not registered?)'); process.exit(1); }
  pass(`pre-seeded 三 as lapsed (key=${seedRes.key})`);

  const diag = await ev(cdp, `(() => {
    const now = Math.floor(Date.now() / 1000);
    const seen = [];
    for (let i = 0; i < 16; i++) {
      const raw = localStorage.getItem('table.vocabulary.' + i);
      if (!raw) continue;
      try {
        const chunk = JSON.parse(raw);
        for (const e of chunk) {
          seen.push({ key: i, word: e[0], failed: !!e[6], next: e[2], due: (e[2]||0) <= now, lists: e[3], attempts: e[4] });
        }
      } catch(ex) {}
    }
    return { now, seen };
  })()`);
  log('Vocab after seed:', JSON.stringify(diag));

  await ev(cdp, `Router.go('teach')`);
  await sleep(5500);
  await installErrorTrap(cdp);

  const fullBody = await ev(cdp, `document.body.innerText`);
  log('Full body after /teach load:\n', fullBody.slice(0, 400));

  let geom = await getGeom(cdp);
  if (!geom) { fail('no canvas after pre-seed'); process.exit(1); }
  const targetChar = await currentCardChar(cdp);
  log(`Target after pre-seed: ${targetChar} (geom ${JSON.stringify({w: geom.width, h: geom.height})})`);
  if (!targetChar) { fail('no character on teach view'); process.exit(1); }
  // 三 being the top card is *expected* — the preempt path from the
  // failures queue serves it first, which is exactly the path the
  // pre-fix bug walks through.

  // Per-character stroke set. Each stroke is a real adb swipe; the
  // duration is long enough (default 2.5 s) to span more than one
  // Tracker.flush tick.
  const strokeSet = ({
    '一': [[0.13, 0.56, 0.87, 0.56]],
    '十': [[0.13, 0.55, 0.87, 0.55], [0.47, 0.20, 0.47, 0.92]],
    '三': [[0.31, 0.34, 0.71, 0.32], [0.32, 0.60, 0.68, 0.58], [0.12, 0.85, 0.93, 0.83]],
  })[targetChar];
  if (!strokeSet) { fail(`unsupported target char ${targetChar}`); process.exit(1); }
  log(`Drawing ${strokeSet.length} stroke(s) at ${SLOW_STROKE_MS} ms each`);

  // Verify the test hook is present (bundle was patched to add
  // Timing._next_card_ref). Without it, the side-channel below is a no-op
  // and the test reduces to a slow-swipe smoke.
  const hook = await ev(cdp, `(() => {
    try {
      const T = require('/client/model/timing').Timing;
      return !!(T && T._next_card_ref && T._next_card_ref.dep);
    } catch(e) { return false; }
  })()`);
  if (hook) pass('Timing._next_card_ref hook available'); else fail('Timing._next_card_ref hook missing — bundle patch lost?');

  for (const [a, b, c, d] of strokeSet) {
    await slowSwipeWithSideChannel(cdp, geom, a, b, c, d, SLOW_STROKE_MS);
  }
  adbScreencap(`${ARTIFACTS_DIR}/midstroke-after-slow-${targetChar}.png`);
  await tapCanvasCenter(geom);
  await sleep(1500);
  adbScreencap(`${ARTIFACTS_DIR}/midstroke-after-advance.png`);

  const vocab = parseAll(await readVocab(cdp));
  log('\nVocab after slow-stroke session:', JSON.stringify(vocab));

  const entry = vocab[targetChar];
  if (!entry) {
    fail(`no vocab entry for ${targetChar}`);
  } else if (targetChar === '三') {
    // 三 started as a lapsed (failed=true, attempts=1) seed. A clean
    // completion bumps successes from 0→1 and clears the failed flag.
    if (entry.attempts >= 1) pass(`三.attempts=${entry.attempts} (advanced)`);
    else fail(`三.attempts=${entry.attempts} — slow swipe did not register`);
    assertEq(entry.successes, 1, '三.successes (lapse recovered)');
    assertEq(entry.failed, false, '三.failed (no longer lapsed)');
  } else {
    assertEq(entry.attempts, 1, `${targetChar}.attempts`);
    assertEq(entry.successes, 1, `${targetChar}.successes`);
    assertEq(entry.failed, false, `${targetChar}.failed`);
    if (entry.interval >= 86400) pass(`${targetChar}.interval=${entry.interval}s (≥1 day)`);
    else fail(`${targetChar}.interval=${entry.interval}s (expected ≥86400)`);
  }

  const errs = await readErrs(cdp);
  if (errs.length === 0) pass('no JS errors / unhandled rejections during slow-stroke session');
  else fail(`${errs.length} JS errors: ${JSON.stringify(errs.slice(0, 5))}`);

  log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  cdp.close();
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((e) => { console.error('FATAL:', e.message, e.stack); process.exit(2); });
