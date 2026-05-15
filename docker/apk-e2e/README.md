# APK E2E test runner

End-to-end test of the inkstone Android APK: yi1 (一) drawn perfectly,
shi2 (十) drawn perfectly, shi2 with three wrong strokes triggering a lapse.
Assertions read the post-test vocabulary state from `localStorage` to
verify the Anki scheduler reacted correctly to each scenario.

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
  image: 192.168.56.1:5000/inkstone-apk-e2e:dev
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
