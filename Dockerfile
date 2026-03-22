# Stage 1: Meteor web build (needs old Node + Meteor 1.4.1.3)
FROM thyrlian/android-sdk:6.1 AS meteor-build

ENV DEBIAN_FRONTEND=noninteractive
ENV CORDOVA_ANDROID_GRADLE_DISTRIBUTION_URL=https://services.gradle.org/distributions/gradle-2.2.1-all.zip
ENV NODE_TLS_REJECT_UNAUTHORIZED=0

RUN apt-get update && apt-get install nodejs curl ca-certificates -y && apt-get clean && update-ca-certificates
RUN curl https://install.meteor.com/ | sh

# Minimal SDK for Meteor's Cordova build to succeed
RUN /opt/android-sdk/cmdline-tools/tools/bin/sdkmanager \
    "build-tools;28.0.3" "extras;android;m2repository" "extras;google;m2repository" \
    "platform-tools" "platforms;android-23" "platforms;android-28" >/dev/null

# Workaround: old Android tools needed for Meteor 1.4 Cordova build
RUN cd /opt/android-sdk && rm -rf tools && \
    curl -O https://dl.google.com/android/repository/tools_r25.2.3-linux.zip && \
    unzip -qq tools_r25.2.3-linux.zip && rm tools_r25.2.3-linux.zip && \
    chown 1000:1000 tools -R

USER 1000
RUN mkdir /tmp/project
ADD --chown=1000:1000 client /tmp/project/client
ADD --chown=1000:1000 cordova-build-override /tmp/project/cordova-build-override
ADD --chown=1000:1000 lib /tmp/project/lib
ADD --chown=1000:1000 mobile-config.js /tmp/project/mobile-config.js
ADD --chown=1000:1000 public /tmp/project/public
ADD --chown=1000:1000 scripts /tmp/project/scripts
ADD --chown=1000:1000 server /tmp/project/server
ADD --chown=1000:1000 .meteor /tmp/project/.meteor
WORKDIR /tmp/project
ENV HOME=/tmp
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=$PATH:/opt/android-sdk/tools/

# Meteor build: compiles Blaze templates, bundles JS/CSS, runs Cordova build
RUN meteor build .build --server localhost:3785 --allow-superuser
RUN cp -R cordova-build-override/* .build/android/project/assets/.

# ---

# Stage 2: Capacitor Android build (needs Node 22 + modern Android SDK)
FROM node:22-slim AS capacitor-build

ENV DEBIAN_FRONTEND=noninteractive
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
ENV ANDROID_HOME=/opt/android-sdk

# JDK 21 from Adoptium (Temurin)
RUN apt-get update && apt-get install -y wget unzip ca-certificates && apt-get clean
RUN mkdir -p /opt/java && cd /opt/java && \
    wget -q https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.7%2B6/OpenJDK21U-jdk_x64_linux_hotspot_21.0.7_6.tar.gz -O jdk.tar.gz && \
    tar xzf jdk.tar.gz && rm jdk.tar.gz && mv jdk-* jdk-21
ENV JAVA_HOME=/opt/java/jdk-21
ENV PATH=$JAVA_HOME/bin:$PATH

# Android SDK 36
RUN mkdir -p $ANDROID_HOME && cd $ANDROID_HOME && \
    wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O tools.zip && \
    unzip -q tools.zip && mkdir -p cmdline-tools/latest && \
    mv cmdline-tools/bin cmdline-tools/lib cmdline-tools/NOTICE.txt cmdline-tools/source.properties cmdline-tools/latest/ 2>/dev/null; \
    rm tools.zip
RUN yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null 2>&1 && \
    $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager \
    "platforms;android-36" "build-tools;36.0.0" "platform-tools" >/dev/null

# Copy project
COPY . /app
WORKDIR /app

# Copy compiled web assets from Meteor stage
COPY --from=meteor-build /tmp/project/.build/android/project/assets/www/application/ /tmp/meteor-www/
RUN cp -f /tmp/meteor-www/*.js www/ 2>/dev/null; \
    cp -f /tmp/meteor-www/*.css www/ 2>/dev/null; \
    cp -f /tmp/meteor-www/index.html www/ 2>/dev/null; \
    cp -f /tmp/meteor-www/head.html www/ 2>/dev/null; \
    cp -f /tmp/meteor-www/program.json www/ 2>/dev/null; \
    sed -i 's|<script[^>]*src="/cordova.js"[^>]*></script>||g' www/index.html && \
    rm -rf /tmp/meteor-www

# Capacitor sync + Android build
RUN npm install
RUN npx cap sync android
RUN echo "sdk.dir=$ANDROID_HOME" > android/local.properties && \
    cd android && ./gradlew assembleDebug

ENTRYPOINT ["/bin/bash"]
