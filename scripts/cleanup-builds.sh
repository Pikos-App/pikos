#!/usr/bin/env bash
# Periodic cleanup of stale Rust build artifacts in this checkout.
#
# - cargo-sweep drops cached build outputs untouched for $DAYS days, so the next build stays fast.
# - Stale .app bundles in target/**/bundle/macos/ are removed: Spotlight indexes them and may
#   launch the wrong version.
# - bundle_dmg.sh's `rw.*.dmg` scratch images go too, detached first if mounted. An interrupted
#   DMG build leaves one, and each registers with Launch Services under the single
#   `app.pikos.desktop` id, so `open <path>.app` can launch a copy from a disk image. A mounted
#   one is worse: hdiutil cannot convert a busy volume, so the next build fails too.
#   reset-launch-services.sh clears registrations that already exist.
#
# Run by hand from the repo root, or by a launchd agent every 14 days.

set -euo pipefail

DAYS="${PIKOS_CLEANUP_DAYS:-14}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf '[cleanup-builds] %s\n' "$*"; }

if ! command -v cargo-sweep >/dev/null 2>&1; then
  log "cargo-sweep not installed — run: cargo install cargo-sweep --locked"
  exit 1
fi

before=$(df -k "$ROOT" | awk 'NR==2 {print $4}')

# cargo-sweep runs per path so the desktop crate, excluded from the workspace, gets its own pass.
for path in . apps/desktop/src-tauri; do
  if [ ! -d "$path/target" ]; then
    log "skip $path (no target dir)"
    continue
  fi
  log "sweep $path target (>${DAYS}d)"
  cargo sweep --time "$DAYS" "$path" 2>&1 | sed 's/^/  /' || true
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
freed_mb=$(( (after - before) / 1024 ))
log "done — freed ~${freed_mb} MB"

# A timestamp in .git/ lets `pnpm verify` nag when cleanup hasn't run: it is per-checkout, never
# committed, and survives `cargo clean`.
if [ -d "$ROOT/.git" ]; then
  date -u +%s > "$ROOT/.git/last-cleanup-builds"
fi
