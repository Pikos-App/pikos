#!/usr/bin/env bash
set -euo pipefail

# Run the iPhone app's speed tests against a 200,000-page workspace.
#
#   pnpm ios:speed                   the first paired iPhone, which has to stay unlocked
#   pnpm ios:speed --sim <udid>      a booted simulator, for checking the run itself
#
# The workspace is `pikos stress seed --shape mixed`, built once on the Mac and kept in target/:
# seeding that many pages through the app's writer on a phone takes hours. It's copied into the
# app's own container, where a debug build's SpeedTests open it (PIKOS_SPEED_AT_SCALE).

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/apps/ios/Pikos/Pikos.xcodeproj"
DERIVED="$ROOT/target/ios-speed"
TEMPLATE="$ROOT/target/pikos-speed-200k.sqlite"
BUNDLE_ID="app.pikos.ios"
# Must match SpeedTests' workspace directory at scale.
DESTINATION_IN_CONTAINER="Library/Caches/pikos.sqlite"

step() { printf '\033[1m▶ %s\033[0m\n' "$1"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

SIM=""
if [ "${1:-}" = "--sim" ]; then
  SIM="${2:-}"
  [ -n "$SIM" ] || fail "--sim needs a booted simulator's udid, from xcrun simctl list devices booted"
fi

if [ ! -f "$TEMPLATE" ]; then
  step "seeding 200,000 pages on the Mac, once (several minutes)"
  cargo run --release --quiet -p pikos-cli -- --db "$TEMPLATE" stress seed \
    --pages 200000 --large-pages 1 --large-words 10000 --shape mixed
fi

run_tests() {
  env TEST_RUNNER_PIKOS_RUN_SPEED=1 TEST_RUNNER_PIKOS_SPEED_AT_SCALE=1 xcodebuild test-without-building \
    -project "$PROJECT" -scheme Pikos -derivedDataPath "$DERIVED" -destination "$1" \
    -only-testing:PikosUITests/SpeedTests "${@:2}" |
    grep -E --line-buffered 'SPEED [^m]|measured \[|Test Case .*(passed|failed)|error:|\*\* TEST'
}

if [ -n "$SIM" ]; then
  step "building for the simulator"
  xcodebuild build-for-testing -project "$PROJECT" -scheme Pikos -derivedDataPath "$DERIVED" \
    -destination "platform=iOS Simulator,id=$SIM" CODE_SIGNING_ALLOWED=NO -quiet
  xcrun simctl install "$SIM" "$DERIVED/Build/Products/Debug-iphonesimulator/Pikos.app"
  step "copying the workspace into the app"
  CONTAINER="$(xcrun simctl get_app_container "$SIM" "$BUNDLE_ID" data)"
  mkdir -p "$(dirname "$CONTAINER/$DESTINATION_IN_CONTAINER")"
  rm -f "$CONTAINER/$DESTINATION_IN_CONTAINER"-wal "$CONTAINER/$DESTINATION_IN_CONTAINER"-shm
  cp "$TEMPLATE" "$CONTAINER/$DESTINATION_IN_CONTAINER"
  step "running the speed tests"
  run_tests "platform=iOS Simulator,id=$SIM" CODE_SIGNING_ALLOWED=NO
  exit
fi

ids="$(mktemp)"
xcrun devicectl list devices --json-output "$ids" >/dev/null
read -r DEVICE UDID < <(python3 -I - "$ids" <<'PY'
import json, sys
for d in json.load(open(sys.argv[1]))["result"]["devices"]:
    hw = d.get("hardwareProperties", {})
    if hw.get("reality") == "physical" and hw.get("platform") == "iOS" and d.get("connectionProperties", {}).get("pairingState") == "paired":
        print(d["identifier"], hw["udid"])
        break
PY
)
rm -f "$ids"
[ -n "${DEVICE:-}" ] || fail "no paired iPhone"
TEAM="${PIKOS_TEAM_ID:-$(security find-certificate -c "Apple Development" -p 2>/dev/null |
  openssl x509 -noout -subject -nameopt multiline 2>/dev/null |
  awk -F' = ' '/organizationalUnitName/ { print $2; exit }')}"
[ -n "$TEAM" ] || fail "no Apple Development certificate in the keychain; set PIKOS_TEAM_ID"

step "building for the phone (team $TEAM)"
xcodebuild build-for-testing -project "$PROJECT" -scheme Pikos -derivedDataPath "$DERIVED" \
  -destination "platform=iOS,id=$UDID" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic -quiet
xcrun devicectl device install app --device "$DEVICE" "$DERIVED/Build/Products/Debug-iphoneos/Pikos.app" >/dev/null
step "copying the workspace onto the phone"
xcrun devicectl device copy to --device "$DEVICE" --domain-type appDataContainer \
  --domain-identifier "$BUNDLE_ID" --source "$TEMPLATE" --destination "$DESTINATION_IN_CONTAINER" >/dev/null
step "running the speed tests (keep the phone unlocked)"
run_tests "platform=iOS,id=$UDID" DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic
