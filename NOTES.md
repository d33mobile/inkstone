# Session Notes — 2026-03-27

## What was done

### Anki SM-2 integration (master branch, tagged `before-ts`)
1. Vendored Anki's SM-2 state machine (Rust) from ankitects/anki, compiled to WASM (107KB)
2. Runtime monkey-patch (`www/anki-scheduler-patch.js`) overrides `Vocabulary.updateItem` in old Meteor bundle
3. Vocabulary schema extended 7→8 columns (ankiState stored per card)
4. Settings UI for Anki algorithm parameters
5. Version + build date on home screen
6. Source-level `timing.js` fix: due learning cards checked before adds/reviews in `shuffle()`
7. **Attempted** `getNextCard` wrapper to preempt reviews with due learning cards → **REVERTED** (caused teach template crash — Tracker.autorun re-initialized canvas mid-stroke)

### TypeScript rewrite (typescript-rewrite branch)
1. Vite + Preact + TypeScript replaces Meteor + Blaze
2. All model/lib/anki code converted to strict TypeScript (26 files)
3. Components: Home, Teach, Lists, Settings, Layout
4. Canvas stroke drawing works but with issues (see below)

## Current state of each branch

### master (before-ts tag) — WORKING but with known issues
- Old Meteor bundle with runtime WASM patch
- Strokes draw correctly (createjs BasicBrush = smooth Bezier curves)
- Stroke recognition works (old Handwriting.js normalizes coords properly)
- **Bug**: learning cards don't come back mid-session (source fix in timing.js but runtime patch can't safely override shuffle/getNextCard)

### typescript-rewrite — PARTIALLY WORKING
- Stroke recognition now works (fixed coord normalization: divide by 1024)
- **Bug**: rough/jagged strokes (using ctx.lineTo instead of Bezier curves like old BasicBrush)
- **Bug**: completed strokes drawn from median points instead of SVG path data
- **Bug**: no smooth calligraphy feel
- Cards DO get reviewed and ankiState is stored

## Key findings

### Why getNextCard preemption crashed (master branch)
The `Tracker.autorun(updateCard)` in teach/code.js fires whenever `getNextCard()` returns a different object. Our wrapper created new objects each call. Combined with `Meteor.setInterval(Tracker.flush, 10000)`, the teach template re-initialized handwriting mid-stroke.

### Why strokes didn't match in TS rewrite
1. User stroke coords were raw 0-1024, matcher expects 0-1 (old app divides by canvas size in `_endStroke`)
2. Double y-flip: loadWordData flipped, then findCorners flipped again

### Why strokes look rough in TS rewrite
Old app uses createjs BasicBrush with quadratic Bezier midpoint interpolation. Our canvas code uses raw `ctx.lineTo` segments.

### Canvas clearing mystery (TS rewrite)
Preact re-renders caused canvas bitmap to be cleared. Root cause: `redraw()` called `ctx.clearRect()` inside `onUp` handler. Fixed by deferring redraw via setTimeout.

## What needs to happen

### On master branch (priority — user wants learning card mid-session retry)
The source-level fix in `timing.js` adds `getDueFailures()` check at top of `shuffle()`. This is correct but doesn't take effect until the Meteor bundle is rebuilt (requires Docker). The runtime patch can't safely override shuffle/getNextCard without breaking the teach template.

**Options:**
1. Docker rebuild of Meteor bundle (incorporates all source changes including timing.js)
2. Simpler runtime approach: after `completeCard` for a failed card, force `Timing.shuffle()` to re-evaluate (the source fix already checks due failures first in shuffle)

### On typescript-rewrite branch (lower priority)
1. Implement smooth Bezier stroke drawing (port BasicBrush logic)
2. Render completed strokes from SVG path data (character `strokes` field)
3. Test recognition more thoroughly

## Theories about learning card mid-session retry on master

The source-level `timing.js` change adds this to the top of `shuffle()`:
```js
if (left.failures > 0) {
  const now = Date.timestamp();
  const end = counts.ts + getSessionDuration(counts);
  const due = Vocabulary.getDueFailures(counts.ts, end, now);
  if (due.count() > 0) {
    next_card.set({data: due.next(), deck: 'failures', ts: counts.ts});
    return;
  }
}
```

But this is in the SOURCE file, not the RUNTIME bundle. The runtime `www/anki-scheduler-patch.js` only patches `Vocabulary.updateItem` — it doesn't touch the shuffle logic.

For the failed card to come back, the EXISTING (old) shuffle code path must surface it. The old shuffle shows failures LAST (after all adds/reviews). The card has `failed=true` set by our patch, and `next = ts + 60` (1 min learning step). But `getFailuresInRange()` just checks `failed === true` — it doesn't wait for the timer. So the card IS in the failures deck immediately, but only shown after all adds+reviews are exhausted.

**The fix**: the runtime patch needs to somehow make the old `shuffle()` check failures BEFORE adds/reviews. Since shuffle is module-private, the only option is the `getNextCard` preemption — which we already tried and it crashed.

Alternative: reduce the problem. If `max_adds` and `max_reviews` are small (e.g., 5 and 5), the user gets through them quickly and reaches the failures deck. The session duration being 10 minutes also helps.

The REAL fix is the Docker/Meteor rebuild. Or the TS rewrite (which has the correct shuffle order built in).
