#!/usr/bin/env bash
# Runs all quality checks. Auto-fixes ESLint and Prettier issues on changed files only.

# ── Collect changed source files ──────────────────────────────────────────────
changed=()
while IFS= read -r f; do
  [[ -n "$f" ]] && changed+=("$f")
done < <(
  { git diff --name-only HEAD 2>/dev/null
    git diff --name-only --cached 2>/dev/null
    git ls-files --others --exclude-standard 2>/dev/null
  } | sort -u | grep -E '\.(ts|tsx|css)$' | grep -E '^(apps/desktop/src|packages/core/src)/'
)

# ── Auto-fix phase (changed files only) ───────────────────────────────────────
if [ ${#changed[@]} -gt 0 ]; then
  # ESLint first (may reorder imports etc.), then Prettier (canonicalises formatting).
  pnpm exec eslint --fix "${changed[@]}" 2>/dev/null || true
  pnpm exec prettier --write "${changed[@]}" 2>/dev/null
fi

# ── Check phase (parallel) ────────────────────────────────────────────────────
pids=()

pnpm --filter @pikos/desktop typecheck &
pids+=($!)

pnpm --filter @pikos/core typecheck &
pids+=($!)

pnpm exec turbo lint &
pids+=($!)

if [ ${#changed[@]} -gt 0 ]; then
  pnpm exec prettier --check "${changed[@]}" &
  pids+=($!)
fi

pnpm depcruise &
pids+=($!)

fails=0
for pid in "${pids[@]}"; do
  wait "$pid" || fails=$((fails + 1))
done

exit $fails
