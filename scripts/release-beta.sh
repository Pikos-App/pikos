#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/release-beta.sh <X.Y.Z-label.N>
#
# Cuts a PRERELEASE tag from the current feature branch. Separate from
# release.sh because every gate that script enforces is wrong here: there is no
# green ci.yml run to require (ci.yml only runs on main and PRs), no website
# changelog entry to match, and RELEASE_NOTES.md must survive for the real
# release rather than be consumed and reset.
#
# The hyphen in the version is load-bearing, not cosmetic. release.yml keys the
# prerelease flag off it, and GitHub then leaves the tag out of
# /releases/latest — the URL the marketing site's download buttons and the
# in-app updater both resolve. That is what keeps a beta off the default
# download path.

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.]+$ ]]; then
  echo "Usage: scripts/release-beta.sh <X.Y.Z-label.N>   (e.g. 0.4.0-beta.1)"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_CONF="$ROOT/apps/desktop/src-tauri/tauri.conf.json"
DESKTOP_PKG="$ROOT/apps/desktop/package.json"
CARGO_TOML="$ROOT/apps/desktop/src-tauri/Cargo.toml"
TAG="v${VERSION}"

BRANCH=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" = "main" ]; then
  echo "Error: betas come off a feature branch. main cuts real releases via release.sh."
  exit 1
fi

if git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Error: tag $TAG already exists. Bump the prerelease number."
  exit 1
fi

if ! git -C "$ROOT" diff --quiet || ! git -C "$ROOT" diff --cached --quiet; then
  echo "Error: uncommitted changes. Commit or stash first."
  exit 1
fi

CURRENT=$(grep -o '"version": "[^"]*"' "$TAURI_CONF" | head -1 | cut -d'"' -f4)

# No CI gate exists for this branch, so the sign-off is the gate. `pnpm
# preflight` runs the same sweep ci.yml would.
cat <<BRIEF

  Branch:   $BRANCH
  Version:  $CURRENT → $VERSION
  Tag:      $TAG  (prerelease — excluded from /releases/latest)

  This publishes a public prerelease built from this branch. Nothing here
  has been through ci.yml; run 'pnpm preflight' first if you haven't.

BRIEF
read -rp "Cut $TAG from $BRANCH? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[yY]$ ]]; then
  echo "Aborted."
  exit 0
fi

if [[ "$(uname)" == "Darwin" ]]; then
  SED=(sed -i '')
else
  SED=(sed -i)
fi
"${SED[@]}" "s/\"version\": \"$CURRENT\"/\"version\": \"$VERSION\"/" "$TAURI_CONF"
"${SED[@]}" "s/\"version\": \"$CURRENT\"/\"version\": \"$VERSION\"/" "$DESKTOP_PKG"
"${SED[@]}" "s/^version = \"$CURRENT\"/version = \"$VERSION\"/" "$CARGO_TOML"

(cd "$ROOT/apps/desktop/src-tauri" && cargo generate-lockfile 2>/dev/null || true)

git -C "$ROOT" add "$TAURI_CONF" "$DESKTOP_PKG" "$CARGO_TOML" \
  "$ROOT/apps/desktop/src-tauri/Cargo.lock"
git -C "$ROOT" commit --no-verify -m "release: v${VERSION}"
git -C "$ROOT" tag "$TAG"
git -C "$ROOT" push --atomic --no-verify origin HEAD "$TAG"

echo ""
echo "Tagged $TAG. The release is created as a DRAFT — publish it from the"
echo "releases page once the build is green, keeping the prerelease flag on."
RUN_URL=$(gh run list --workflow=release.yml --limit=1 --json url --jq '.[0].url' 2>/dev/null || true)
[ -n "$RUN_URL" ] && echo "Build: $RUN_URL"
