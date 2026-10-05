#!/usr/bin/env bash
# Record a calendar provider's exchanges with Pikos as a replay fixture for the sync tests.
#
#   scripts/record-sync.sh caldav <url> <fixture-name>   # drives the recording test against a server
#   scripts/record-sync.sh app <fixture-name>            # records while you use Pikos Staging
#
# Both run a recording proxy (`scripts/sync-record.py`) and write
# crates/pikos-calendar-sync/tests/fixtures/sync-replay/<fixture-name>.json, with credentials
# stripped. `caldav` suits a local or plain-HTTP server, like Radicale. `app` is for the real
# providers over HTTPS: the proxy can only read that traffic while this Mac trusts its
# certificate (~/.mitmproxy/mitmproxy-ca-cert.pem), so trust it for the session and remove it
# after. Quit Staging to finish; the fixture is written when the proxy stops.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=18766
PROXY="http://127.0.0.1:$PORT"
FIXTURES="$ROOT/crates/pikos-calendar-sync/tests/fixtures/sync-replay"

mode="${1:-}"
case "$mode" in
  caldav) url="${2:?caldav needs a server URL}"; name="${3:?caldav needs a fixture name}" ;;
  app) name="${2:?app needs a fixture name}" ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
out="$FIXTURES/$name.json"
mkdir -p "$FIXTURES"

SYNC_RECORD_OUT="$out" mitmdump --listen-host 127.0.0.1 -p "$PORT" -q \
  -s "$ROOT/scripts/sync-record.py" &
proxy=$!
trap 'kill -INT "$proxy" 2>/dev/null; wait "$proxy" 2>/dev/null || true' EXIT
until nc -z 127.0.0.1 "$PORT" 2>/dev/null; do sleep 0.2; done

if [ "$mode" = caldav ]; then
  (cd "$ROOT" && HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" NO_PROXY="" PIKOS_CALDAV_URL="$url" \
    cargo test -q -p pikos-calendar-sync --lib record_a_live_caldav_calendar -- --ignored)
else
  app="$HOME/Applications/Pikos Staging.app/Contents/MacOS/pikos"
  [ -x "$app" ] || { echo "no Pikos Staging; run pnpm qa:build first" >&2; exit 1; }
  echo "Recording. Connect the calendar accounts in Pikos Staging and let them sync, then quit it."
  HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" NO_PROXY="" "$app"
fi
echo "Recorded to $out"
