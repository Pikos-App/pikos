#!/usr/bin/env bash
# The staging app's data, for QA. Everything here is keyed by the staging identifier read from
# its overlay, so nothing can reach the installed app's or the dev app's data.
#
#   scripts/qa-staging.sh reset         remove the workspace, settings, caches and logs: a first launch
#   scripts/qa-staging.sh seed [pages]  add a realistic workspace (default 2,000 pages) through the CLI
#   scripts/qa-staging.sh paths         print where each lives
#   scripts/qa-staging.sh accounts before|after
#                                       around disconnecting a calendar account: pass or fail for
#                                       SYNC-05 (keychain) and SYNC-28 (Google revoke)
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

# Every build stores under this one service, so staging's entries are found by its own account ids.
KEYCHAIN_SERVICE=app.pikos.desktop.sync
# Access tokens read before a disconnect, since the keychain entry that holds them is gone after it.
TOKENS="${TMPDIR:-/tmp}/pikos-qa-google-tokens"

account_ids() {
  sqlite3 -readonly "$DB" "SELECT id FROM sync_account WHERE disconnected = $1${2:+ AND provider = '$2'}"
}

has_keychain_entry() {
  security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$1" > /dev/null 2>&1
}

# 200 for a live token and 400 for a dead one; 000 means Google wasn't reached.
tokeninfo_status() {
  curl -s -o /dev/null -w '%{http_code}' --data-urlencode "access_token@$1" \
    https://oauth2.googleapis.com/tokeninfo || true
}

accounts_before() {
  local ids
  ids=$(account_ids 0 google)
  if [ -z "$ids" ]; then
    echo "[qa-staging] no connected Google account in $NAME. Connect one first." >&2
    exit 1
  fi

  rm -rf "$TOKENS"
  (umask 077 && mkdir "$TOKENS")
  log "reading each Google account's token; allow the keychain prompt if it asks"
  for id in $ids; do
    security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$id" -w \
      | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).access_token)' \
      > "$TOKENS/$id"

    local status
    status=$(tokeninfo_status "$TOKENS/$id")
    if [ "$status" != 200 ]; then
      rm -rf "$TOKENS"
      echo "[qa-staging] account $id's token isn't live (HTTP $status). Resync it in $NAME, then run before again." >&2
      exit 1
    fi
  done

  log "holding a live token for each Google account; disconnect one in $NAME, then run: pnpm qa:accounts after"
}

accounts_after() {
  local failed=0 id

  if [ -z "$(account_ids 0)$(account_ids 1)" ]; then
    log "SYNC-05 fail: $NAME has no calendar account to check"
    failed=1
  fi
  for id in $(account_ids 0); do
    if ! has_keychain_entry "$id"; then
      log "SYNC-05 fail: connected account $id has no keychain entry"
      failed=1
    fi
  done
  for id in $(account_ids 1); do
    if has_keychain_entry "$id"; then
      log "SYNC-05 fail: disconnected account $id still has a keychain entry"
      failed=1
    fi
  done
  if [ "$failed" = 0 ]; then
    log "SYNC-05 pass: one keychain entry per connected account, none for a disconnected one"
  fi

  local disconnected checked=0 file status
  disconnected=$(account_ids 1 google)
  for file in "$TOKENS"/*; do
    [ -e "$file" ] || continue
    id=$(basename "$file")
    grep -qx "$id" <<< "$disconnected" || continue

    checked=1
    status=$(tokeninfo_status "$file")
    case "$status" in
      400) log "SYNC-28 pass: Google refuses account $id's token, so the grant is revoked" ;;
      200) log "SYNC-28 fail: Google still accepts account $id's token after the disconnect"; failed=1 ;;
      *) log "SYNC-28 fail: couldn't ask Google about account $id (HTTP $status)"; failed=1 ;;
    esac
  done
  if [ "$checked" = 0 ]; then
    log "SYNC-28 fail: no Google account read by 'before' has been disconnected"
    failed=1
  else
    rm -rf "$TOKENS"
  fi

  return "$failed"
}

accounts() {
  if [ ! -f "$DB" ]; then
    echo "[qa-staging] no $NAME workspace at $DB" >&2
    exit 1
  fi

  case "$1" in
    before) accounts_before ;;
    after) accounts_after ;;
    *) echo "[qa-staging] usage: $0 accounts before|after" >&2; exit 1 ;;
  esac
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
  accounts)
    accounts "${2:-}"
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
