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
MARKETING_NOTES="$ROOT/apps/marketing/src/pages/release-notes.astro"

# Validate release notes — strip HTML comments and whitespace, must have content
NOTES_CONTENT=$(sed 's/<!--.*-->//g' "$RELEASE_NOTES" | tr -d '[:space:]')
if [ -z "$NOTES_CONTENT" ]; then
  echo "Error: RELEASE_NOTES.md is empty or only has comments."
  echo "Write release notes before running a release."
  exit 1
fi

# Read current version from tauri.conf.json
CURRENT=$(grep -o '"version": "[^"]*"' "$TAURI_CONF" | head -1 | cut -d'"' -f4)

# A prerelease left in the manifests by scripts/release-beta.sh breaks the
# arithmetic below, and the dangerous half is silent: from 0.4.0-beta.1 a `minor`
# bump yields 0.5.0, skipping the very release the beta was for. (`patch` is
# harmless by comparison — it dies on a bad math expression.) Refuse instead.
if [[ "$CURRENT" == *-* ]]; then
  echo "Error: $TAURI_CONF is at $CURRENT, which is a prerelease."
  echo "Reset tauri.conf.json, apps/desktop/package.json and src-tauri/Cargo.toml"
  echo "to the last stable version, then cut the release."
  exit 1
fi

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac

NEW="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${NEW}"

# The website changelog must already carry an entry for this version. It's
# hand-authored (styled HTML, user-facing voice — not auto-generated from the
# terse RELEASE_NOTES.md) and ships in the same commit as the version bump so
# the site updates the moment the release is cut.
if ! grep -q ">${NEW}<" "$MARKETING_NOTES"; then
  echo "Error: $MARKETING_NOTES has no entry for ${NEW}."
  echo "Add the release-notes <article> (version + release date + notes) before releasing."
  exit 1
fi

# ── Release-notes sign-off ───────────────────────────────────────────────────
# Tagging triggers the publish pipeline and is irreversible, so require an
# explicit human review of BOTH notes surfaces before proceeding.
echo "Bumping $CURRENT → $NEW"
echo ""
echo "In-app + GitHub notes (RELEASE_NOTES.md):"
echo "───────────────────────────────────"
grep -v '^<!--' "$RELEASE_NOTES" | grep -v '^$'
echo "───────────────────────────────────"
echo ""
echo "Website changelog (release-notes.astro entry for ${NEW}):"
echo "───────────────────────────────────"
grep -A 12 ">${NEW}<" "$MARKETING_NOTES" || true
echo "───────────────────────────────────"
echo ""
read -rp "Release notes reviewed and correct on both surfaces? Sign off to tag ${TAG} [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[yY]$ ]]; then
  echo "Aborted — no sign-off."
  exit 0
fi

# Check for uncommitted changes. Three paths are exempt. RELEASE_NOTES.md and
# the marketing release-notes page are written right before cutting and get
# committed by the version-bump commit below, so requiring a separate commit
# (plus its own green CI run) adds nothing. `.husky/pre-commit` is exempt for the
# opposite reason: a working-hours guard is composed into it by machine tooling
# and deliberately never committed, so it is modified permanently and would
# otherwise block every release on this machine forever.
if ! git diff --quiet -- . ':(exclude)RELEASE_NOTES.md' ':(exclude)apps/marketing/src/pages/release-notes.astro' ':(exclude).husky/pre-commit' \
  || ! git diff --cached --quiet -- . ':(exclude)RELEASE_NOTES.md' ':(exclude)apps/marketing/src/pages/release-notes.astro' ':(exclude).husky/pre-commit'; then
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

# Pick up the version bump in Cargo.lock. Deliberately NOT `cargo
# generate-lockfile`, which re-resolves the entire graph rather than editing the
# one line that changed: measured on the 0.4.0 tree it moved 364 dependency
# versions and pulled in crates that were not there before, so the release would
# have built against a dependency set nothing had tested. Reading the metadata
# updates the lockfile minimally instead. The diff it produces should be a single
# version line; anything more means something else moved and wants looking at.
(cd "$ROOT/apps/desktop/src-tauri" && cargo metadata --format-version 1 >/dev/null 2>&1 || true)

# Commit and tag (include release notes so the workflow can read them, and the
# website changelog so the marketing site ships the entry with the release).
git add "$TAURI_CONF" "$DESKTOP_PKG" "$CARGO_TOML" "$ROOT/apps/desktop/src-tauri/Cargo.lock" "$RELEASE_NOTES" "$MARKETING_NOTES"
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
