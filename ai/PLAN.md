# Inkstone CI / test improvements plan

Three phases, executed bottom-up. Each box is a small commit-sized task.
Pipeline target wall-time: **≤ 5 minutes** for the full APK pipeline
(`test` || `hello` || `build-apk` → 3× e2e).

A loop tick re-enters this file, picks the lowest **`[ ]`** task that's
not blocked, runs it in a foreground subagent, marks it `[x]`, commits
and pushes. Marking blocks higher tasks until they unblock.

Working branch: `ci-anki-scheduler`. Verify on `regress-pre-anki-fix`
where noted (`regress-verify`).

---

## Phase 1 — CI speedup (aggressive caching)

Baseline (pipeline #24): wall ~10 min, breakdown approx
- `test` (shared): 1m (parallel with hello, build)
- `hello-android-kvm`: 30s
- `build-apk`: 2-3m (gradle from scratch)
- `apk-e2e`: 50s (npm ci + install + drive)
- `apk-multicard-e2e`: 1m30s
- `apk-midstroke-flush-e2e`: 1m45s

Concurrency=1 on the self-hosted runner, so the three e2e jobs serialise
end-to-end ≈ 4 min on top of the build.

### Tasks

- [x] **1.1 Mount gradle + npm caches as docker runner volumes.**
  Edit `/etc/gitlab-runner/config.toml` on the runner host: add
  `volumes = ["/cache", "gradle-cache:/root/.gradle", "npm-cache:/root/.npm"]`
  and reload. Verify a second build is markedly faster (target build-apk
  ≤ 60 s on warm cache). Commit a note in `docker/apk-e2e/README.md`
  explaining the volume contract — don't commit `config.toml`, it lives
  on the runner.
  - Wall-time: build-apk **170 s** cold (pipeline #26 seeded the
    fresh volumes) → **83 s** warm (pipeline #27). ~2× speedup, but
    short of the 60 s target — gradle still does ~30 s of project
    configuration + kotlin/dex work that the volume cache doesn't
    help with. Volumes are 867 MB gradle + 39 MB npm on disk.

- [x] **1.2 Bake `node_modules` into the `inkstone-apk-e2e:dev` image.**
  Add a `COPY package.json package-lock.json /app/` then `npm ci
  --ignore-scripts` step to `docker/apk-e2e/Dockerfile`. The image grows
  ~150 MB but every job's `npm ci` collapses to ~5 s (cache hit). Bump
  the image tag (e.g. `:dev-cached`) and update `.gitlab-ci.yml` to
  match. Confirm e2e jobs lose the npm-install minute.
  - Wall-time: apk-e2e **119 s → 115 s**, apk-midstroke-flush-e2e
    **84 s → 66 s**, build-apk **83 s → 81 s** (pipeline #27 → #29).
    Smaller delta than predicted because task 1.1's `/root/.npm` volume
    already collapsed `npm ci` to ~4 s on warm cache; this swap replaces
    that with a O(1) symlink and adds a cache-loss safety net (image
    tag is the integrity contract). Image grew 4.75 GB → 4.85 GB.
    Implementation: bake into `/srv/baked/node_modules`, every e2e +
    build-apk `before_script` does `ln -sfn /srv/baked/node_modules
    node_modules`; tag bumped `:dev` → `:dev-cached`.

- [x] **1.3 Collapse the three APK e2e jobs into one.**
  New job `apk-tests` does: one APK install, one `adb forward`, one
  socat bridge, then `node scripts/test-apk-e2e.cjs && node
  scripts/test-apk-multicard.cjs && node scripts/test-apk-midstroke-flush.cjs`.
  Between scripts, reset emulator state with `adb shell pm clear "$PKG"
  || adb uninstall && adb install`. Single artifact dir. Removes ~60 s
  of duplicated setup across the three jobs.
  - [!] First attempt (b348c53a → pipeline #31) failed: after the
    in-script `reset_app` (pm clear → monkey relaunch → fixed
    `sleep 6` → `adb forward` → `sleep 1`), the second script
    (`test-apk-multicard.cjs`) immediately hit `curl devtools list
    failed` on its first `getCDP()`.
  - [!] Second attempt (db6e90f1 → pipeline #33) added 30 s polling
    for the new devtools socket: still failed. /proc/net/unix dump
    at timeout contained only `@com.android.internal.os.WebViewZygoteInit/...`
    and no `webview_devtools_remote_*`. So `pm clear` + `monkey
    LAUNCHER` doesn't reliably bring up the WebView's devtools
    socket within 30 s — possibly `monkey` isn't launching the app
    (permissions revoked + notification dialog?) or Capacitor's
    WebView init is much slower after `pm clear`. Next attempt
    options:
      a) Skip `pm clear` and use `adb uninstall && adb install -r` between
         scripts — slower but the start-up is the same path that
         worked in the original three jobs.
      b) Revert the collapse and keep the three jobs separate.
      c) Replace `monkey` with `am start -n $PKG/.MainActivity`
         (explicit launch) and lengthen the poll window to ≥ 60 s.
    Option (a) is the safest next step — try it on the next tick.
  - Third attempt (4c344937 → pipeline #34) **passed**. `reset_app`
    now uses `adb uninstall && adb install -r` between scripts.
    Wall: apk-tests **219 s** for all three sub-scripts; prior
    sum (pipeline #29) was apk-e2e 115.5 s + apk-multicard ~90 s +
    apk-midstroke 66 s ≈ **271 s**. Net saving ~50 s.

- [x] **1.4 Pre-pull `alpine:3.20` and any docker images used by the
  shared `test` job onto the runner cache.**
  Less critical (the `test` job runs on GitLab SaaS), but if we ever
  move the WASM/unit tests to the self-hosted runner, having `node:22`
  and `alpine:3.20` warm shaves ~10 s per cold spawn.
  - n/a. Audited `.gitlab-ci.yml`: only jobs tagged `android-kvm` run
    on the self-hosted runner (`hello-android-kvm`, `build-apk`,
    `apk-tests`), and all three use `inkstone-apk-e2e:dev-cached`,
    which is already local (4.85 GB). The `test` job uses `node:22`
    but has no `tags:` block, so it runs on GitLab SaaS shared
    runners — pre-pulling on our host does nothing for it. No
    `alpine:3.20` reference anywhere in CI. `node:22-bookworm` is
    also already cached on the runner (1.13 GB) as a side effect of
    the `dev-cached` image build. Marked done.

- [x] **1.5 Measure and document the new wall-time.**
  Compare pipelines pre- and post-changes. Update `docker/apk-e2e/README.md`
  with the new numbers and the caching contract. Target wall ≤ 5 min.
  - Pipeline wall = **408 s** (#36) / **413 s** (#37); target ≤ 300 s
    achieved? **N** — ~60 % faster than the 10-min baseline but still
    ~110 s above target. Per-job: test 101–103 s (parallel, shared
    runner), hello 10–11 s, build-apk 78 s, **apk-tests 219–221 s**
    (the bottleneck). Critical path is the sequential chain on the
    `android-kvm` runner (hello → build → tests) ≈ 308 s + ~30 s
    inter-stage queue. Further reduction needs Phase 2/3 test rework
    (e.g. shared APK state between sub-scripts) or a second android-kvm
    runner for parallelism. README documents the three-layer caching
    contract (gradle volume + npm volume + baked `node_modules`).

### Phase 1 exit criterion
Full apk pipeline wall-time ≤ 5 min on a warm runner, three runs in a
row to confirm not flaky.

---

## Phase 2 — Source-level instrumentation (same branch)

Goal: replace the brittle bundle-byte patch
(`t._next_card_ref = f` glued into `www/b001ea39….js`) with a real
debug hook in `client/model/timing.js` that survives a Meteor rebuild.

### Tasks

- [x] **2.1 Add the hook to `client/model/timing.js`.**
  Inside the `Timing` class:
  ```js
  // For deterministic CI regression of the getNextCard preempt-
  // reactivity bug (see scripts/test-apk-midstroke-flush.cjs). The
  // module-private next_card ReactiveVar is otherwise unreachable
  // once the bundle is compiled.
  static _next_card_for_test() { return next_card; }
  ```
  Note in a comment that the hook is read-only — exposing dep allows
  invalidation but does not let the test mutate scheduler state.
  - Source hook added next to `getNextCard`, bundle rebuild pending (2.2).

- [x] **2.2 Rebuild the Meteor bundle.**
  Stage 1 of the Dockerfile builds the bundle. Run it locally
  (`docker build --target meteor-web -t inkstone-web:dev .` or the
  equivalent) and copy the new `www/<hash>.js` over the in-tree one.
  Update `www/index.html` if Meteor renamed the file. Commit only the
  source change plus the regenerated bundle — keep the diff to those
  files only.
  - New bundle hash: `12d1922bcad5335051514e6ce9dfebadb2f3ed33.js`
    (was `b001ea39fb8fb87a70ce23be83c16753750f7fdc.js`). Hook present:
    yes (`grep -c next_card_for_test` = 1). Built on d-claude runner
    via `docker build --target meteor-build`, extracted from
    `/tmp/project/.build/android/project/assets/www/application/`.
    CSS hash also changed in build output but kept old CSS to limit
    diff to bundle + index.html as instructed.

- [x] **2.3 Drop the bundle byte-patch.**
  Revert the sed-induced `t._next_card_ref = f` in the in-tree
  bundle file. The new hook from 2.2 is reached as
  `require('/client/model/timing').Timing._next_card_for_test()`.
  - Auto-resolved by 2.2: the rebuild deleted the old
    `b001ea39…js` (where the sed patch lived) and replaced it
    with `12d1922b…js` (which carries `_next_card_for_test` from
    the source edit instead). Verified: `grep _next_card_ref=f`
    on the new bundle returns 0; `grep next_card_for_test`
    returns 1; no `b001ea39*` file exists in `www/`. No diff to
    commit.

- [x] **2.4 Switch the midstroke test to the source-level hook.**
  In `scripts/test-apk-midstroke-flush.cjs`, replace
  `Timing._next_card_ref.dep.changed()` with
  `Timing._next_card_for_test().dep.changed()`. The hook-check
  assertion still reads `!!T._next_card_for_test()`.
  - Switched to `Timing._next_card_for_test()`, verification in 2.5.

- [ ] **2.5 Verify asymmetry.**
  - On `ci-anki-scheduler` (post-fix): apk-midstroke-flush-e2e
    must PASS (the wrapper takes the preempt path without reading
    next_card).
  - On `regress-pre-anki-fix` (pre-fix): apk-midstroke-flush-e2e
    must FAIL with `十.successes=0` / `attempts=0` (the dep
    invalidation fires the autorun mid-stroke).
  - Once both confirmed, drop `allow_failure: true` from the job.
  - [!] Pipeline #44 (`ci-anki-scheduler`, sha 9b100b52) and
    #45 (`regress-pre-anki-fix`, sha 30bd8963 — Phase 2 commits
    01464b9a/1138c1b4/9b100b52 cherry-picked here this tick, ai/PLAN.md
    skipped per task instructions). Cherry-picks clean apart from
    branch-local PLAN.md conflict resolved by `git rm`.
    - **POST (#44) apk-tests**: FAILED at the apk-e2e sub-script
      (`set -e` propagates non-zero exit), so the wrapper never
      reached `--- apk-midstroke-flush ---`. The apk-e2e sub-script
      now sees Anki SM-2 Learning-state outputs (e.g.
      `A entry … "ankiState":{"Learning":{remaining_steps:1,
      scheduled_secs:600}}, "interval":600, "failed":true`)
      against legacy assertions expecting `interval ≥ 86400` /
      `failed:false` → 14 passed, 5 failed. This is exactly the
      Phase 3.2 / 3.3 re-baseline work; the rebuilt bundle from
      task 2.2 made WASM Anki actually run on the emulator, which
      blew up the legacy expectations. So POST's midstroke
      datapoint is **unobserved this tick**.
    - **PRE (#45) apk-midstroke-flush-e2e**: FAILED (68 s) with
      the expected signature — `PASS: Timing._next_card_for_test()
      hook available` then `FAIL: 一.attempts: got 0, want 1` /
      `FAIL: 一.successes: got 0, want 1` (4 passed, 3 failed).
      Note the failing card is **一** (the first slow-drawn card),
      not 十 as the PLAN bullet says — but the failure mode
      matches: the mid-stroke dep invalidation fires the autorun
      and the recorded stroke is lost. PRE's separate
      `apk-midstroke-flush-e2e` job (still allow_failure: true)
      runs independently of apk-e2e so it surfaces the regression
      signal even though apk-e2e itself also fails the Phase-3
      assertions.
    - Net: asymmetry is **half-confirmed** — PRE shows the regression,
      POST blocked by Phase 3 dependency. Cannot drop
      `allow_failure` on POST until Phase 3 is done (otherwise the
      apk-tests job already fails on apk-e2e before midstroke runs).
      Leave 2.5 `[ ]`; revisit after 3.2/3.3.

### Phase 2 exit criterion
Midstroke job is GREEN on `ci-anki-scheduler` and RED on
`regress-pre-anki-fix`, both consistently across three runs.

---

## Phase 3 — WASM async fix + assertion updates (same branch as Phase 2)

Goal: make the Anki SM-2 binary actually run on Android 13+ WebView.
Currently `new WebAssembly.Module(bytes)` is sync-blocked for buffers
>4 KB, so `patchVocabulary` silently never runs and the scheduler
falls through to the inkren legacy code. The legacy gives
~7-day intervals after one correct, which is what our current `apk-e2e`
and `apk-multicard-e2e` assertions key off.

### Tasks

- [ ] **3.1 Switch the WASM load to `WebAssembly.instantiate(bytes,
  imports)`.**
  Update `www/anki-scheduler-patch.js` `initAnkiScheduler` to await
  the async API. Also install the `getNextCard` wrapper in the
  `.catch` so failures-queue preemption keeps working even if WASM
  itself blows up.

- [ ] **3.2 Re-baseline `apk-e2e` and `apk-multicard-e2e`
  assertions.**
  Anki SM-2 with `learn_steps=[1,10]` produces:
  - first "good" on a new card: `failed=true (Learning state)`,
    `interval=60s`
  - second "good" on the same card: still Learning, `interval=600s`
  - third "good": graduates to Review, `interval ≥ 1 day`.
  Pick one path and update the tests to match. Either:
    a) assert `interval > 0 && successes === 1 && !lapse` (relaxes
       the day-bound and accepts learning state); or
    b) extend the test to drive three correct sessions on the same
       card so it graduates, and keep `interval ≥ 86400`.
  Option (a) is faster, option (b) better reflects intent.

- [ ] **3.3 Update `apk-multicard-e2e` lapse assertion.**
  `三.interval=0` was the legacy fallback; Anki re-learning steps
  give `interval=60s` on the first wrong stroke. Change to
  `interval <= 60 && failed === true`.

- [ ] **3.4 Confirm green on both branches.**
  - `ci-anki-scheduler`: every job ✓ including midstroke.
  - `regress-pre-anki-fix`: every job ✓ except midstroke which is
    explicitly red (now without `allow_failure`).

### Phase 3 exit criterion
Two consecutive green pipelines on `ci-anki-scheduler`. The midstroke
job is the sole expected failure on `regress-pre-anki-fix`, and the
job fails for the precise reason documented in its docstring.

---

## Operating notes for the loop

- Each tick re-reads this file. Lowest-numbered `[ ]` task with all
  predecessors `[x]` is the next one. If you hit something unexpected,
  add a `[!]` note inline with the diagnosis and skip to the next
  unblocked task.
- After each task: mark `[x]`, commit (small, focused), push to
  `ci-anki-scheduler`. Where the task explicitly says
  `regress-verify`, cherry-pick to `regress-pre-anki-fix` and push
  there too.
- If a task fails its acceptance test, leave it `[ ]`, add the failure
  diagnosis as a sub-bullet, and pick something orthogonal.
- Don't unbundle Phase 2 from Phase 3 once Phase 2 starts — both touch
  the production scheduler path and should ship in one mental coherent
  change.
