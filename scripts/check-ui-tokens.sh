#!/usr/bin/env bash
# Fail when the token block in apps/desktop/src/app.css drifts from @pikos/ui.
#
# app.css is a committed build artifact from packages/ui/src/tokens.ts, the same
# arrangement packages/core/src/generated and packages/recurrence-wasm/pkg carry.
# Without this gate a token edited in TypeScript and never regenerated leaves the
# app rendering the old value with every other check green — nothing typechecks
# a stylesheet against the data it came from.
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/gen-ui-tokens.mjs --check
