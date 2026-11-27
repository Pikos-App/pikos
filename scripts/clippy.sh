#!/usr/bin/env bash
# Clippy at zero warnings, less the lints being burned down. The Cargo lints tables turn these on
# at warn while their counts are above zero, so an editor and a plain `cargo clippy` show every
# one; the gate allows them, and denies every other warning as before. `--count` prints what is
# left of each. When a lint reaches zero, take it out of BURN_DOWN and `-D warnings` holds it.
#
#   scripts/clippy.sh --workspace --all-targets           the gate, as CI and pre-push run it
#   scripts/clippy.sh --count --workspace --all-targets   warnings left per lint
#
# Run it from the Cargo tree to check: the repo root, or apps/desktop/src-tauri.
set -uo pipefail

BURN_DOWN=(let_underscore_must_use unwrap_used expect_used cast_possible_truncation)

if [ "${1:-}" = "--count" ]; then
  shift
  # A crate checked as both lib and test reports the same line twice, so lines are counted once.
  cargo clippy "$@" --message-format=json \
    | jq -r 'select(.reason == "compiler-message") | .message
        | select((.code.code // "") | startswith("clippy::"))
        | "\(.code.code) \(.spans[0].file_name):\(.spans[0].line_start)"' \
    | sort -u | cut -d' ' -f1 | sort | uniq -c
  exit
fi

allow=()
for lint in "${BURN_DOWN[@]}"; do
  allow+=(-A "clippy::$lint")
done
exec cargo clippy "$@" -- -D warnings "${allow[@]}"
