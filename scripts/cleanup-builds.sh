#!/usr/bin/env bash
# Keep this checkout's Rust build output from filling the disk.
#
# - Each Cargo build folder is held under $PIKOS_CLEANUP_MAX_GB (15 by default), its least
#   recently built units removed first, so the next build stays fast (cap-build-size.mjs).
# - Stale .app bundles in target/**/bundle/macos/ are removed: Spotlight indexes them and may
#   launch the wrong version.
# - bundle_dmg.sh's `rw.*.dmg` scratch images go too, detached first if mounted. An interrupted
#   DMG build leaves one, and each registers with Launch Services under the single
#   `app.pikos.desktop` id, so `open <path>.app` can launch a copy from a disk image. A mounted
#   one is worse: hdiutil cannot convert a busy volume, so the next build fails too.
#   reset-launch-services.sh clears registrations that already exist.
#
# Runs after every pull that merges (the `post-merge` hook) with --quiet, which prints only what
# it removed, and by hand as `pnpm cleanup`.

set -euo pipefail

MAX_GB="${PIKOS_CLEANUP_MAX_GB:-15}"
QUIET=""
[ "${1:-}" = "--quiet" ] && QUIET="--quiet"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { [ -n "$QUIET" ] || printf '[cleanup-builds] %s\n' "$*"; }

before=$(df -k "$ROOT" | awk 'NR==2 {print $4}')

# One pass per build folder, since the desktop crate is excluded from the workspace and builds
# into its own.
for path in target apps/desktop/src-tauri/target; do
  if [ ! -d "$path" ]; then
    log "skip $path (not built)"
    continue
  fi
  node scripts/cap-build-size.mjs "$path" --max-gb "$MAX_GB" $QUIET
done

# Detach first: rm cannot remove a scratch image that is still attached, which is
# how one interrupted build leads to the next one failing too.
log "detach stale build volumes backed by this checkout"
hdiutil info 2>/dev/null | awk -v root="$ROOT" '
  $1 == "image-path" { ours = index($0, root) > 0; next }
  ours && $1 ~ /^\/dev\// && $NF ~ /^\/Volumes\// { print $NF; ours = 0 }
' | while IFS= read -r volume; do
  log "detach $volume"
  hdiutil detach "$volume" -force >/dev/null 2>&1 || true
done

log "remove stale .app bundles and scratch images from target/**/bundle/macos/"
find apps/desktop/src-tauri/target -path "*/bundle/macos/*.app" -type d -prune \
  -exec rm -rf {} + 2>/dev/null || true
find apps/desktop/src-tauri/target -name "rw.*.dmg" -type f -delete 2>/dev/null || true

after=$(df -k "$ROOT" | awk 'NR==2 {print $4}')
log "done, freed ~$(( (after - before) / 1024 )) MB"

# A timestamp in .git/ lets `pnpm verify` nag when cleanup hasn't run: it is per-checkout, never
# committed, and survives `cargo clean`.
if [ -d "$ROOT/.git" ]; then
  date -u +%s > "$ROOT/.git/last-cleanup-builds"
fi
