#!/usr/bin/env bash
# Rebuilds the tunnel library shipped in ../android: the Java bindings jar and the arm64 native library.
# Needs Go, the Android SDK (ANDROID_HOME) and NDK 27 (ANDROID_NDK_HOME or $ANDROID_HOME/ndk/27.1.12297006).
set -euo pipefail
cd "$(dirname "$0")"
: "${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk/27.1.12297006}"
export PATH="$(go env GOPATH)/bin:$PATH"
mobile="$(go list -m -f '{{.Version}}' golang.org/x/mobile)"
go install "golang.org/x/mobile/cmd/gomobile@$mobile" "golang.org/x/mobile/cmd/gobind@$mobile"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
gomobile bind -target=android/arm64 -androidapi 24 -javapkg app.obnixe -trimpath -ldflags="-s -w" -o "$out/tunnel.aar" .
unzip -q "$out/tunnel.aar" -d "$out/aar"
mkdir -p ../android/libs ../android/src/main/jniLibs/arm64-v8a
cp "$out/aar/classes.jar" ../android/libs/tunnel.jar
cp "$out/aar/jni/arm64-v8a/libgojni.so" ../android/src/main/jniLibs/arm64-v8a/libgojni.so
ls -l ../android/libs/tunnel.jar ../android/src/main/jniLibs/arm64-v8a/libgojni.so
