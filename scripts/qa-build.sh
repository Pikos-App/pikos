#!/usr/bin/env bash
# Signed local production build for manual QA.
#
# Signing (NOT notarization) is what unlocks macOS notification delivery, so we
# always build with the real Developer ID identity — a plain `tauri build` is
# ad-hoc signed and can't deliver notifications (UNErrorDomain error 1). This is
# rung 2 of the build-fidelity ladder; see .agent/skills/ship-release/SKILL.md.
#
# Notarization is intentionally skipped: it only gates the download / Gatekeeper
# / updater path, which a locally-run build never exercises. For a major release
# smoke-test the actual notarized .dmg from the GitHub release instead.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf '[qa-build] %s\n' "$*"; }

# Resolve the Developer ID Application identity from the keychain so the name
# isn't hardcoded. Override by exporting APPLE_SIGNING_IDENTITY.
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY=$(security find-identity -v -p codesigning \
    | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"')
fi
if [ -z "$IDENTITY" ]; then
  echo "[qa-build] No 'Developer ID Application' identity found in the keychain." >&2
  echo "[qa-build] Install the cert, or export APPLE_SIGNING_IDENTITY=\"Developer ID Application: ...\"." >&2
  exit 1
fi
log "signing identity: $IDENTITY"

# Remove previously built bundles so macOS Spotlight can't launch a stale copy
# (duplicate app.pikos.desktop registrations also confuse notification auth).
log "removing stale target bundles"
find apps/desktop/src-tauri/target -path "*/bundle/macos/*.app" -type d -prune \
  -exec rm -rf {} + 2>/dev/null || true

APPLE_SIGNING_IDENTITY="$IDENTITY" pnpm --filter @pikos/desktop tauri build

APP="$ROOT/apps/desktop/src-tauri/target/release/bundle/macos/Pikos.app"
echo
log "built: $APP"
log "launch it directly (NOT via Spotlight — that may open an older copy):"
log "    open \"$APP\""
