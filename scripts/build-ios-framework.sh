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

# Device, both simulator architectures, and macOS.
#
# The simulator slices are fused into one fat static library, as are the two
# macOS ones, because an XCFramework permits only one slice per platform+variant
# pair.
#
# macOS is here for one reason: `swift test --package-path apps/ios/PikosCore`
# builds for the host, and without a macOS slice it cannot link — so the
# boundary tests would be runnable only in a simulator, which is minutes rather
# than seconds. PikosCore/Package.swift already declares `.macOS(.v14)`; this is
# what makes that declaration true.
TARGETS=(
  aarch64-apple-ios          # device
  aarch64-apple-ios-sim      # simulator, Apple silicon
  x86_64-apple-ios           # simulator, Intel
  aarch64-apple-darwin       # host tests, Apple silicon
  x86_64-apple-darwin        # host tests, Intel
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

echo "▶ fusing the multi-architecture slices"
rm -rf "$BUILD"
mkdir -p "$BUILD/device/Headers" "$BUILD/sim/Headers" "$BUILD/macos/Headers"
lipo -create \
  "$ROOT/target/aarch64-apple-ios-sim/release/libpikos_ffi.a" \
  "$ROOT/target/x86_64-apple-ios/release/libpikos_ffi.a" \
  -output "$BUILD/sim/libpikos_ffi.a"
lipo -create \
  "$ROOT/target/aarch64-apple-darwin/release/libpikos_ffi.a" \
  "$ROOT/target/x86_64-apple-darwin/release/libpikos_ffi.a" \
  -output "$BUILD/macos/libpikos_ffi.a"

for variant in device sim macos; do
  cp "$PKG/generated/include/pikos_ffiFFI.h" "$BUILD/$variant/Headers/"
  cp "$PKG/generated/include/module.modulemap" "$BUILD/$variant/Headers/"
done

echo "▶ assembling the XCFramework"
rm -rf "$XCFRAMEWORK"
mkdir -p "$PKG/Frameworks"
xcodebuild -create-xcframework \
  -library "$ROOT/target/aarch64-apple-ios/release/libpikos_ffi.a" \
  -headers "$BUILD/device/Headers" \
  -library "$BUILD/sim/libpikos_ffi.a" \
  -headers "$BUILD/sim/Headers" \
  -library "$BUILD/macos/libpikos_ffi.a" \
  -headers "$BUILD/macos/Headers" \
  -output "$XCFRAMEWORK"

echo "✓ $XCFRAMEWORK"
