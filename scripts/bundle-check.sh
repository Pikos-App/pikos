#!/usr/bin/env bash
# Bundle size check: builds the desktop app and asserts no chunk exceeds the budget.
# Slow (~30s) — runs in pre-push only when BUNDLE_CHECK=1, always runs in CI.

set -o pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

BUDGET_KB=50

# Build and capture output
build_output=$(pnpm --filter @pikos/desktop build 2>&1)
if [ $? -ne 0 ]; then
  printf "${RED}✗${RESET} Desktop build failed\n"
  echo "$build_output" | tail -20
  exit 1
fi

# Vite outputs chunk sizes like:  dist/assets/index-abc123.js   48.23 kB │ gzip: 14.12 kB
# Parse the build output for chunks exceeding budget
over_budget=()
while IFS= read -r line; do
  # Match lines with kB sizes (Vite build output format)
  if echo "$line" | grep -qE '[0-9]+\.[0-9]+ kB'; then
    # Extract the filename and size
    file=$(echo "$line" | sed -E 's/^[[:space:]]*//' | awk '{print $1}')
    size=$(echo "$line" | grep -oE '[0-9]+\.[0-9]+ kB' | head -1 | awk '{print $1}')
    size_int=${size%.*}
    if [ "$size_int" -ge "$BUDGET_KB" ]; then
      over_budget+=("$file (${size} kB)")
    fi
  fi
done <<< "$build_output"

if [ ${#over_budget[@]} -gt 0 ]; then
  printf "${RED}✗${RESET} Chunks over ${BUDGET_KB}kB budget:\n"
  for item in "${over_budget[@]}"; do
    printf "  %s\n" "$item"
  done
  exit 1
else
  printf "${GREEN}✓${RESET} All chunks under ${BUDGET_KB}kB budget\n"
  exit 0
fi
