#!/usr/bin/env bash
# Check that no lazy-loaded chunk exceeds a size budget.
# Usage: bash scripts/check-bundle-size.sh [warn_kb] [fail_kb]
# Defaults: warn at 50KB, fail at 300KB.

set -euo pipefail

WARN_KB="${1:-50}"
FAIL_KB="${2:-300}"
WARN_BYTES=$((WARN_KB * 1024))
FAIL_BYTES=$((FAIL_KB * 1024))
# Resolve dist dir — works from repo root or apps/desktop
if [ -d "dist/assets" ]; then
  DIST="dist/assets"
elif [ -d "apps/desktop/dist/assets" ]; then
  DIST="apps/desktop/dist/assets"
else
  echo "No build output found — run 'pnpm build' first."
  exit 1
fi

RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'


overall=0

echo ""
echo "Bundle size check (warn ${WARN_KB}KB · fail ${FAIL_KB}KB per lazy chunk)"
echo "────────────────────────────────────────────────"

# Check JS chunks (skip the main entry — only lazy chunks matter for the budget)
# Main entry is typically the largest file or named index-*.js
main_entry=$(ls -S "$DIST"/*.js 2>/dev/null | head -1)

for file in "$DIST"/*.js; do
  [ -f "$file" ] || continue

  name=$(basename "$file")
  size=$(wc -c < "$file" | tr -d ' ')
  size_kb=$((size / 1024))

  # Skip main entry bundle — it's loaded eagerly
  if [ "$file" = "$main_entry" ]; then
    printf "${DIM}  %4dKB  %s (entry — skipped)${RESET}\n" "$size_kb" "$name"
    continue
  fi

  if [ "$size" -gt "$FAIL_BYTES" ]; then
    printf "${RED}✗ %4dKB  %s (exceeds ${FAIL_KB}KB)${RESET}\n" "$size_kb" "$name"
    overall=1
  elif [ "$size" -gt "$WARN_BYTES" ]; then
    printf "${YELLOW}⚠ %4dKB  %s (exceeds ${WARN_KB}KB)${RESET}\n" "$size_kb" "$name"
  else
    printf "${GREEN}✓${RESET} %4dKB  %s\n" "$size_kb" "$name"
  fi
done

echo ""

# Also report total bundle size for awareness
total=$(find "$DIST" -name '*.js' -exec cat {} + | wc -c | tr -d ' ')
total_kb=$((total / 1024))
css_total=$(find "$DIST" -name '*.css' -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')
css_kb=$((css_total / 1024))

printf "Total JS:  %dKB\n" "$total_kb"
printf "Total CSS: %dKB\n" "$css_kb"
echo ""

if [ $overall -eq 0 ]; then
  printf "${GREEN}All chunks within budget.${RESET}\n"
else
  printf "${RED}Some chunks exceed the ${FAIL_KB}KB budget.${RESET}\n"
  echo "Consider code-splitting or lazy-loading heavy dependencies."
fi

exit $overall
