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
ALL_TARGETS=(
  aarch64-apple-ios          # device
  aarch64-apple-ios-sim      # simulator, Apple silicon
  x86_64-apple-ios           # simulator, Intel
  aarch64-apple-darwin       # host tests, Apple silicon
  x86_64-apple-darwin        # host tests, Intel
)

# PIKOS_IOS_TARGETS builds a subset, space-separated, for a machine that knows what it needs.
# Each slice is a full release build of the Rust core, so CI's Apple-silicon runners build
# only theirs: the simulator and host slices for the tests, or the device slice to archive.
# Unset, every slice is built, so the framework works on any Mac and any simulator.
if [ -n "${PIKOS_IOS_TARGETS:-}" ]; then
  read -r -a TARGETS <<<"$PIKOS_IOS_TARGETS"
  for t in "${TARGETS[@]}"; do
    case " ${ALL_TARGETS[*]} " in
      *" $t "*) ;;
      *) echo "error: PIKOS_IOS_TARGETS names $t, which is not one of: ${ALL_TARGETS[*]}" >&2; exit 1 ;;
    esac
  done
else
  TARGETS=("${ALL_TARGETS[@]}")
fi

built() {
  case " ${TARGETS[*]} " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

# The SDK each target links against, named rather than inherited.
#
# Rust asks `xcrun` for an SDK only when SDKROOT is unset, and a machine that
# exports it — the usual reason is a Homebrew or Command Line Tools setup note —
# hands every target the macOS SDK instead. The failure is a linker error deep in
# Security.framework that says nothing about SDKROOT, so pin it here per target
# rather than trust the environment.
#
# The deployment targets are the same ones Pikos declares (project.yml's iOS 17,
# PikosCore/Package.swift's macOS 14). Rust otherwise defaults to iOS 10, which
# no current SDK supports and which buries the build in version warnings.
sdk_for() {
  case "$1" in
    aarch64-apple-ios) echo iphoneos ;;
    aarch64-apple-ios-sim | x86_64-apple-ios) echo iphonesimulator ;;
    *-apple-darwin) echo macosx ;;
  esac
}

export IPHONEOS_DEPLOYMENT_TARGET=17.0
export MACOSX_DEPLOYMENT_TARGET=14.0

echo "▶ ensuring Rust targets are installed"
for t in "${TARGETS[@]}"; do
  rustup target add "$t" >/dev/null
done

echo "▶ building release staticlibs"
for t in "${TARGETS[@]}"; do
  # --lib, so the crate's `uniffi-bindgen` binary is not cross-compiled to iOS
  # along with it. That binary runs on the host to generate Swift and is never
  # linked into the app; building it for a phone is wasted time at best, and a
  # link failure in something irrelevant at worst.
  (cd "$ROOT" && SDKROOT="$(xcrun --sdk "$(sdk_for "$t")" --show-sdk-path)" \
    cargo build -p pikos-ffi --release --target "$t" --lib)
done

echo "▶ regenerating Swift bindings so they match this build"
bash "$ROOT/scripts/gen-swift-bindings.sh"

echo "▶ fusing the multi-architecture slices"
rm -rf "$BUILD"

# One library per platform, fusing whichever of its architectures were built. A platform with
# none built is left out of the framework.
LIBRARIES=()
fuse() {
  local variant=$1
  shift
  local libs=()
  for t in "$@"; do
    built "$t" && libs+=("$ROOT/target/$t/release/libpikos_ffi.a")
  done
  [ ${#libs[@]} -gt 0 ] || return 0
  mkdir -p "$BUILD/$variant/Headers"
  lipo -create "${libs[@]}" -output "$BUILD/$variant/libpikos_ffi.a"
  cp "$PKG/generated/include/pikos_ffiFFI.h" "$BUILD/$variant/Headers/"
  cp "$PKG/generated/include/module.modulemap" "$BUILD/$variant/Headers/"
  LIBRARIES+=(-library "$BUILD/$variant/libpikos_ffi.a" -headers "$BUILD/$variant/Headers")
}
fuse device aarch64-apple-ios
fuse sim aarch64-apple-ios-sim x86_64-apple-ios
fuse macos aarch64-apple-darwin x86_64-apple-darwin

echo "▶ assembling the XCFramework"
rm -rf "$XCFRAMEWORK"
mkdir -p "$PKG/Frameworks"
xcodebuild -create-xcframework "${LIBRARIES[@]}" -output "$XCFRAMEWORK"

echo "✓ $XCFRAMEWORK"
