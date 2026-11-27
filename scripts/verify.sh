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

# No code gate reads a committed .md, so a markdown-only diff skips them. DIFF_BASE is the range
# pre-push and CI are gating; unset means the working tree, which pre-commit cares about.
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

# Without this, each gate fails on "turbo: not found", which the summary below filters out, and
# reports a bare failure with no reason.
if [ ! -d node_modules ]; then
  fail "dependencies"
  echo "no dependencies, run pnpm install --frozen-lockfile --offline"
  exit 1
fi

. scripts/lib/turbo-cache.sh

# Auto-fix, skipped in CI where a clean checkout has no changed files.
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

tmpdir=$(mktemp -d)

run_check() {
  local name="$1"; shift
  if "$@" >"$tmpdir/$name.out" 2>&1; then
    echo "pass" > "$tmpdir/$name.status"
  else
    echo "fail" > "$tmpdir/$name.status"
  fi
}

# Every package that declares a typecheck, not a hand-listed few. Turbo hashes content, so
# unchanged packages cost nothing.
run_check "typecheck"         pnpm exec turbo typecheck &
run_check "lint"              pnpm exec turbo lint &
run_check "depcruise"         pnpm exec depcruise apps/desktop/src packages/core/src --config .dependency-cruiser.cjs &
# Every Playwright project is grep-scoped by tag, so an untagged test runs nowhere, silently.
run_check "e2e-tags"          node scripts/check-e2e-tags.mjs &
# app.css's token tiers are generated from packages/ui/src/tokens.ts; nothing else compares the
# two, so an unregenerated edit would ship the old value with every check green.
run_check "ui-tokens"         bash scripts/check-ui-tokens.sh &
# A shipped migration edited in place locks installs out on upgrade; the script says how.
run_check "migrations"        bash scripts/check-migrations-frozen.sh &
# A reader left on the stored body column returns the right page until saves write chunks alone.
run_check "body-reads"        bash scripts/check-body-reads.sh &
# The keyboard registry registers a duplicate combo anyway, so the winner is whichever mounted
# last. A text scan over call sites catches what a runtime check cannot, since the colliding
# owners rarely mount together.
run_check "shortcut-conflicts" node scripts/check-shortcut-conflicts.mjs &
# Pre-push tests only the crates a push reaches, and this is what keeps that selection honest
# against the real crate graph. Reads Cargo manifests only, so it costs a fraction of a second.
run_check "rust-slice"        node --test scripts/rust-affected.test.mjs &
# The repo's own lint rules: a rule that stops flagging passes every file it was meant to catch.
run_check "eslint-rules"      node --test scripts/eslint/no-silent-catch.test.mjs &
# Release cleanup removes worktrees and branches, so what it counts as merged is tested.
run_check "merged-cleanup"    node --test scripts/clean-merged-work.test.mjs &
run_check "flaky-tests"       node --test scripts/flaky-tests.test.mjs &
run_check "screen-review"     node --test scripts/check-screen-review.test.mjs &
run_check "pr-description"    node --test scripts/check-pr-body.test.mjs &
# A behaviour lands with a test claiming its QA row. The master is gitignored, so CI has none to
# read and this gate is local, which is where rows are added.
#
# Listing every Playwright test takes about 8s, so it runs only when the change touches what the
# check reads: the specs and their configs, the qa scripts and owed list, a `// qa:` claim line in
# any file, the workflows and release.sh that decide whether a claim counts, or the master. The
# master is gitignored, so no diff shows its edits; a stamp from the last pass stands in.
qa_master=.agent/qa/full-qa-checklist.md
qa_stamp=$(git rev-parse --git-path qa-rows-passed)
changed_lines() {
  if [ -n "$DIFF_BASE" ]; then
    git diff -U0 "$DIFF_BASE" 2>/dev/null
  else
    git diff -U0 HEAD 2>/dev/null
    git ls-files -z --others --exclude-standard 2>/dev/null | xargs -0 cat 2>/dev/null
  fi
}
# Not `grep -q`: it exits on the first match, the writer upstream dies of SIGPIPE, and under
# pipefail the pipeline reads as no match.
qa_rows_affected() {
  [ -z "$files" ] || [ "$qa_master" -nt "$qa_stamp" ] \
    || printf '%s\n' "$files" \
      | grep -E '^(apps/desktop/(e2e/|playwright[^/]*\.config\.ts$)|scripts/(qa-|release\.sh$)|\.github/workflows/)' >/dev/null \
    || changed_lines | grep -E '^[-+]?[[:space:]]*// qa: ' >/dev/null
}
if [ -f "$qa_master" ]; then
  if qa_rows_affected; then
    run_check "qa-rows"       node scripts/qa-marks.mjs --owed &
  else
    echo "skip" > "$tmpdir/qa-rows.status"
  fi
fi

# SKIP_UNIT_TESTS=1 omits the unit run; CI sets it so the coverage job is the single test pass.
#
# Always the full suite, never `vitest --changed`: it measured slower and burned six times the
# CPU, since vitest rebuilds the module graph on every invocation, and it can't see a spec
# reached only at runtime. Turbo hashes content, so an untouched re-run is free.
if [ -z "$SKIP_UNIT_TESTS" ]; then
  run_check "tests"           pnpm exec turbo test &
fi

if [ ${#changed[@]} -gt 0 ]; then
  run_check "prettier" pnpm exec prettier --check "${changed[@]}" &
fi

wait

for name in typecheck lint prettier depcruise e2e-tags ui-tokens migrations body-reads shortcut-conflicts rust-slice eslint-rules merged-cleanup flaky-tests screen-review pr-description qa-rows tests; do
  [ -f "$tmpdir/$name.status" ] || continue
  status=$(cat "$tmpdir/$name.status")
  if [ "$status" = "pass" ]; then
    pass "$name"
  elif [ "$status" = "skip" ]; then
    pass "$name" "skipped, nothing it reads changed"
  else
    fail "$name"
    if [ "$name" = "tests" ]; then
      filtered=$(cat "$tmpdir/$name.out" | grep -E '(FAIL|Error|✗|×|expected|received|AssertionError)' | head -20)
    else
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

if [ "$(cat "$tmpdir/qa-rows.status" 2>/dev/null)" = "pass" ]; then
  touch "$qa_stamp"
fi

echo ""
if [ $overall -eq 0 ]; then
  printf "${GREEN}All checks passed.${RESET}\n"
else
  printf "${RED}Some checks failed:${RESET}\n"
  echo "$errors"
fi

rm -rf "$tmpdir"

# Mentions `pnpm cleanup` when build artifacts haven't been swept in over 14 days. The marker is
# written by scripts/cleanup-builds.sh into .git/, so it is per-checkout and survives `cargo clean`.
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
  # Escapes go in the format string; passed through %s they print literally.
  BOLD='\033[1m'
  printf "${DIM}tip:${RESET} build artifacts can pile up (%s) — run ${BOLD}pnpm cleanup${RESET}\n" "$nag"
fi

exit $overall
