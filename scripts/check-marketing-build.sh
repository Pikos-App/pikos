#!/usr/bin/env bash
# Build the marketing site the way its host does, so a release can't publish a site that
# won't deploy.
#
# CI builds it through the workspace, at the pnpm `packageManager` pins. The host checks out
# the repo and builds `apps/marketing` on its own with the commands below, which take
# whatever pnpm `npx` resolves: on the day 0.4.0 shipped that was a newer major that refused
# to install while CI stayed green. The commands are copied from the host's settings, which
# live outside the repo, so change the two together. Once the host builds through the
# workspace, this check goes.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --quiet --depth 1 "file://$ROOT" "$WORK/repo"
# The changelog entry is written just before the cut and committed with the version bump.
cp "$ROOT/apps/marketing/src/pages/release-notes.astro" \
  "$WORK/repo/apps/marketing/src/pages/release-notes.astro"

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
