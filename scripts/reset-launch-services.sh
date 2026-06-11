#!/usr/bin/env bash
# Recover macOS notification delivery when it silently stops working.
#
# Repeated DMG mounts and in-place app overrides accumulate many Launch Services
# registrations under the one bundle id `app.pikos.desktop`. macOS then can't map
# the running app to a single authorization, so `requestAuthorization` fails
# (granted=false / authorization_status=not_determined) even though System
# Settings shows Pikos "allowed" — the visible toggle becomes a ghost with no
# backing record. See .agent/BACKLOG_DISTRIBUTION.md (Gotchas worth remembering).
#
# This unregisters every Pikos.app path EXCEPT the canonical /Applications
# install, then restarts the notification daemon. A plain `lsregister -r` rescan
# does NOT purge dead paths — they must be unregistered individually.
#
# Nothing here is destructive to data: it only touches the Launch Services index
# and bounces usernoted (which relaunches itself).

set -euo pipefail

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
KEEP="/Applications/Pikos.app"

log() { printf '[reset-ls] %s\n' "$*"; }

if [ ! -x "$LSREGISTER" ]; then
  echo "[reset-ls] lsregister not found at expected path — aborting." >&2
  exit 1
fi

# Match the literal "/Pikos.app" bundle (case-sensitive) so unrelated paths
# like ~/Library/WebKit/com.pikos.app aren't swept in.
paths=$("$LSREGISTER" -dump 2>/dev/null \
  | grep -E "^[[:space:]]*path:.*/Pikos\.app" \
  | sed -E 's/.*path: *//; s/ \(0x.*//' \
  | sort -u)

if [ -z "$paths" ]; then
  log "no Pikos.app registrations found."
else
  log "registered Pikos.app paths:"
  printf '%s\n' "$paths" | sed 's/^/  /'
  printf '%s\n' "$paths" | while IFS= read -r p; do
    [ "$p" = "$KEEP" ] && { log "keep   $p"; continue; }
    log "unreg  $p"
    "$LSREGISTER" -u "$p" 2>/dev/null || true
  done
fi

log "restarting usernoted (auto-relaunches)"
killall usernoted 2>/dev/null || true

log "done. Relaunch $KEEP — or your fresh QA build by explicit path (open <path>.app)."
