#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/release-retry.sh
# Deletes the latest release tag (local + remote), then re-tags HEAD and pushes.
# Use when build/sign/publish fails in CI. If the fix is a code change, push it
# and let ci.yml go green first — this script gates on a green CI run for HEAD.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_CONF="$ROOT/apps/desktop/src-tauri/tauri.conf.json"

# Read current version from tauri.conf.json
CURRENT=$(grep -o '"version": "[^"]*"' "$TAURI_CONF" | head -1 | cut -d'"' -f4)
TAG="v${CURRENT}"

echo "Retrying release $TAG"
echo "This will delete the tag locally and on remote, then re-tag HEAD and push."
echo ""
read -rp "Continue? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[yY]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Release gate — require a green ci.yml run for HEAD before re-tagging, same as
# release.sh. Runs before the tag is deleted so a failure leaves the existing
# tag/release untouched. If you fixed the issue, push the fix and let CI pass
# first; the build/sign/publish step is the only thing CI can't cover.
# SKIP_CI_CHECK=1 bypasses the gate; in that case keep the pre-push hook on.
HOOK_FLAG="--no-verify"
bash "$ROOT/scripts/require-green-ci.sh" || exit 1
if [ "${SKIP_CI_CHECK:-}" = "1" ]; then HOOK_FLAG=""; fi

# Delete failed tag
git tag -d "$TAG" 2>/dev/null || true
git push --no-verify origin --delete "$TAG" 2>/dev/null || true

# Also delete the draft release on GitHub if gh is available
gh release delete "$TAG" --yes 2>/dev/null || true

# Re-tag current HEAD and push (single push with tag)
git tag "$TAG"
git push --atomic $HOOK_FLAG origin HEAD "$TAG"

# Wait briefly for the run to register, then grab the URL
sleep 3
RUN_URL=$(gh run list --workflow=release.yml --limit=1 --json url --jq '.[0].url' 2>/dev/null || true)
if [ -n "$RUN_URL" ]; then
  echo ""
  echo "Release workflow: $RUN_URL"
else
  REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)
  echo ""
  echo "Release workflow: https://github.com/${REPO}/actions/workflows/release.yml"
fi
