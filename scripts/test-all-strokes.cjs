#!/usr/bin/env node
/**
 * Realistic stroke test: draw each character using only the SVG path outlines
 * (NOT medians). Derives start/end points from the visual shape, then draws
 * the simplest possible stroke — a rough line from A to B, like a human would.
 *
 * Usage:
 *   node scripts/test-all-strokes.cjs
 *   HEADED=1 node scripts/test-all-strokes.cjs
 */
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HEADED = process.argv.includes('--headed') || process.env.HEADED === '1';
const PORT = 9877;
const URL = `http://localhost:${PORT}/`;
const WWW = path.join(__dirname, '..', 'www');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (v, amount = 10) => v + (Math.random() - 0.5) * 2 * amount;

// ---------------------------------------------------------------------------
// SVG path parser + skeleton extraction (NO median data used)
// ---------------------------------------------------------------------------
function parseSVGPath(d) {
  const tokens = d.split(/\s+/);
  let i = 0;
  const next = () => parseFloat(tokens[i++]);
  const points = [];
  let cx = 0, cy = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') { cx = next(); cy = next(); points.push([cx, cy]); }
    else if (cmd === 'L') { cx = next(); cy = next(); points.push([cx, cy]); }
    else if (cmd === 'Q') {
      const a = next(), b = next(), e = next(), f = next();
      for (let t = 0.1; t <= 1.01; t += 0.1)
        points.push([(1-t)*(1-t)*cx + 2*(1-t)*t*a + t*t*e,
                      (1-t)*(1-t)*cy + 2*(1-t)*t*b + t*t*f]);
      cx = e; cy = f;
    } else if (cmd === 'C') {
      const a = next(), b = next(), c = next(), d2 = next(), e = next(), f = next();
      for (let t = 0.1; t <= 1.01; t += 0.1)
        points.push([(1-t)**3*cx + 3*(1-t)**2*t*a + 3*(1-t)*t**2*c + t**3*e,
                      (1-t)**3*cy + 3*(1-t)**2*t*b + 3*(1-t)*t**2*d2 + t**3*f]);
      cx = e; cy = f;
    } else if (cmd === 'Z') break;
  }
  return points;
}

// Rasterize SVG outline → distance transform → ridge → skeleton centerline.
// This derives the stroke path purely from the visual shape, not from medians.
function computeSkeleton(svgPath, gs = 48) {
  const outline = parseSVGPath(svgPath);
  const sc = gs / 1024;
  const gp = outline.map(([x, y]) => [Math.round(x * sc), Math.round((900 - y) * sc)]);

  // Scanline fill
  const g = Array.from({length: gs}, () => new Uint8Array(gs));
  for (let r = 0; r < gs; r++) {
    const cr = [];
    for (let i = 0; i < gp.length; i++) {
      const [x1, y1] = gp[i], [x2, y2] = gp[(i + 1) % gp.length];
      if ((y1 <= r && y2 > r) || (y2 <= r && y1 > r))
        cr.push(Math.round(x1 + (r - y1) / (y2 - y1) * (x2 - x1)));
    }
    cr.sort((a, b) => a - b);
    for (let i = 0; i < cr.length - 1; i += 2)
      for (let c = Math.max(0, cr[i]); c <= Math.min(gs - 1, cr[i + 1]); c++)
        g[r][c] = 1;
  }

  // Chamfer distance transform (2-pass, fast)
  const d = Array.from({length: gs}, () => new Float64Array(gs));
  for (let r = 0; r < gs; r++) for (let c = 0; c < gs; c++) {
    if (!g[r][c]) { d[r][c] = 0; continue; }
    let v = 999;
    if (r > 0) v = Math.min(v, d[r-1][c] + 1);
    if (c > 0) v = Math.min(v, d[r][c-1] + 1);
    if (r > 0 && c > 0) v = Math.min(v, d[r-1][c-1] + 1.4);
    if (r > 0 && c < gs-1) v = Math.min(v, d[r-1][c+1] + 1.4);
    d[r][c] = v;
  }
  for (let r = gs-1; r >= 0; r--) for (let c = gs-1; c >= 0; c--) {
    if (!g[r][c]) continue;
    let v = d[r][c];
    if (r < gs-1) v = Math.min(v, d[r+1][c] + 1);
    if (c < gs-1) v = Math.min(v, d[r][c+1] + 1);
    if (r < gs-1 && c < gs-1) v = Math.min(v, d[r+1][c+1] + 1.4);
    if (r < gs-1 && c > 0) v = Math.min(v, d[r+1][c-1] + 1.4);
    d[r][c] = v;
  }

  // Extract ridge (local maxima of distance)
  const ridge = [];
  for (let r = 1; r < gs-1; r++) for (let c = 1; c < gs-1; c++) {
    if (d[r][c] < 0.8) continue;
    const v = d[r][c];
    if ((v >= d[r][c-1] && v >= d[r][c+1]) || (v >= d[r-1][c] && v >= d[r+1][c]))
      ridge.push([c / sc, 900 - r / sc, v]);
  }

  if (ridge.length < 2) {
    // Fallback: return start and midpoint of outline
    return [outline[0], outline[Math.floor(outline.length / 2)]];
  }

  // Sort ridge by main axis (horizontal or vertical)
  const xR = Math.max(...ridge.map(p => p[0])) - Math.min(...ridge.map(p => p[0]));
  const yR = Math.max(...ridge.map(p => p[1])) - Math.min(...ridge.map(p => p[1]));
  ridge.sort(xR >= yR ? (a, b) => a[0] - b[0] : (a, b) => b[1] - a[1]);

  // Keep only the thicker points (near center of stroke)
  const maxD = Math.max(...ridge.map(p => p[2]));
  const thick = ridge.filter(p => p[2] > maxD * 0.35);

  // Subsample to 4-8 points
  const step = Math.max(1, Math.floor(thick.length / 6));
  const result = [];
  for (let i = 0; i < thick.length; i += step)
    result.push([thick[i][0], thick[i][1]]);
  // Ensure last point is included
  const last = thick[thick.length - 1];
  if (result.length > 0) {
    const rl = result[result.length - 1];
    if (Math.abs(rl[0] - last[0]) > 10 || Math.abs(rl[1] - last[1]) > 10)
      result.push([last[0], last[1]]);
  }

  return result;
}

