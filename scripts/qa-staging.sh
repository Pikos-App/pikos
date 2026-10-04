#!/usr/bin/env bash
# The staging app's data, for QA. Everything here is keyed by the staging identifier read from
# its overlay, so nothing can reach the installed app's or the dev app's data.
#
#   scripts/qa-staging.sh reset         remove the workspace, settings, caches and logs: a first launch
#   scripts/qa-staging.sh seed [pages]  add a realistic workspace (default 2,000 pages) through the CLI
#   scripts/qa-staging.sh paths         print where each lives
#
# Staging must be closed for reset and seed. Calendar passwords stay in the keychain, which
# can't be listed by app; removing a staging calendar account in the app removes its own.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OVERLAY=apps/desktop/src-tauri/tauri.conf.staging.json
ID=$(node -p "require('./$OVERLAY').identifier")
NAME=$(node -p "require('./$OVERLAY').productName")
case "$ID" in
  *.staging) ;;
  *) echo "[qa-staging] $OVERLAY names '$ID', not a staging identifier; refusing" >&2; exit 1 ;;
esac

LIB="$HOME/Library"
DATA="$LIB/Application Support/$ID"
DB="$DATA/default.sqlite"
DIRS=("$DATA" "$LIB/Logs/$ID" "$LIB/Caches/$ID" "$LIB/WebKit/$ID")

log() { printf '[qa-staging] %s\n' "$*"; }

require_closed() {
  if pgrep -f "/$NAME.app/" > /dev/null; then
    echo "[qa-staging] $NAME is running. Quit it first." >&2
    exit 1
  fi
}

case "${1:-}" in
  reset)
    require_closed
    for dir in "${DIRS[@]}"; do
      if [ -e "$dir" ]; then
        rm -rf "$dir"
        log "removed $dir"
      fi
    done
    log "$NAME opens as a first launch now"
    ;;
  seed)
    require_closed
    pages="${2:-2000}"
    mkdir -p "$DATA"
    log "seeding $pages pages into $DB"
    cargo run --quiet --release -p pikos-cli -- stress seed --db "$DB" --shape mixed \
      --pages "$pages" --large-pages 2 --large-words 5000
    log "done; open $NAME to see them"
    ;;
  paths)
    printf 'workspace  %s\nlogs       %s\nCLI        pikos --db "%s" <command>\n' \
      "$DB" "$LIB/Logs/$ID/pikos.log" "$DB"
    ;;
  *)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
