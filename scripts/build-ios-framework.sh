#!/usr/bin/env bash
set -euo pipefail

# Build PikosFFI.xcframework from crates/pikos-ffi.
#
# MAC ONLY. Cross-compiling to Apple targets needs the Apple linker and SDKs
# that ship with Xcode, and `xcodebuild -create-xcframework` has no Linux
# equivalent. The *bindings* do not need any of this — see
# scripts/gen-swift-bindings.sh, which runs anywhere — so only this step is
# gated on the platform.
#
# Output is a build artifact and is gitignored. Run this once after cloning,
# and again whenever the Rust FFI surface changes.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/apps/ios/PikosCore"
BUILD="$ROOT/target/ios"
XCFRAMEWORK="$PKG/Frameworks/PikosFFI.xcframework"

if [ "$(uname -s)" != "Darwin" ]; then
  cat >&2 <<'MSG'
error: this script needs macOS with Xcode.

Building for Apple targets requires the Apple linker and SDKs, and
`xcodebuild -create-xcframework` exists only on macOS.

The Swift bindings themselves do NOT need a Mac — run
scripts/gen-swift-bindings.sh instead if that is what you are after.
MSG
  exit 1
fi

command -v xcodebuild >/dev/null 2>&1 || {
  echo "error: xcodebuild not found — install Xcode and run xcode-select --install" >&2
  exit 1
}

# Device plus both simulator architectures. The simulator slices are fused into
# one fat static library because an XCFramework permits only one slice per
# platform+variant pair.
TARGETS=(
  aarch64-apple-ios          # device
  aarch64-apple-ios-sim      # simulator, Apple silicon
  x86_64-apple-ios           # simulator, Intel
)

echo "▶ ensuring Rust targets are installed"
for t in "${TARGETS[@]}"; do
  rustup target add "$t" >/dev/null
done

echo "▶ building release staticlibs"
for t in "${TARGETS[@]}"; do
  (cd "$ROOT" && cargo build -p pikos-ffi --release --target "$t")
done

echo "▶ regenerating Swift bindings so they match this build"
bash "$ROOT/scripts/gen-swift-bindings.sh"

echo "▶ fusing simulator slices"
rm -rf "$BUILD"
mkdir -p "$BUILD/sim" "$BUILD/device/Headers" "$BUILD/sim/Headers"
lipo -create \
  "$ROOT/target/aarch64-apple-ios-sim/release/libpikos_ffi.a" \
  "$ROOT/target/x86_64-apple-ios/release/libpikos_ffi.a" \
  -output "$BUILD/sim/libpikos_ffi.a"

cp "$PKG/generated/include/pikos_ffiFFI.h" "$BUILD/device/Headers/"
cp "$PKG/generated/include/module.modulemap" "$BUILD/device/Headers/"
cp "$PKG/generated/include/pikos_ffiFFI.h" "$BUILD/sim/Headers/"
cp "$PKG/generated/include/module.modulemap" "$BUILD/sim/Headers/"

echo "▶ assembling the XCFramework"
rm -rf "$XCFRAMEWORK"
mkdir -p "$PKG/Frameworks"
xcodebuild -create-xcframework \
  -library "$ROOT/target/aarch64-apple-ios/release/libpikos_ffi.a" \
  -headers "$BUILD/device/Headers" \
  -library "$BUILD/sim/libpikos_ffi.a" \
  -headers "$BUILD/sim/Headers" \
  -output "$XCFRAMEWORK"

echo "✓ $XCFRAMEWORK"