// Convert makemeahanzi coords to viewport coords
// Coords: x 0-1024, y 0-900 (bottom-up) → canvas 512x512 (top-down)
function toViewport(point, canvasRect) {
  const [mx, my] = point;
  const nx = mx / 1024;
  const ny = (900 - my) / 1024;
  const zoom = 512 / canvasRect.width;
  return [canvasRect.left + nx * 512 / zoom, canvasRect.top + ny * 512 / zoom];
}

// Draw a single stroke following a skeleton path (array of points in makemeahanzi coords)
async function drawStroke(page, skelPoints, canvasRect) {
  if (skelPoints.length < 2) return;

  const vps = skelPoints.map(p => toViewport(p, canvasRect));

  // Start with jitter
  const [sx, sy] = [jitter(vps[0][0]), jitter(vps[0][1])];
  await page.mouse.move(sx, sy);
  await page.mouse.down();

  // Follow each skeleton point with interpolation + wobble
  for (let i = 1; i < vps.length; i++) {
    const [tx, ty] = [jitter(vps[i][0]), jitter(vps[i][1])];
    const [px, py] = i === 1 ? [sx, sy] : [jitter(vps[i-1][0], 3), jitter(vps[i-1][1], 3)];
    const dx = tx - px, dy = ty - py;
    const steps = Math.max(2, Math.min(5, Math.round(Math.sqrt(dx*dx + dy*dy) / 20)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      await page.mouse.move(
        px + dx * t + (Math.random() - 0.5) * 5,
        py + dy * t + (Math.random() - 0.5) * 5
      );
      await sleep(10 + Math.random() * 12);
    }
  }

  await page.mouse.up();
  await sleep(80 + Math.random() * 120);
}

// ---------------------------------------------------------------------------
// Load character data
// ---------------------------------------------------------------------------
function loadCharacterData(character) {
  const index = Math.floor(character.charCodeAt(0) / 256);
  const file = path.join(WWW, 'assets', 'characters_v2', `${index}.json`);
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const data = JSON.parse(line);
      if (data.character === character) return data;
    } catch (e) {}
  }
  return null;
}

