#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/release.sh <major|minor|patch> [--hotfix]
# Bumps version in all manifest files, commits, tags, and pushes.
#
# Every gate bypass is written into the release record after the tag, so skipping a gate is never
# invisible.

BUMP="${1:-}"
HOTFIX="${2:-}"
if [[ ! "$BUMP" =~ ^(major|minor|patch)$ ]] || [[ -n "$HOTFIX" && "$HOTFIX" != "--hotfix" ]]; then
  echo "Usage: scripts/release.sh <major|minor|patch> [--hotfix]"
  exit 1
fi
if [[ -n "$HOTFIX" && "$BUMP" != "patch" ]]; then
  echo "Error: only a patch can be cut as a hotfix."
  exit 1
fi
RECORD=()

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_CONF="$ROOT/apps/desktop/src-tauri/tauri.conf.json"
DESKTOP_PKG="$ROOT/apps/desktop/package.json"
CARGO_TOML="$ROOT/apps/desktop/src-tauri/Cargo.toml"

CURRENT=$(grep -o '"version": "[^"]*"' "$TAURI_CONF" | head -1 | cut -d'"' -f4)

# A prerelease left by release-beta.sh breaks the arithmetic silently: from 0.4.0-beta.1 a `minor`
# bump yields 0.5.0, skipping the release the beta was for. Refuse instead.
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

# One notes file per version, which the site, the GitHub release and the update dialog all show.
# The release workflow reads it from the tag.
NOTES_FILE="$ROOT/apps/marketing/src/content/release-notes/${NEW}.md"
notes_body() { awk 'NR==1 && /^---$/ {fm=1; next} fm && /^---$/ {fm=0; next} !fm' "$NOTES_FILE"; }
if [ ! -f "$NOTES_FILE" ] || [ -z "$(notes_body | tr -d '[:space:]')" ]; then
  echo "Error: no release notes for ${NEW}. Write them in ${NOTES_FILE#"$ROOT"/},"
  echo "with a date: line in its front matter, before releasing."
  exit 1
fi
# The notes are dated the day they ship, whatever the draft said.
TODAY=$(date +%Y-%m-%d)

