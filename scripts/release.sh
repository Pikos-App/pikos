#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/release.sh <major|minor|patch>
# Bumps version in all manifest files, commits, tags, and pushes.

BUMP="${1:-}"
if [[ ! "$BUMP" =~ ^(major|minor|patch)$ ]]; then
  echo "Usage: scripts/release.sh <major|minor|patch>"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_CONF="$ROOT/apps/desktop/src-tauri/tauri.conf.json"
DESKTOP_PKG="$ROOT/apps/desktop/package.json"
CARGO_TOML="$ROOT/apps/desktop/src-tauri/Cargo.toml"
RELEASE_NOTES="$ROOT/RELEASE_NOTES.md"

# Validate release notes — strip HTML comments and whitespace, must have content
NOTES_CONTENT=$(sed 's/<!--.*-->//g' "$RELEASE_NOTES" | tr -d '[:space:]')
if [ -z "$NOTES_CONTENT" ]; then
  echo "Error: RELEASE_NOTES.md is empty or only has comments."
  echo "Write release notes before running a release."
  exit 1
fi

echo "Release notes:"
echo "───────────────────────────────────"
grep -v '^<!--' "$RELEASE_NOTES" | grep -v '^$' | head -20
echo "───────────────────────────────────"
echo ""

# Read current version from tauri.conf.json
CURRENT=$(grep -o '"version": "[^"]*"' "$TAURI_CONF" | head -1 | cut -d'"' -f4)
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac

NEW="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${NEW}"

echo "Bumping $CURRENT → $NEW"
echo ""
read -rp "Continue? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[yY]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Check for uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: uncommitted changes. Commit or stash first."
  exit 1
fi

# Update version in all files
if [[ "$(uname)" == "Darwin" ]]; then
  sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" "$TAURI_CONF"
  sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" "$DESKTOP_PKG"
  sed -i '' "s/^version = \"$CURRENT\"/version = \"$NEW\"/" "$CARGO_TOML"
else
  sed -i "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" "$TAURI_CONF"
  sed -i "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" "$DESKTOP_PKG"
  sed -i "s/^version = \"$CURRENT\"/version = \"$NEW\"/" "$CARGO_TOML"
fi

# Update Cargo.lock
(cd "$ROOT/apps/desktop/src-tauri" && cargo generate-lockfile 2>/dev/null || true)

# Commit and tag (include release notes so the workflow can read them)
git add "$TAURI_CONF" "$DESKTOP_PKG" "$CARGO_TOML" "$ROOT/apps/desktop/src-tauri/Cargo.lock" "$RELEASE_NOTES"
git commit -m "release: v${NEW}"
git tag "$TAG"

# Reset release notes for next cycle
cat > "$RELEASE_NOTES" << 'RESET'
<!-- Write release notes for the next version here. -->
<!-- The release script will fail if this file only contains comments or is empty. -->
<!-- After release, this file is automatically reset. -->
RESET
git add "$RELEASE_NOTES"
git commit -m "chore: reset release notes"

echo ""
echo "Created tag $TAG"
echo ""

# Push and get workflow URL
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
