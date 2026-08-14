#!/usr/bin/env bash
# Regenerate the TypeScript mirrors of pikos-db's wire types.
#
# The Rust structs are the source: `#[derive(ts_rs::TS)]` exports each one here,
# and `packages/core` consumes the result instead of re-declaring it. The output is
# a committed build artifact, so CI reruns this and fails on a diff — the same gate
# the recurrence wasm package carries, for the same reason.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="$PWD/packages/core/src/generated"
rm -rf "$OUT"
mkdir -p "$OUT"

TS_RS_EXPORT_DIR="$OUT" cargo test -p pikos-db export_bindings --quiet
# ts-rs emits one long line per type; the repo's prettier gate would reject that.
pnpm exec prettier --write --log-level warn "$OUT"
