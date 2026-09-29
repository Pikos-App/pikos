#!/usr/bin/env bash
# Signed local production build for manual QA.
#
# Signing (NOT notarization) is what unlocks macOS notification delivery, so we
# always build with the real Developer ID identity — a plain `tauri build` is
# ad-hoc signed and can't deliver notifications (UNErrorDomain error 1). This is
# rung 2 of the build-fidelity ladder; see .claude/skills/ship-release/SKILL.md.
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

# The build succeeds without these and simply hides Google sync, so a QA pass would
# work through every Google row against a build that never had the feature in it.
missing=""
[ -n "${PIKOS_GOOGLE_CLIENT_ID:-}" ] || missing="PIKOS_GOOGLE_CLIENT_ID"
[ -n "${PIKOS_GOOGLE_CLIENT_SECRET:-}" ] || missing="$missing PIKOS_GOOGLE_CLIENT_SECRET"
if [ -n "$missing" ]; then
  echo "[qa-build] Not set:$missing" >&2
  echo "[qa-build] This build would hide Google sync, so every Google QA row would pass by" >&2
  echo "[qa-build] being untestable. Export both, or PIKOS_ALLOW_NO_GOOGLE=1 to build anyway." >&2
  [ "${PIKOS_ALLOW_NO_GOOGLE:-}" = "1" ] || exit 1
  log "building without Google sync, as asked"
fi

# Remove previously built bundles so macOS Spotlight can't launch a stale copy
# (duplicate app.pikos.desktop registrations also confuse notification auth).
log "removing stale target bundles"
find apps/desktop/src-tauri/target -path "*/bundle/macos/*.app" -type d -prune \
  -exec rm -rf {} + 2>/dev/null || true

APPLE_SIGNING_IDENTITY="$IDENTITY" pnpm --filter @pikos/desktop tauri build

APP="$ROOT/apps/desktop/src-tauri/target/release/bundle/macos/Pikos.app"

# The identity is resolved above and handed to tauri, and tauri falls back to an
# ad-hoc signature rather than failing when it cannot use it. That build looks
# finished and delivers no notifications, which is the trap this whole script
# exists to avoid — so confirm the signature rather than assume it.
bash "$ROOT/scripts/macos-signing-check.sh" \
  "$ROOT/apps/desktop/src-tauri/target/release/bundle" --signature-only

echo
log "built: $APP"
log "launch it directly (NOT via Spotlight — that may open an older copy):"
log "    open \"$APP\""
