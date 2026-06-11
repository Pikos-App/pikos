#!/usr/bin/env bash
# Periodic cleanup of stale Rust build artifacts in this checkout.
#
# - cargo-sweep drops cached build outputs (incremental objects, fingerprints,
#   per-crate rlibs) that haven't been touched in $DAYS days, while leaving
#   anything fresher than that alone — so the next build is still fast.
# - Stale .app bundles in target/**/bundle/macos/ are removed because macOS
#   Spotlight indexes them and may launch the wrong version (see
#   .agent/BACKLOG_DISTRIBUTION.md "Gotchas worth remembering").
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

# Stale built .app bundles confuse macOS Spotlight.
log "remove stale .app bundles from target/**/bundle/macos/"
find apps/desktop/src-tauri/target -path "*/bundle/macos/*.app" -type d -prune \
  -exec rm -rf {} + 2>/dev/null || true

after=$(df -k "$ROOT" | awk 'NR==2 {print $4}')
freed_mb=$(( (after - before) / 1024 ))
log "done — freed ~${freed_mb} MB"

# Stash a timestamp inside .git/ so `pnpm verify` can nag when cleanup hasn't
# run in a while. .git/ is per-checkout, never committed, and survives
# `cargo clean` — making it the right home for a per-developer marker.
if [ -d "$ROOT/.git" ]; then
  date -u +%s > "$ROOT/.git/last-cleanup-builds"
fi
