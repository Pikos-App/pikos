#!/usr/bin/env bash
# Record a calendar provider's exchanges with Pikos as a replay fixture for the sync tests.
#
#   scripts/record-sync.sh caldav <url> <fixture-name>   # drives the recording test against a server
#   scripts/record-sync.sh app <fixture-name>            # records while you use Pikos Staging
#
# Both run a recording proxy (`scripts/sync-record.py`) and write
# crates/pikos-calendar-sync/tests/fixtures/sync-replay/<fixture-name>.json, with credentials
# and the account's identity stripped. Set SYNC_RECORD_REDACT="Your Name" to strip the holder's
# name too. `caldav` signs in as CALDAV_USER and CALDAV_PASSWORD, turns on PIKOS_RECORD_CALENDARS
# and keeps syncing for PIKOS_RECORD_POLL_SECS; it trusts the proxy's certificate in the test
# build alone, so it records iCloud, which the OS pins against any proxy. `app` records while
# you use Pikos Staging; the app reads the traffic only while this Mac trusts the proxy's
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
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
out="$FIXTURES/$name.json"
mkdir -p "$FIXTURES"
# A recording git doesn't hold yet can't be got back, so a re-record never replaces it silently.
if [ -f "$out" ] && [ -n "$(git -C "$ROOT" status --porcelain -- "$out")" ] && [ "${REPLACE:-}" != 1 ]; then
  echo "$name.json has a recording git doesn't hold yet: commit it, pick another name, or set REPLACE=1" >&2
  exit 1
fi
partial="$out.recording"
rm -f "$partial"

SYNC_RECORD_OUT="$partial" mitmdump --listen-host 127.0.0.1 -p "$PORT" -q \
  -s "$ROOT/scripts/sync-record.py" &
proxy=$!
trap 'kill -INT "$proxy" 2>/dev/null || true; wait "$proxy" 2>/dev/null || true' EXIT
until nc -z 127.0.0.1 "$PORT" 2>/dev/null; do sleep 0.2; done

if [ "$mode" = caldav ]; then
  (cd "$ROOT" && HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" NO_PROXY="" PIKOS_CALDAV_URL="$url" \
    PIKOS_RECORD_CA="$HOME/.mitmproxy/mitmproxy-ca-cert.pem" \
    cargo test -q -p pikos-calendar-sync --lib record_a_live_caldav_calendar -- --ignored --nocapture)
else
  app="$HOME/Applications/Pikos Staging.app/Contents/MacOS/pikos"
  [ -x "$app" ] || { echo "no Pikos Staging; run pnpm qa:build first" >&2; exit 1; }
  echo "Recording. Connect the calendar accounts in Pikos Staging and let them sync, then quit it."
  HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" NO_PROXY="" "$app"
fi
kill -INT "$proxy"
wait "$proxy" || true
[ -f "$partial" ] || { echo "Nothing recorded; see the proxy's message above" >&2; exit 1; }
mv "$partial" "$out"
echo "Recorded to $out"
