#!/usr/bin/env bash
set -euo pipefail

# Local mirror of .github/workflows/_validate.yml (blocking steps only).
# Run before cutting a release — release.sh calls this so the tag pipeline
# doesn't have to re-run validation in CI. Also exposed as `pnpm preflight`.
#
# Ordered cheapest-/most-likely-to-fail first so it fails fast.
# Skips the two warn-only CI gates (`pnpm audit`, `cargo audit`) — they are
# continue-on-error in CI and never block a release.
#
# Escape hatch: SKIP_VALIDATE=1 (honored by release.sh) bypasses this entirely.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_TAURI="$ROOT/apps/desktop/src-tauri"

BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

step() { printf "\n${BOLD}▶ %s${RESET}${DIM} %s${RESET}\n" "$1" "$2"; }

# ── verify job ────────────────────────────────────────────────────────────────
# VERIFY_ALL forces the full unit suite: verify's default is affected-only, which
# is right for a pre-commit gate and wrong for a release gate.
step "verify" "typecheck + lint + prettier + depcruise + unit tests"
VERIFY_ALL=1 pnpm verify

step "coverage" "desktop + core, per-directory thresholds"
pnpm --filter @pikos/desktop --filter @pikos/core test:coverage

step "source audit" "secrets, XSS, SQL, Tauri capabilities"
pnpm audit:source

# ── bindings job ──────────────────────────────────────────────────────────────
# packages/core/src/generated is committed, so it drifts the moment a pikos-db
# wire struct changes without a regeneration — with every gate above still green,
# because both sides typecheck fine in isolation. First of the two cargo steps:
# it builds pikos-db natively, which warms the cache the rust steps below reuse.
step "bindings freshness" "committed core/generated matches pikos-db"
"$ROOT/scripts/gen-ts-bindings.sh" >/dev/null
if [ -n "$(git -C "$ROOT" status --porcelain packages/core/src/generated)" ]; then
  echo "packages/core/src/generated was stale — the regeneration is in your working tree. Commit it."
  exit 1
fi

# app.css is the same arrangement one tier up: its token blocks are rendered from
# packages/ui/src/tokens.ts, and a stale block is a wrong color in the shipped
# build that no typecheck can see. Cheap enough to sit next to the bindings gate.
step "token freshness" "committed app.css matches packages/ui tokens"
"$ROOT/scripts/check-ui-tokens.sh"

# ── rust job ──────────────────────────────────────────────────────────────────
step "wasm freshness" "committed recurrence pkg matches its crate"
"$ROOT/scripts/build-recurrence-wasm.sh" >/dev/null
if [ -n "$(git -C "$ROOT" status --porcelain packages/recurrence-wasm/pkg)" ]; then
  echo "packages/recurrence-wasm/pkg was stale — the rebuild is in your working tree. Commit it."
  exit 1
fi

# Two Cargo trees. The root workspace is `crates/*` and *excludes*
# apps/desktop/src-tauri, so `--all` inside src-tauri covers that crate alone —
# gating only there leaves pikos-db, -cli, -calendar-sync and -recurrence unchecked.
step "cargo fmt --check" "workspace + desktop"
(cd "$ROOT" && cargo fmt --all --check)
(cd "$SRC_TAURI" && cargo fmt --check)

step "cargo clippy (workspace)" "zero warnings"
(cd "$ROOT" && cargo clippy --workspace --all-targets -- -D warnings)

step "cargo test (workspace)" ""
(cd "$ROOT" && cargo test --workspace --quiet)

step "cargo check (desktop)" "zero warnings"
(cd "$SRC_TAURI" && RUSTFLAGS="-D warnings" cargo check)

step "cargo clippy (desktop)" "zero warnings"
(cd "$SRC_TAURI" && cargo clippy --all-targets -- -D warnings)

step "cargo test (desktop)" ""
(cd "$SRC_TAURI" && cargo test --all --quiet)

# ── e2e job (slowest — last) ──────────────────────────────────────────────────
step "e2e" "Playwright tier1 + tier2"
pnpm --filter @pikos/desktop exec playwright test --project=tier1 --project=tier2

printf "\n${BOLD}✓ All validation passed — safe to push the tag.${RESET}\n"
