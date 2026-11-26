#!/usr/bin/env bash
# Build the marketing site the way its host does, so a release can't publish a site that
# won't deploy.
#
# CI builds through the workspace at the pnpm `packageManager` pins, but the host builds
# `apps/marketing` on its own with the commands below, using whatever pnpm `npx` resolves. That
# can be a newer major that refuses to install while CI stays green. The commands are copied from
# the host's settings, which live outside the repo, so change the two together.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --quiet --depth 1 "file://$ROOT" "$WORK/repo"
# The version's notes file may be written just before the cut, committed with the version bump.
cp "$ROOT"/apps/marketing/src/content/release-notes/*.md \
  "$WORK/repo/apps/marketing/src/content/release-notes/"

cd "$WORK/repo/apps/marketing"
log="$WORK/build.log"
if npm install --no-audit --no-fund >"$log" 2>&1 \
  && npx --yes pnpm@latest install >>"$log" 2>&1 \
  && npx --yes pnpm@latest run build >>"$log" 2>&1; then
  echo "[marketing] builds the host's way"
else
  echo "[marketing] the host's build fails:" >&2
  tail -25 "$log" >&2
  exit 1
fi
