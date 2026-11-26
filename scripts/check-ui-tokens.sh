#!/usr/bin/env bash
# Fail when the token block in apps/desktop/src/app.css drifts from @pikos/ui.
#
# app.css is a committed artifact of packages/ui/src/tokens.ts. Nothing else typechecks a
# stylesheet against its source, so a token edited and never regenerated would ship the old value
# with every other check green.
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/gen-ui-tokens.mjs --check
