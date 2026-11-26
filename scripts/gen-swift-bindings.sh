#!/usr/bin/env bash
set -euo pipefail

# Generate the Swift bindings for crates/pikos-ffi. Runs anywhere Rust runs: uniffi-bindgen reads
# the cdylib's embedded metadata. The XCFramework the bindings call into needs a Mac, see
# build-ios-framework.sh.
#
# Output is committed, and CI regenerates it and fails on a diff, so a Rust FFI change cannot
# leave Swift behind.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Always build: `cargo test` never produces a cdylib, so a library left from an earlier build
# describes an earlier FFI and yields stale bindings that look freshly written.
echo "▶ building pikos-ffi"
(cd "$ROOT" && cargo build -p pikos-ffi --lib)

LIB_DIR="$ROOT/target/debug"
LIB=""
for candidate in "$LIB_DIR/libpikos_ffi.so" "$LIB_DIR/libpikos_ffi.dylib"; do
  [ -f "$candidate" ] && LIB="$candidate" && break
done

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

mv "$TMP/pikos_ffi.swift" "$PKG/Sources/PikosCore/PikosCore.swift"

# The header and modulemap are XCFramework inputs, not a SwiftPM target: the XCFramework carries
# its own, and a second copy as a systemLibrary would give two modules declaring the same symbols.
mv "$TMP/pikos_ffiFFI.h" "$PKG/generated/include/pikos_ffiFFI.h"
mv "$TMP/pikos_ffiFFI.modulemap" "$PKG/generated/include/module.modulemap"

echo "✓ Swift bindings written to $PKG"
