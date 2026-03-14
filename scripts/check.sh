#!/usr/bin/env bash
# Runs all quality checks in parallel. Exits non-zero if any fail.

pids=()

pnpm --filter @pikos/desktop typecheck &
pids+=($!)

pnpm --filter @pikos/core typecheck &
pids+=($!)

pnpm exec turbo lint &
pids+=($!)

pnpm exec prettier --check "apps/desktop/src/**/*.{ts,tsx,css}" "packages/core/src/**/*.ts" &
pids+=($!)

pnpm depcruise &
pids+=($!)

fails=0
for pid in "${pids[@]}"; do
  wait "$pid" || fails=$((fails + 1))
done

exit $fails
