#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/release-retry.sh
# Deletes the latest release tag (local + remote), then re-tags and pushes.
# Use when a release build fails in CI after fixing the issue locally.

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

# Delete failed tag
git tag -d "$TAG" 2>/dev/null || true
git push --no-verify origin --delete "$TAG" 2>/dev/null || true

# Also delete the draft release on GitHub if gh is available
gh release delete "$TAG" --yes 2>/dev/null || true

# Re-tag current HEAD and push (single push with tag)
git tag "$TAG"
git push --atomic origin HEAD "$TAG"

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
