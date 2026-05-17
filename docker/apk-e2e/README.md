# APK E2E test runner

End-to-end test of the inkstone Android APK: yi1 (一) drawn perfectly,
shi2 (十) drawn perfectly, shi2 with three wrong strokes triggering a lapse.
Assertions read the post-test vocabulary state from `localStorage` to
verify the Anki scheduler reacted correctly to each scenario.

## Pipeline timings

Baseline (pipeline #24, before Phase 1 caching work): **~10 min wall**.

Steady-state after Phase 1 (pipelines #36 / #37, warm caches, image
already on the self-hosted runner):

| Pipeline | Wall   | `test` | `hello-android-kvm` | `build-apk` | `apk-tests` |
| -------- | -----: | -----: | ------------------: | ----------: | ----------: |
| #36      | 408 s  | 101 s  | 10 s                | 78 s        | 219 s       |
| #37      | 413 s  | 103 s  | 11 s                | 78 s        | 221 s       |

Where things run:

- `test` — shared GitLab SaaS runner (no `tags:`), runs in parallel with
  the android-kvm chain.
- `hello-android-kvm`, `build-apk`, `apk-tests` — self-hosted
  `android-kvm` runner, `concurrency = 1`, so they serialise. The
  sequential chain on that runner (hello → build → tests) is the
  pipeline's critical path: ~308 s of job time plus ~30 s of queue
  delay between stages.

Target was wall **≤ 300 s (5 min)**. **Not hit** — current steady state
is ~410 s (6m50s), about 60 % faster than the 10-min baseline but still
~110 s above target. The bottleneck is `apk-tests` (219 s); it runs
three e2e sub-scripts back to back with an `adb uninstall && adb
install -r` between each, and each emulator-side boot/install cycle is
~30 s on top of the test work itself. Further reduction needs Phase 2/3
test rework (e.g. shared APK state between scripts, or true parallelism
which requires a second android-kvm runner).

## Architecture

```
+--------------------------- host --------------------------+
|                                                           |
|   emulator-5554 ─────► /dev/kvm (KVM accel, host kernel)  |
|        ▲                                                  |
|        │  adb protocol (tcp 5037)                         |
|        │                                                  |
|   adb-server (-a -P 5037, listens on 0.0.0.0)             |
|        ▲                                                  |
|        │                                                  |
|   adb forward tcp:9222 localabstract:webview_devtools…    |
|        ▲                                                  |
|        │                                                  |
|   +================ docker bridge =================+      |
|   |                                                |      |
|   |   apk-e2e container (this image)               |      |
|   |     - node + adb client only                   |      |
|   |     - no /dev/kvm, no privileged, no host vols |      |
|   |     - ANDROID_ADB_SERVER_ADDRESS=adb-host      |      |
|   |     - CDP at http://adb-host:9222              |      |
|   |                                                |      |
|   +================================================+      |
+-----------------------------------------------------------+
```

The container has **only network access** to the host's adb daemon and
the forwarded CDP port. It cannot see `/dev/kvm`, the host filesystem,
the Docker socket, or any other emulator state. The emulator runs on
the host so it can use KVM directly — nested KVM in a container made
the emulator's qemu vCPU threads deadlock.

## Local run

Pre-reqs on the local box: Android SDK platform-tools + emulator + a
debug-signed AVD (`testavd`), a built APK, Docker.

```sh
# 1. Boot the emulator headless
emulator -avd testavd -no-window -no-audio -no-boot-anim \
  -gpu swiftshader_indirect -accel on &

# 2. Restart adb-server so it listens on all interfaces (docker bridge needs this)
adb kill-server
adb -a -P 5037 nodaemon server &

# 3. Wait for boot to finish
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 2; done

# 4. Install + launch the app, then expose the WebView devtools port
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell pm grant me.skishore.inkstone android.permission.POST_NOTIFICATIONS
adb shell monkey -p me.skishore.inkstone -c android.intent.category.LAUNCHER 1
sleep 8
WS=$(adb shell cat /proc/net/unix | awk '/webview_devtools_remote/{print $NF; exit}' | tr -d '\r')
adb forward tcp:9222 "localabstract:${WS#@}"

# 5. Run the tests
cd docker/apk-e2e
APK_PATH=$(realpath ../../android/app/build/outputs/apk/debug/app-debug.apk) \
  docker compose run --rm apk-e2e
```

Screenshots and the run log land under `${ARTIFACTS_DIR:-/tmp/apk-e2e-artifacts}/`.

## CI run

The GitLab runner is `docker+machine`-disabled and uses the plain
`docker` executor with a strict container config: no privileged, no
`/dev/kvm`, no host bind mounts. The runner host is the same box that
runs the emulator and the adb-server (so the docker bridge gives the
container direct network reach back to the host).

The job in `.gitlab-ci.yml`:

```yaml
apk-e2e:
  stage: apk-e2e
  tags: [android-kvm]
  image: 192.168.56.1:5000/inkstone-apk-e2e:dev-cached
  variables:
    ANDROID_ADB_SERVER_ADDRESS: 172.17.0.1   # docker0 gateway = host
    ANDROID_ADB_SERVER_PORT: "5037"
    CDP_HOST: 172.17.0.1
    CDP_PORT: "9222"
  before_script:
    - adb install -r android/app/build/outputs/apk/debug/app-debug.apk
    - adb shell pm grant me.skishore.inkstone android.permission.POST_NOTIFICATIONS || true
    - adb shell monkey -p me.skishore.inkstone -c android.intent.category.LAUNCHER 1
    - sleep 8
    - >
      WS=$(adb shell cat /proc/net/unix | awk '/webview_devtools_remote/{print $NF; exit}' | tr -d '\r');
      adb forward tcp:9222 "localabstract:${WS#@}"
  script:
    - node scripts/test-apk-e2e.cjs
```

The runner host owns the emulator lifecycle — it's a long-running
process on the host that survives across jobs. State is reset between
jobs by `adb install -r` (reinstall) and `adb shell pm clear` (clears
localStorage). The emulator only restarts on host reboot or manual
intervention.

## Runner caching

Three layers of cache keep the android-kvm runner from re-downloading
the world on every pipeline:

1. **Named Docker volumes** mounted into every job container. Lives in
   `/etc/gitlab-runner/config.toml` on the runner host (`d-claude-host`):
   ```
   volumes = ["/cache", "gradle-cache:/root/.gradle", "npm-cache:/root/.npm"]
   ```
   - `gradle-cache → /root/.gradle` — Gradle's user home: dependency
     cache, wrapper downloads, build cache. ~870 MB on disk. Seeded by
     the first `build-apk` after a fresh runner; warm builds reuse
     compiled dependencies and the wrapper-distributed Gradle binary.
   - `npm-cache → /root/.npm` — the npm registry tarball cache (not
     `node_modules`). ~40 MB. Mostly redundant since layer 3 below, but
     kept as a fallback in case the image-baked `node_modules` ever
     goes stale.

   `config.toml` is **not** checked in — it holds the runner token and
   is host-local. The volume names are stable Docker named volumes
   managed by the runner host.

2. **Image-baked `node_modules`** in `inkstone-apk-e2e:dev-cached`. The
   image's Dockerfile runs `npm ci --ignore-scripts` against the
   in-tree `package.json` / `package-lock.json` and stores the result
   at `/srv/baked/node_modules` (~150 MB). Every job's `before_script`
   does:
   ```sh
   ln -sfn /srv/baked/node_modules node_modules
   ```
   collapsing `npm ci` to an O(1) symlink. The image tag (`:dev-cached`)
   is the integrity contract: bump it whenever `package-lock.json`
   changes.

3. **Image itself stays on the runner.** `inkstone-apk-e2e:dev-cached`
   is ~4.85 GB; it lives in the runner's local Docker storage and is
   never garbage-collected. Job spawn time is `docker run` against an
   already-present image (~0.5 s) rather than a registry pull.

Bootstrap on a new runner:

```sh
docker volume create gradle-cache
docker volume create npm-cache
# then append the volumes to /etc/gitlab-runner/config.toml and restart
systemctl restart gitlab-runner
# pre-pull the image
docker pull 192.168.56.1:5000/inkstone-apk-e2e:dev-cached
```

Caches are shared across pipelines on the same runner. To force a
clean build, `docker volume rm gradle-cache npm-cache` on the host
(the next pipeline will re-seed them).

## Image contents

`Dockerfile` builds an image with the Android SDK platform-tools and
emulator pre-installed. For the test container we only need `adb` plus
node and the project source — the emulator binary is unused (it runs
on the host). A follow-up could split out a slim variant to bring the
image from ~4.7 GB down to ~80 MB.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Container's `adb devices` empty | adb-server bound to `127.0.0.1` only | restart with `-a -P 5037` |
| Container can't reach adb-host | bridge network filtered | check `iptables -L FORWARD` and `net.ipv4.ip_forward=1` |
| CDP `curl :9222/json` empty | WebView not yet up, or wrong PID in socket | re-discover socket from `/proc/net/unix` |
| Tests pass locally, fail in CI | host's adb daemon out of sync between jobs | `adb kill-server` + restart in `after_script` of preceding job |
| Emulator hangs at boot | KVM not available on host | check `/dev/kvm` perms and `lsmod \| grep kvm_intel` |
