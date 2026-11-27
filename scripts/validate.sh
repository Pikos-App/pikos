#!/usr/bin/env bash
set -euo pipefail

# Local mirror of .github/workflows/_validate.yml (blocking steps only), also `pnpm preflight`.
# Run before cutting a release; release.sh calls it so the tag pipeline doesn't re-validate.
# Cheapest and likeliest to fail first.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_TAURI="$ROOT/apps/desktop/src-tauri"

BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

step() { printf "\n${BOLD}▶ %s${RESET}${DIM} %s${RESET}\n" "$1" "$2"; }

step "verify" "typecheck + lint + prettier + depcruise + unit tests"
pnpm verify

step "coverage" "desktop + core, per-directory thresholds"
pnpm --filter @pikos/desktop --filter @pikos/core test:coverage

step "source audit" "secrets, XSS, SQL, Tauri capabilities"
pnpm audit:source

step "js audit" "shipped dependencies against scripts/js-audit-accepted.json"
node "$ROOT/scripts/check-js-audit.mjs"

# packages/core/src/generated is committed, so it drifts when a pikos-db wire struct changes
# without a regeneration, with every gate above green since both sides typecheck alone. It builds
# pikos-db natively, warming the cache the rust steps reuse.
step "bindings freshness" "committed core/generated matches pikos-db"
"$ROOT/scripts/gen-ts-bindings.sh" >/dev/null
if [ -n "$(git -C "$ROOT" status --porcelain packages/core/src/generated)" ]; then
  echo "packages/core/src/generated was stale — the regeneration is in your working tree. Commit it."
  exit 1
fi

# app.css's token blocks are rendered from packages/ui/src/tokens.ts, and a stale block is a wrong
# color in the shipped build that no typecheck can see.
step "token freshness" "committed app.css matches packages/ui tokens"
"$ROOT/scripts/check-ui-tokens.sh"

step "wasm freshness" "committed recurrence pkg matches its crate"
"$ROOT/scripts/build-recurrence-wasm.sh" >/dev/null
if [ -n "$(git -C "$ROOT" status --porcelain packages/recurrence-wasm/pkg)" ]; then
  echo "packages/recurrence-wasm/pkg was stale — the rebuild is in your working tree. Commit it."
  exit 1
fi

# The root workspace is `crates/*` and excludes apps/desktop/src-tauri, so `--all` inside
# src-tauri covers that crate alone and would leave the others unchecked.
step "cargo fmt --check" "workspace + desktop"
(cd "$ROOT" && cargo fmt --all --check)
(cd "$SRC_TAURI" && cargo fmt --check)

step "cargo clippy (workspace)" "zero warnings"
(cd "$ROOT" && bash scripts/clippy.sh --workspace --all-targets)

step "cargo test (workspace)" "parser bridge rebuilt first"
(cd "$ROOT" && pnpm --filter @pikos/bridge build >/dev/null)
(cd "$ROOT" && cargo test --workspace --quiet)

step "cargo check (desktop)" "zero warnings"
(cd "$SRC_TAURI" && RUSTFLAGS="-D warnings" cargo check)

step "cargo clippy (desktop)" "zero warnings"
(cd "$SRC_TAURI" && bash "$ROOT/scripts/clippy.sh" --all-targets)

step "cargo test (desktop)" ""
(cd "$SRC_TAURI" && cargo test --all --quiet)

# Skipped rather than failed when cargo-audit is absent: a missing tool is not a finding, and this
# is also the pre-release gate on machines that may never have installed it.
if command -v cargo-audit &>/dev/null; then
  step "cargo audit" "workspace + desktop, each against its own .cargo/audit.toml"
  (cd "$ROOT" && cargo audit)
  (cd "$SRC_TAURI" && cargo audit)
else
  step "cargo audit" "skipped — cargo-audit not installed"
fi

step "e2e" "Playwright, as CI splits it: the real writer, then the mock-only tests"
pnpm --filter @pikos/desktop test:e2e:bridge
pnpm --filter @pikos/desktop exec playwright test --project=e2e --grep @mock-only

printf "\n${BOLD}✓ All validation passed — safe to push the tag.${RESET}\n"