// Compute skeleton paths from SVG outlines (NOT medians)
function computeStrokePaths(charData) {
  return charData.strokes.map(svgPath => computeSkeleton(svgPath));
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------
(async () => {
  // Pre-load all characters from 100cr list
  const listFile = path.join(WWW, 'assets', 'lists', '100cr.list');
  const listChars = fs.readFileSync(listFile, 'utf8').split('\n').filter(Boolean)
    .map(line => line.split('\t')[0]);
  console.log(`List: ${listChars.length} characters`);

  // Pre-compute skeleton paths from SVG outlines (NOT medians)
  const charPaths = {};
  let loaded = 0, totalStrokes = 0;
  for (const ch of listChars) {
    const data = loadCharacterData(ch);
    if (!data) continue;
    charPaths[ch] = computeStrokePaths(data);
    totalStrokes += charPaths[ch].length;
    loaded++;
  }
  console.log(`Pre-computed skeletons for ${loaded} chars, ${totalStrokes} strokes from SVG paths\n`);

  // Start server + browser
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', 'www'], {
    stdio: 'ignore', detached: true,
  });
  await sleep(1500);

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: HEADED ? false : 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const results = { passed: [], failed: [] };

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 400, height: 800 });

    // Setup
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForFunction('typeof Router !== "undefined"', { timeout: 15000 });

    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      localStorage.setItem('table.lists.lists', JSON.stringify({
        '100cr': { category: 'General', name: '100 Common Radicals' },
      }));
      localStorage.setItem('table.settings.max_adds', '200');
    });

    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForFunction('typeof Router !== "undefined"', { timeout: 15000 });

    // Enable list
    await page.evaluate('Router.go("lists")');
    await sleep(3000);
    await page.evaluate(() => {
      for (const item of document.querySelectorAll('.item-toggle, .item'))
        if (item.textContent.includes('100 Common')) {
          const input = item.querySelector('input[type="checkbox"]');
          if (input) input.click();
        }
    });
    await sleep(8000);

    // Teach
    await page.evaluate('Router.go("teach")');
    await sleep(5000);

    console.log('=== Drawing strokes from SVG outlines (NOT medians) ===\n');

    let cardNum = 0;
    while (cardNum < 200) {
      // Check for error/done card
      const isDone = await page.evaluate(() => {
        const err = document.querySelector('.error');
        return err && err.textContent.trim().length > 5
          ? err.textContent.trim().replace(/\s+/g, ' ').substring(0, 80) : null;
      });
      if (isDone) { console.log(`\nSession ended: ${isDone}`); break; }

      // Wait for canvas
      const hasCanvas = await page.evaluate(() => !!document.querySelector('canvas'));
      if (!hasCanvas) { await sleep(1000); continue; }

      // Get current word from Timing
      const cardWord = await page.evaluate(() => {
        try {
          const { Timing } = require('/client/model/timing');
          const card = Timing.getNextCard();
          return card && card.data ? card.data.word : null;
        } catch (e) { return null; }
      });
      if (!cardWord) { await sleep(1000); continue; }

      // Get all skeleton paths for this word
      const allPaths = [];
      for (const ch of Array.from(cardWord)) {
        if (charPaths[ch]) {
          allPaths.push(...charPaths[ch]);
        } else {
          const data = loadCharacterData(ch);
          if (data) allPaths.push(...computeStrokePaths(data));
        }
      }

      if (allPaths.length === 0) {
        process.stdout.write(`  ${cardWord} — no SVG data\n`);
        cardNum++;
        continue;
      }

      // Get canvas rect
      const rect = await page.evaluate(() => {
        const c = document.querySelector('canvas');
        const r = c.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      });

      const pinyin = await page.evaluate(() => {
        const p = document.querySelector('.prompt .pinyin');
        return p ? p.textContent.trim() : '?';
      });

      process.stdout.write(`  ${cardWord} (${pinyin}, ${allPaths.length} strokes) ... `);

      // Draw each stroke following its skeleton path
      for (const skelPath of allPaths) {
        await drawStroke(page, skelPath, rect);
      }

      await sleep(400);

      // Click to advance
      await page.mouse.click(rect.left + rect.width/2, rect.top + rect.height/2);
      await sleep(600);

      // Check if card changed
      const afterWord = await page.evaluate(() => {
        try {
          const { Timing } = require('/client/model/timing');
          const card = Timing.getNextCard();
          return card && card.data ? card.data.word : '__done__';
        } catch (e) { return null; }
      });

      if (afterWord !== cardWord) {
        process.stdout.write('OK\n');
        results.passed.push(cardWord);
      } else {
        process.stdout.write('FAIL\n');
        results.failed.push(cardWord);
        // Force skip: click to max penalties → double-click reveal →
        // draw random strokes until it completes or gives up
        const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
        for (let attempt = 0; attempt < 3; attempt++) {
          // Click to add penalties
          await page.mouse.click(cx, cy); await sleep(200);
          await page.mouse.click(cx, cy); await sleep(200);
          // Double-click for reveal (only works when penalties >= max)
          await page.mouse.click(cx, cy, { clickCount: 2 }); await sleep(300);
          // Draw a random stroke (might match something revealed)
          const rx = rect.left + rect.width * 0.1;
          const ry = cy + (attempt - 1) * rect.height * 0.2;
          await page.mouse.move(rx, ry);
          await page.mouse.down();
          for (let s = 1; s <= 5; s++) {
            await page.mouse.move(rx + rect.width * 0.8 * s / 5, ry);
            await sleep(15);
          }
          await page.mouse.up(); await sleep(200);
          // Click to try advance
          await page.mouse.click(cx, cy); await sleep(400);
          // Check if card changed
          const w = await page.evaluate(() => {
            try { return require('/client/model/timing').Timing.getNextCard()?.data?.word; }
            catch(e) { return null; }
          });
          if (w !== cardWord) break;
        }
      }

      cardNum++;
    }

    // Summary
    console.log(`\n=== Results (SVG-derived, simple lines, ±10px jitter) ===`);
    console.log(`  Passed: ${results.passed.length}`);
    console.log(`  Failed: ${results.failed.length}`);
    if (results.failed.length > 0) {
      console.log(`  Failed: ${results.failed.join(' ')}`);
    }
    console.log(`  Total:  ${cardNum} cards`);

    if (results.failed.length > 0) process.exitCode = 1;

    if (HEADED) {
      console.log('\nCtrl+C to exit.');
      await new Promise(() => {});
    }

  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill();
  }
})();
