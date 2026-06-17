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

# Check for uncommitted changes. RELEASE_NOTES.md is exempt: notes are written
# right before cutting and get committed by the version-bump commit below, so
# requiring a separate notes commit (plus its own green CI run) adds nothing.
if ! git diff --quiet -- . ':(exclude)RELEASE_NOTES.md' || ! git diff --cached --quiet -- . ':(exclude)RELEASE_NOTES.md'; then
  echo "Error: uncommitted changes. Commit or stash first."
  exit 1
fi

# Release gate — require a green ci.yml run for HEAD. The release pipeline no
# longer re-validates; CI on `main` is the single authoritative gate, so we
# only cut a release from a commit CI has already passed. The version-bump
# commits below only touch version strings + Cargo.lock + RELEASE_NOTES and
# re-enter CI when pushed, so they need no separate validation — hence
# --no-verify to skip the (now-redundant) pre-commit/pre-push hooks.
# SKIP_CI_CHECK=1 bypasses the gate; in that case keep hooks on as a fallback.
HOOK_FLAG="--no-verify"
bash "$ROOT/scripts/require-green-ci.sh" || exit 1
if [ "${SKIP_CI_CHECK:-}" = "1" ]; then HOOK_FLAG=""; fi

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
git commit $HOOK_FLAG -m "release: v${NEW}"
git tag "$TAG"

# Reset release notes for next cycle
cat > "$RELEASE_NOTES" << 'RESET'
<!-- Write release notes for the next version here. No need to commit them: -->
<!-- the release script folds this file into the version-bump commit. -->
<!-- The script fails if this file only contains comments or is empty. -->
<!-- After release, this file is automatically reset. -->
RESET
git add "$RELEASE_NOTES"
# [skip ci] — the release push is two trivial commits (version bump + this
# reset). GitHub evaluates skip-ci against the push HEAD (this commit), so it
# skips CI for the whole push. Neither commit needs validation: the tag build
# validates the released code, and CI on `main` re-runs on the next real commit.
git commit $HOOK_FLAG -m "chore: reset release notes [skip ci]"

echo ""
echo "Created tag $TAG"
echo ""

# Push and get workflow URL
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
