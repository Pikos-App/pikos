#!/usr/bin/env bash
# Compact verify: runs check + unit tests, shows one-line-per-step summary.
# On failure, prints the relevant error output.

set -o pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

pass() { printf "${GREEN}✓${RESET} %s${DIM} %s${RESET}\n" "$1" "$2"; }
fail() { printf "${RED}✗${RESET} %s\n" "$1"; }

errors=""
overall=0

# ── Auto-fix (skip in CI — clean checkout has no changed files) ───────────────
changed=()
if [ -z "$CI" ]; then
  while IFS= read -r f; do
    [[ -n "$f" && -f "$f" ]] && changed+=("$f")
  done < <(
    { git diff --name-only HEAD 2>/dev/null
      git diff --name-only --cached 2>/dev/null
      git ls-files --others --exclude-standard 2>/dev/null
    } | sort -u | grep -E '\.(ts|tsx|css)$' | grep -E '^(apps/desktop/src|packages/core/src)/'
  )

  if [ ${#changed[@]} -gt 0 ]; then
    pnpm exec eslint --fix "${changed[@]}" >/dev/null 2>&1 || true
    pnpm exec prettier --write "${changed[@]}" >/dev/null 2>&1
  fi
fi

# ── Parallel checks ──────────────────────────────────────────────────────────
tmpdir=$(mktemp -d)

run_check() {
  local name="$1"; shift
  if "$@" >"$tmpdir/$name.out" 2>&1; then
    echo "pass" > "$tmpdir/$name.status"
  else
    echo "fail" > "$tmpdir/$name.status"
  fi
}

run_check "typecheck-desktop" pnpm --filter @pikos/desktop typecheck &
run_check "typecheck-core"    pnpm --filter @pikos/core typecheck &
run_check "lint"              pnpm exec turbo lint &
run_check "depcruise"         pnpm exec depcruise apps/desktop/src packages/core/src --config .dependency-cruiser.cjs &

# SKIP_UNIT_TESTS=1 omits the unit run — CI sets this so the coverage job (which
# runs the same desktop+core suite, with thresholds) is the single test pass.
# Locally it stays on so `pnpm verify` remains a complete pre-commit gate.
if [ -z "$SKIP_UNIT_TESTS" ]; then
  run_check "tests"           pnpm exec turbo test &
fi

if [ ${#changed[@]} -gt 0 ]; then
  run_check "prettier" pnpm exec prettier --check "${changed[@]}" &
fi

wait

# ── Report results ────────────────────────────────────────────────────────────
for name in typecheck-desktop typecheck-core lint prettier depcruise tests; do
  [ -f "$tmpdir/$name.status" ] || continue
  status=$(cat "$tmpdir/$name.status")
  if [ "$status" = "pass" ]; then
    pass "$name"
  else
    fail "$name"
    if [ "$name" = "tests" ]; then
      filtered=$(cat "$tmpdir/$name.out" | grep -E '(FAIL|Error|✗|×|expected|received|AssertionError)' | head -20)
    else
      # Strip turbo noise and prefixes, keep only meaningful error lines
      filtered=$(sed 's/^@[^:]*:[^:]*: *//' "$tmpdir/$name.out" \
        | grep -vE '(^[[:space:]]*$|cache (hit|miss)|replaying logs|Packages in scope|Running |Remote caching|Tasks:|Cached:|Time:|Failed:|ERROR.*run failed|ELIFECYCLE|ERR_PNPM|command.*exited|• turbo|^> eslint|^> echo|^No lint configured|^> @|^> pnpm|Exit status|^/Users/.*:$)' \
        | tail -10)
    fi
    if [ -n "$filtered" ]; then
      errors+="$(printf "\n── %s ──\n%s\n" "$name" "$filtered")"
    fi
    overall=1
  fi
done

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [ $overall -eq 0 ]; then
  printf "${GREEN}All checks passed.${RESET}\n"
else
  printf "${RED}Some checks failed:${RESET}\n"
  echo "$errors"
fi

rm -rf "$tmpdir"

# ── Cleanup nag ──────────────────────────────────────────────────────────────
# Mention `pnpm cleanup` when build artifacts haven't been swept in >14 days.
# Marker written by scripts/cleanup-builds.sh into .git/ (per-checkout, never
# committed, survives `cargo clean`). Silent during the 14-day window; silent
# on a fresh clone with no target/ yet (nothing to sweep). One line, easy to
# ignore — verify exit code unchanged.
sweep_marker=".git/last-cleanup-builds"
nag=""
if [ -f "$sweep_marker" ]; then
  last=$(cat "$sweep_marker" 2>/dev/null || echo 0)
  age_days=$(( ( $(date -u +%s) - last ) / 86400 ))
  if [ "$age_days" -ge 14 ]; then
    nag="last sweep was ${age_days}d ago"
  fi
elif [ -d apps/desktop/src-tauri/target ] || [ -d target ]; then
  nag="never swept"
fi
if [ -n "$nag" ]; then
  # Escape sequences must be interpolated into the format string (printf
  # interprets them at parse time); passing them via %s prints them literally.
  BOLD='\033[1m'
  printf "${DIM}tip:${RESET} build artifacts can pile up (%s) — run ${BOLD}pnpm cleanup${RESET}\n" "$nag"
fi

exit $overall
