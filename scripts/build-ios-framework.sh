#!/usr/bin/env bash
set -euo pipefail

# Build PikosFFI.xcframework from crates/pikos-ffi. Mac only: it needs Xcode's linker, SDKs
# and `xcodebuild -create-xcframework`. The Swift bindings do not, see gen-swift-bindings.sh.
#
# Output is gitignored. Run after cloning and whenever the Rust FFI surface changes.

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

# One slice per platform+variant is all an XCFramework permits, so the simulator and macOS
# architectures are fused into one library each. The macOS slice exists so `swift test` for
# PikosCore, which builds for the host, can link without a simulator.
ALL_TARGETS=(
  aarch64-apple-ios          # device
  aarch64-apple-ios-sim      # simulator, Apple silicon
  x86_64-apple-ios           # simulator, Intel
  aarch64-apple-darwin       # host tests, Apple silicon
  x86_64-apple-darwin        # host tests, Intel
)

# PIKOS_IOS_TARGETS (space-separated) builds a subset. Each slice is a full release build of the
# Rust core, so CI builds only the slices it needs. Unset builds every slice.
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

# Rust asks `xcrun` for an SDK only when SDKROOT is unset, so a machine that exports it hands
# every target the macOS SDK and fails with a linker error that never mentions SDKROOT. Pin it
# per target. The deployment targets match project.yml and PikosCore/Package.swift; Rust
# otherwise defaults to iOS 10, which no current SDK supports.
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
  # --lib keeps the host-only `uniffi-bindgen` binary from being cross-compiled to iOS.
  (cd "$ROOT" && SDKROOT="$(xcrun --sdk "$(sdk_for "$t")" --show-sdk-path)" \
    cargo build -p pikos-ffi --release --target "$t" --lib)
done

echo "▶ regenerating Swift bindings so they match this build"
bash "$ROOT/scripts/gen-swift-bindings.sh"

echo "▶ fusing the multi-architecture slices"
rm -rf "$BUILD"

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