# The competitor comparison is dated, and a release republishes its claims. Past three months,
# re-check it rather than republish it unread. SKIP_COMPARISON_CHECK=1 lets an urgent hotfix through.
COMPARISON="$ROOT/apps/marketing/src/content/comparison.ts"
CHECKED=$(grep -o 'COMPARISON_CHECKED = "[0-9-]*"' "$COMPARISON" | cut -d'"' -f2) || {
  echo "Error: no COMPARISON_CHECKED date found in $COMPARISON."
  exit 1
}
IFS='-' read -r CHECKED_Y CHECKED_M _ <<< "$CHECKED"
AGE_MONTHS=$(( ($(date +%Y) * 12 + 10#$(date +%m)) - (CHECKED_Y * 12 + 10#$CHECKED_M) ))
if [ "$AGE_MONTHS" -gt 3 ]; then
  if [ "${SKIP_COMPARISON_CHECK:-}" != "1" ]; then
    echo "Error: the competitor comparison was last checked $CHECKED, $AGE_MONTHS months ago."
    echo "Re-check each app against its sources in $COMPARISON and move COMPARISON_CHECKED."
    exit 1
  fi
  RECORD+=("Bypass: SKIP_COMPARISON_CHECK=1, published a comparison last checked $CHECKED.")
fi

# The release's QA copy has to be finished, or for a hotfix its hotfix block signed.
# SKIP_QA="<why>" lets a release through and records why.
if [ -n "${SKIP_QA:-}" ]; then
  RECORD+=("Bypass: SKIP_QA, the QA copy wasn't checked: ${SKIP_QA}")
else
  QA_LINE=$(node "$ROOT/scripts/check-release-qa.mjs" "$NEW" --kind "$BUMP" ${HOTFIX:+"$HOTFIX"}) || exit 1
  RECORD+=("$QA_LINE")
fi

# The agent screen review has to have read these screens: this commit, or one nothing visible has
# changed since. SKIP_SCREEN_REVIEW="<why>" lets a release through and records why.
if [ -n "${SKIP_SCREEN_REVIEW:-}" ]; then
  RECORD+=("Bypass: SKIP_SCREEN_REVIEW, the screens weren't reviewed: ${SKIP_SCREEN_REVIEW}")
else
  SCREEN_LINE=$(node "$ROOT/scripts/check-screen-review.mjs" --platform desktop) || exit 1
  RECORD+=("$SCREEN_LINE")
fi

# The app's own log from the QA pass: a warning the app emits about itself is a defect or a line
# that shouldn't be there, and both want a decision before a tag. The pass runs on Pikos Staging,
# so its log is the one that judges this build. SKIP_LOG_CHECK="<why>" records why.
if [ -n "${SKIP_LOG_CHECK:-}" ]; then
  RECORD+=("Bypass: SKIP_LOG_CHECK, the app log wasn't checked: ${SKIP_LOG_CHECK}")
elif [ -n "${SKIP_QA:-}" ]; then
  RECORD+=("The app log wasn't checked either: without the QA copy there is no pass date.")
else
  PASS_DATE=$(node "$ROOT/scripts/check-release-qa.mjs" "$NEW" ${HOTFIX:+"$HOTFIX"} --pass-date) || exit 1
  STAGING_ID=$(node -p "require('$ROOT/apps/desktop/src-tauri/tauri.conf.staging.json').identifier") || exit 1
  STAGING_LOG="$HOME/Library/Logs/$STAGING_ID/pikos.log"
  bash "$ROOT/scripts/check-log-clean.sh" --since "$PASS_DATE" "$STAGING_LOG" || exit 1
  RECORD+=("Staging log ($STAGING_ID) clean since the QA pass on $PASS_DATE.")
fi

# The marketing site, built the way its host builds it, which isn't the way CI does.
# SKIP_MARKETING_CHECK="<why>" lets a release through and records why.
if [ -n "${SKIP_MARKETING_CHECK:-}" ]; then
  RECORD+=("Bypass: SKIP_MARKETING_CHECK, the site wasn't built the host's way: ${SKIP_MARKETING_CHECK}")
else
  bash "$ROOT/scripts/check-marketing-build.sh" || exit 1
fi

# The formal benchmark /speed publishes has to pass and have measured this code.
# SKIP_SPEED="<why>" lets a release that changes no product code through and records why.
if [ -n "${SKIP_SPEED:-}" ]; then
  RECORD+=("Bypass: SKIP_SPEED, the published benchmark wasn't checked: ${SKIP_SPEED}")
else
  SPEED_LINE=$(node "$ROOT/scripts/check-speed-gate.mjs") || exit 1
  RECORD+=("$SPEED_LINE")
fi

# Tagging triggers the publish pipeline and is irreversible, so a human reviews the notes first.
echo "Bumping $CURRENT → $NEW, with the notes dated $TODAY"
echo ""
echo "Release notes. The site shows all of it; the update dialog and GitHub show what's above"
echo "<!-- more -->, with a link to the rest (PKOS-0198):"
echo "───────────────────────────────────"
notes_body
echo "───────────────────────────────────"
echo ""
read -rp "Release notes reviewed and correct? Sign off to tag ${TAG} [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[yY]$ ]]; then
  echo "Aborted — no sign-off."
  exit 0
fi

# The version's notes file is exempt from the clean-tree check: it may be written right before
# cutting, and the version-bump commit below includes it.
NOTES_REL="${NOTES_FILE#"$ROOT"/}"
if ! git diff --quiet -- . ":(exclude)$NOTES_REL" \
  || ! git diff --cached --quiet -- . ":(exclude)$NOTES_REL"; then
  echo "Error: uncommitted changes. Commit or stash first."
  exit 1
fi

# Require a green ci.yml run for HEAD: CI on `main` is the one gate, and the release pipeline
# does not re-validate. The version-bump commit touches only version strings, Cargo.lock and the
# notes file, so it skips the hooks (--no-verify). SKIP_CI_CHECK=1 bypasses the gate and keeps
# the hooks on as a fallback.
HOOK_FLAG="--no-verify"
bash "$ROOT/scripts/require-green-ci.sh" || exit 1
if [ "${SKIP_CI_CHECK:-}" = "1" ]; then
  HOOK_FLAG=""
  RECORD+=("Bypass: SKIP_CI_CHECK=1, tagged without a green CI run.")
fi

if [[ "$(uname)" == "Darwin" ]]; then
  sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" "$TAURI_CONF"
  sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" "$DESKTOP_PKG"
  sed -i '' "s/^version = \"$CURRENT\"/version = \"$NEW\"/" "$CARGO_TOML"
else
  sed -i "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" "$TAURI_CONF"
  sed -i "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" "$DESKTOP_PKG"
  sed -i "s/^version = \"$CURRENT\"/version = \"$NEW\"/" "$CARGO_TOML"
fi

# Pick up the version bump in Cargo.lock with `cargo metadata`, not `cargo generate-lockfile`,
# which re-resolves the whole graph (364 versions moved on one tree) so the release would build
# against an untested dependency set. The diff should be a single version line.
(cd "$ROOT/apps/desktop/src-tauri" && cargo metadata --format-version 1 >/dev/null 2>&1 || true)

awk -v today="$TODAY" 'NR==1 && /^---$/ {fm=1; print; next} fm && /^---$/ {fm=0} fm && /^date:/ {$0 = "date: " today} {print}' \
  "$NOTES_FILE" > "$NOTES_FILE.tmp" && mv "$NOTES_FILE.tmp" "$NOTES_FILE"

# Commit and tag, with the notes file, which the workflow reads from the tag. Main takes changes
# only through a pull request, the version bump included, so the commit goes on a branch of its
# own and reaches main through one below.
RELEASE_BRANCH="release/${TAG}"
git switch -c "$RELEASE_BRANCH"
git add "$TAURI_CONF" "$DESKTOP_PKG" "$CARGO_TOML" "$ROOT/apps/desktop/src-tauri/Cargo.lock" "$NOTES_FILE"
git commit $HOOK_FLAG -m "release: v${NEW}"
git tag "$TAG"

# The tag exists, so the release happened: write what it took into its record.
for LINE in ${RECORD[@]+"${RECORD[@]}"}; do
  node "$ROOT/scripts/check-release-qa.mjs" "$NEW" --record "$LINE" \
    || echo "Warning: couldn't write to the release record: $LINE"
done
if [ -z "${SKIP_QA:-}" ] && [ -z "${HOTFIX:-}" ]; then
  node "$ROOT/scripts/check-release-qa.mjs" "$NEW" --ledger \
    || echo "Warning: couldn't date the rows this pass drove in the QA ledger"
fi

echo ""
echo "Created tag $TAG"
echo ""

git push --atomic $HOOK_FLAG origin "$RELEASE_BRANCH" "$TAG"

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

# The tag is out and building whatever happens here. CI checks the bump like any other change
# before it merges; a red run leaves the pull request open to fix.
PR_URL=$(gh pr create --base main --head "$RELEASE_BRANCH" --title "release: ${TAG}" \
  --body "The version bump and dated release notes for ${TAG}, which is already tagged and building.")
echo ""
echo "Version bump: $PR_URL"
# A fresh pull request reports no checks for a few seconds, which --watch reads as done.
for _ in $(seq 1 24); do
  [ -n "$(gh pr checks "$PR_URL" 2>/dev/null)" ] && break
  sleep 5
done
if gh pr checks "$PR_URL" --watch --fail-fast >/dev/null 2>&1; then
  gh pr merge "$PR_URL" --merge
  git switch main
  # The pull's post-merge hook clears away merged work, this release's branch included.
  git pull --ff-only
else
  echo "CI didn't pass on the version bump. Fix it on $RELEASE_BRANCH and merge $PR_URL."
  exit 1
fi
