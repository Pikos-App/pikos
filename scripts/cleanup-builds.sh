#!/usr/bin/env bash
# Periodic cleanup of stale Rust build artifacts in this checkout.
#
# - cargo-sweep drops cached build outputs (incremental objects, fingerprints,
#   per-crate rlibs) that haven't been touched in $DAYS days, while leaving
#   anything fresher than that alone — so the next build is still fast.
# - Stale .app bundles in target/**/bundle/macos/ are removed because macOS
#   Spotlight indexes them and may launch the wrong version (see
#   .agent/BACKLOG_DISTRIBUTION.md "Gotchas worth remembering").
# - bundle_dmg.sh's `rw.*.dmg` scratch images go the same way, and any still
#   mounted are detached first. An interrupted DMG build leaves one behind, and
#   each earns its own Launch Services registration under the single
#   `app.pikos.desktop` id — so `open <path>.app` can launch a copy from a disk
#   image instead of the bundle named. One left mounted is worse: hdiutil cannot
#   convert a busy volume, so the next build fails and leaves another behind.
#   Seven had accumulated before this swept them. reset-launch-services.sh
#   clears registrations that already exist.
#
# Wired to a launchd agent (~/Library/LaunchAgents/app.pikos.cleanup.plist)
# that fires every 14 days; can also be run by hand from the repo root.

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

# Workspace target (pikos-db + pikos-cli). cargo-sweep is run per-path with
# a positional argument so the desktop crate (excluded from the workspace)
# gets its own pass; --recursive isn't used because each target lives at a
# different repo subtree, not nested.
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

# Stash a timestamp inside .git/ so `pnpm verify` can nag when cleanup hasn't
# run in a while. .git/ is per-checkout, never committed, and survives
# `cargo clean` — making it the right home for a per-developer marker.
if [ -d "$ROOT/.git" ]; then
  date -u +%s > "$ROOT/.git/last-cleanup-builds"
fi
