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

# ── What this diff can actually break ────────────────────────────────────────
# No code gate reads a committed .md, so a markdown-only diff cannot change any
# of their outcomes. Running the full set anyway costs about a minute to fix a
# typo, and a gate that expensive on trivial edits is one people learn to skip.
#
# DIFF_BASE lets pre-push and CI pass the range they are actually gating; unset
# it means the working tree, which is what a pre-commit run cares about.
changed_paths() {
  if [ -n "$DIFF_BASE" ]; then
    git diff --name-only "$DIFF_BASE" 2>/dev/null
  else
    { git diff --name-only HEAD 2>/dev/null
      git diff --name-only --cached 2>/dev/null
      git ls-files --others --exclude-standard 2>/dev/null
    }
  fi | sort -u
}

files=$(changed_paths)

# The footnote checker used to be a line in functionality-matrix.md asking a
# person to remember. Running it here is what makes it a gate.
if printf '%s\n' "$files" | grep -q '^docs/.*\.md$' && [ -f scripts/check-doc-footnotes.py ]; then
  if python3 scripts/check-doc-footnotes.py >/dev/null 2>&1; then
    pass "doc-footnotes"
  else
    fail "doc-footnotes"
    python3 scripts/check-doc-footnotes.py 2>&1 | tail -10
    overall=1
  fi
fi

if [ -n "$files" ] && ! printf '%s\n' "$files" | grep -qvE '(\.md|\.txt|LICENSE)$'; then
  pass "docs-only" "code gates skipped, nothing changed that they read"
  exit $overall
fi

# ── Auto-fix (skip in CI — clean checkout has no changed files) ───────────────
changed=()
if [ -z "$CI" ]; then
  while IFS= read -r f; do
    [[ -n "$f" && -f "$f" ]] && changed+=("$f")
  done < <(
    { git diff --name-only HEAD 2>/dev/null
      git diff --name-only --cached 2>/dev/null
      git ls-files --others --exclude-standard 2>/dev/null
    } | sort -u | grep -E '\.(ts|tsx|css)$' | grep -E '^(apps/desktop/src|packages/(core|ui)/src)/'
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
run_check "typecheck-ui"      pnpm --filter @pikos/ui typecheck &
run_check "lint"              pnpm exec turbo lint &
run_check "depcruise"         pnpm exec depcruise apps/desktop/src packages/core/src --config .dependency-cruiser.cjs &
# Every Playwright project is grep-scoped by tag, so an untagged test runs in no
# project at all — silently. Text scan, no Playwright runtime: cheap enough to
# ride along here (and so pre-commit and CI's verify job) instead of a new job.
run_check "e2e-tags"          node scripts/check-e2e-tags.mjs &
# app.css's token tiers are generated from packages/ui/src/tokens.ts. Nothing
# else compares the two, so a token edited without regenerating would ship the
# old value with every check green. Pure node + string compare, same cheap-guard
# reasoning as e2e-tags.
run_check "ui-tokens"         bash scripts/check-ui-tokens.sh &

# Only the specs the working-tree diff can reach. Safe because the workspace
# resolves `@pikos/core` to its *source* (`exports: "./src/index.ts"`), so
# vitest's module graph crosses the package boundary — a core edit still selects
# every desktop spec importing it, rather than silently testing nothing. Specs
# reached only at runtime (dynamic import, fixture read off disk) are the blind
# spot, and why the full suite still gates pre-push and CI.
affected_tests() {
  pnpm --filter @pikos/desktop exec vitest run --changed --passWithNoTests &&
    pnpm --filter @pikos/core exec vitest run --changed --passWithNoTests &&
    pnpm --filter @pikos/ui exec vitest run --changed --passWithNoTests
}

# SKIP_UNIT_TESTS=1 omits the unit run — CI sets this so the coverage job (which
# runs the same desktop+core suite, with thresholds) is the single test pass.
#
# Locally the default is affected-only: the full suite is ~37s and dominates this
# script's wall clock on every commit, where a typical edit reaches 4 of 91 specs.
# VERIFY_ALL=1 forces the full run — validate.sh sets it, a release gate being the
# one place scoping to a diff is wrong.
tests_mode=""
if [ -z "$SKIP_UNIT_TESTS" ]; then
  if [ -n "$VERIFY_ALL" ]; then
    tests_mode="(full)"
    run_check "tests"         pnpm exec turbo test &
  else
    tests_mode="(affected — VERIFY_ALL=1 for the full suite)"
    run_check "tests"         affected_tests &
  fi
fi

if [ ${#changed[@]} -gt 0 ]; then
  run_check "prettier" pnpm exec prettier --check "${changed[@]}" &
fi

wait

# ── Report results ────────────────────────────────────────────────────────────
for name in typecheck-desktop typecheck-core typecheck-ui lint prettier depcruise e2e-tags ui-tokens tests; do
  [ -f "$tmpdir/$name.status" ] || continue
  status=$(cat "$tmpdir/$name.status")
  if [ "$status" = "pass" ]; then
    if [ "$name" = "tests" ]; then pass "$name" "$tests_mode"; else pass "$name"; fi
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
