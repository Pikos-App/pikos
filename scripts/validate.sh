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
step "verify" "typecheck + lint + prettier + depcruise + unit tests"
pnpm verify

step "coverage" "desktop + core, per-directory thresholds"
pnpm --filter @pikos/desktop --filter @pikos/core test:coverage

step "source audit" "secrets, XSS, SQL, Tauri capabilities"
pnpm audit:source

# ── rust job ──────────────────────────────────────────────────────────────────
step "cargo fmt --check" ""
(cd "$SRC_TAURI" && cargo fmt --check)

step "cargo check" "zero warnings"
(cd "$SRC_TAURI" && RUSTFLAGS="-D warnings" cargo check)

step "cargo clippy" "zero warnings"
(cd "$SRC_TAURI" && cargo clippy --all-targets -- -D warnings)

step "cargo test" ""
(cd "$SRC_TAURI" && cargo test --all --quiet)

# ── e2e job (slowest — last) ──────────────────────────────────────────────────
step "e2e" "Playwright tier1 + tier2"
pnpm --filter @pikos/desktop exec playwright test --project=tier1 --project=tier2

printf "\n${BOLD}✓ All validation passed — safe to push the tag.${RESET}\n"
