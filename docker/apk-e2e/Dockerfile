# Android emulator + APK E2E test image.
# Run with: --device /dev/kvm --cap-add NET_ADMIN
FROM node:22-bookworm

ENV ANDROID_SDK_ROOT=/opt/android-sdk \
    ANDROID_HOME=/opt/android-sdk \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/emulator:$PATH \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      unzip wget curl ca-certificates procps \
      libc6 libstdc++6 libnss3 libgl1 libpulse0 \
      qemu-utils socat && \
    rm -rf /var/lib/apt/lists/*

# Capacitor 8.x's Android gradle config requires JDK 21. Debian 12
# (bookworm) only ships 17, so pull Eclipse Temurin from Adoptium.
ARG JDK_TARBALL=https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.5%2B11/OpenJDK21U-jdk_x64_linux_hotspot_21.0.5_11.tar.gz
RUN mkdir -p /opt/jdk && \
    wget -q "$JDK_TARBALL" -O /tmp/jdk.tgz && \
    tar -xzf /tmp/jdk.tgz -C /opt/jdk --strip-components=1 && \
    rm /tmp/jdk.tgz && \
    /opt/jdk/bin/java -version
ENV JAVA_HOME=/opt/jdk
ENV PATH=/opt/jdk/bin:$PATH

ARG CMDLINE_TOOLS_VERSION=13114758
ARG SYSTEM_IMAGE=system-images;android-34;default;x86_64
ARG PLATFORM=platforms;android-34
ARG BUILD_TOOLS=build-tools;34.0.0

# Android cmdline-tools, platform-tools, emulator, system image,
# plus platform + build-tools so the same image can also build the APK.
RUN mkdir -p $ANDROID_SDK_ROOT/cmdline-tools && cd $ANDROID_SDK_ROOT/cmdline-tools && \
    wget -q https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip -O cmdtools.zip && \
    unzip -q cmdtools.zip && rm cmdtools.zip && \
    mv cmdline-tools latest && \
    yes 2>/dev/null | $ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null 2>&1 && \
    $ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager \
      "platform-tools" "emulator" "${SYSTEM_IMAGE}" "${PLATFORM}" "${BUILD_TOOLS}" >/dev/null && \
    echo no | $ANDROID_SDK_ROOT/cmdline-tools/latest/bin/avdmanager create avd \
      -n testavd -k "${SYSTEM_IMAGE}" --device pixel && \
    rm -rf $ANDROID_SDK_ROOT/system-images/*/*/x86_64/*.zip

WORKDIR /app

# Bake node_modules into the image at /srv/baked so CI jobs can skip the
# minute-long `npm ci` step. The CI before_script symlinks
# /srv/baked/node_modules -> ./node_modules. If package-lock.json drifts
# between this image's bake and the branch under test, rebuild the image
# (image tag is the contract). Build context must be the repo root, e.g.
# `docker build -f docker/apk-e2e/Dockerfile -t inkstone-apk-e2e:dev-cached .`
COPY package.json package-lock.json /srv/baked/
RUN cd /srv/baked && npm ci --ignore-scripts && npm cache clean --force

COPY docker/apk-e2e/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
