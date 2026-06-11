#!/usr/bin/env bash
set -euo pipefail

# Exit 0 only if the latest ci.yml run for the given commit (default HEAD)
# completed successfully. Prints a diagnostic and exits non-zero otherwise.
# This is the release gate: ci.yml on `main` is the single authoritative
# validation, so we only cut a release from a commit CI has already passed.
#
# SKIP_CI_CHECK=1 short-circuits to success (CI infra down, verified by hand).

SHA="${1:-$(git rev-parse HEAD)}"

if [ "${SKIP_CI_CHECK:-}" = "1" ]; then
  echo "SKIP_CI_CHECK=1 — not checking CI status."
  exit 0
fi

echo "Checking CI status for ${SHA:0:8}…"
set +e
# Pipe delimiter, not tab: tab is whitespace, so `read` would collapse the
# empty conclusion field of an in-progress run and drop the URL. Run statuses
# are enums and the run URL never contains a pipe, so '|' splits cleanly.
INFO=$(gh run list -w ci.yml -c "$SHA" -L 1 --json status,conclusion,url \
  --jq '.[0] // empty | "\(.status)|\(.conclusion)|\(.url)"' 2>/dev/null)
rc=$?
set -e

if [ "$rc" -ne 0 ]; then
  echo "Error: couldn't query CI status (gh exited $rc)."
  echo "Check 'gh auth status' and your network, or set SKIP_CI_CHECK=1 to bypass."
  exit 1
fi

if [ -z "$INFO" ]; then
  echo "Error: no ci.yml run found for ${SHA:0:8}."
  echo "Push this commit and let CI finish before releasing."
  exit 1
fi

IFS='|' read -r STATUS CONCLUSION URL <<< "$INFO"

if [ "$STATUS" != "completed" ]; then
  echo "CI is still running (status: $STATUS). Wait for it to go green:"
  echo "  $URL"
  exit 1
fi

if [ "$CONCLUSION" != "success" ]; then
  echo "CI did not pass (conclusion: $CONCLUSION):"
  echo "  $URL"
  exit 1
fi

echo "✓ CI green for ${SHA:0:8}"
