#!/usr/bin/env bash
set -euo pipefail

# Generate the Swift bindings for crates/pikos-ffi.
#
# Runs anywhere Rust runs — no Xcode, no Apple toolchain. uniffi-bindgen reads
# the compiled cdylib's embedded metadata and writes Swift source, so bindings
# can be generated, diffed and reviewed on a Linux CI runner. Producing the
# XCFramework that the bindings call into is the part that needs a Mac; see
# scripts/build-ios-framework.sh.
#
# Output is committed. CI regenerates and fails on a diff (see the
# swift-bindings step in .github/workflows/_validate.yml), so a change to the
# Rust FFI surface cannot silently leave Swift behind.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Linux builds .so, macOS .dylib — pick whichever this host produced.
LIB_DIR="$ROOT/target/debug"
LIB=""
for candidate in "$LIB_DIR/libpikos_ffi.so" "$LIB_DIR/libpikos_ffi.dylib"; do
  [ -f "$candidate" ] && LIB="$candidate" && break
done

if [ -z "$LIB" ]; then
  echo "▶ building pikos-ffi first"
  (cd "$ROOT" && cargo build -p pikos-ffi)
  for candidate in "$LIB_DIR/libpikos_ffi.so" "$LIB_DIR/libpikos_ffi.dylib"; do
    [ -f "$candidate" ] && LIB="$candidate" && break
  done
fi

if [ -z "$LIB" ]; then
  echo "error: no libpikos_ffi cdylib found in $LIB_DIR" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

(cd "$ROOT" && cargo run -q -p pikos-ffi --bin uniffi-bindgen -- \
  generate --library "$LIB" --language swift --out-dir "$TMP")

PKG="$ROOT/apps/ios/PikosCore"
mkdir -p "$PKG/Sources/PikosCore" "$PKG/generated/include"

# The Swift half is a normal SwiftPM source file.
mv "$TMP/pikos_ffi.swift" "$PKG/Sources/PikosCore/PikosCore.swift"

# The C header and modulemap are *inputs to the XCFramework*, not a SwiftPM
# target: an XCFramework carries its own headers and modulemap, and having a
# second copy as a systemLibrary target would give the compiler two modules
# declaring the same symbols. They live under generated/ so it is obvious they
# are build inputs rather than something to import directly.
mv "$TMP/pikos_ffiFFI.h" "$PKG/generated/include/pikos_ffiFFI.h"
mv "$TMP/pikos_ffiFFI.modulemap" "$PKG/generated/include/module.modulemap"

echo "✓ Swift bindings written to $PKG"
