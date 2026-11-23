#!/bin/sh
# Build abundio-server for Linux (static, musl) inside Docker, so nothing
# needs installing on this computer. Development only: releases are built
# by CI (.github/workflows/build.yml).
#
#   scripts/build-server-linux.sh [x86_64|aarch64]   (default: Docker's own)
#
# Writes src-tauri/target/server-dist/linux-<arch>/abundio-server, where a
# development build of the app looks for it when installing on a Linux Host.
set -eu
cd "$(dirname "$0")/.."
arch="${1:-$(docker version --format '{{.Server.Arch}}' | sed 's/amd64/x86_64/; s/arm64/aarch64/')}"
case "$arch" in
  x86_64) platform=linux/amd64 ;;
  aarch64) platform=linux/arm64 ;;
  *) echo "unknown arch: $arch" >&2; exit 1 ;;
esac
out="src-tauri/target/server-dist/linux-$arch"
mkdir -p "$out"
# A target folder and cargo cache of its own per arch, kept between runs.
docker run --rm --platform "$platform" \
  -v "$PWD/src-tauri:/src" \
  -v "abundio-cargo-registry:/usr/local/cargo/registry" \
  -v "abundio-server-target-$arch:/target" \
  -e CARGO_TARGET_DIR=/target \
  -w /src \
  rust:1-alpine \
  sh -euc "
    apk add --no-cache musl-dev build-base perl >/dev/null
    cargo build --release --locked -p abundio-server
    cp /target/release/abundio-server /src/target/server-dist/linux-$arch/abundio-server
  "
echo "built $out/abundio-server"
