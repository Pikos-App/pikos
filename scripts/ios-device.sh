#!/usr/bin/env bash
set -euo pipefail

# Build the iPhone app, install it on a paired phone, open it, then free what the build left running.
#
#   pnpm ios:device              the first paired iPhone, over USB or Wi-Fi
#   pnpm ios:device <udid>       a specific one, from `xcrun devicectl list devices`
#   pnpm ios:device --staging    the staging app instead, which syncs through the staging iCloud
#                                container's Production environment, the only one a Developer ID Mac
#                                reaches; PIKOS_CLOUDKIT_ENVIRONMENT=Development keeps it to the phone
#
# Xcode the app never opens. Its indexing and simulators are what eat a laptop, and
# `xcodebuild` with `devicectl` needs neither.
#
# The team comes from the Apple Development certificate in the keychain rather than from
# project.yml, which keeps it blank so nothing machine-specific is committed. PIKOS_TEAM_ID
# overrides it.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="$ROOT/apps/ios/Pikos"
XCFRAMEWORK="$ROOT/apps/ios/PikosCore/Frameworks/PikosFFI.xcframework"
EDITOR_HTML="$ROOT/apps/ios/PikosEditorBridge/Sources/PikosEditorBridge/Resources/editor.html"
DERIVED="$ROOT/target/ios-device"
CONFIGURATION=Debug
BUNDLE_ID="app.pikos.ios"
if [ "${1:-}" = "--staging" ]; then
  shift
  CONFIGURATION=Staging
  BUNDLE_ID="app.pikos.ios.staging"
fi

step() { printf '\033[1m▶ %s\033[0m\n' "$1"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# True when any file under the given paths is newer than the artifact, or the artifact is missing.
stale() {
  local artifact="$1"
  shift
  [ -e "$artifact" ] || return 0
  [ -n "$(find "$@" -newer "$artifact" -type f -not -path '*/node_modules/*' -print -quit 2>/dev/null)" ]
}

team_id() {
  if [ -n "${PIKOS_TEAM_ID:-}" ]; then
    echo "$PIKOS_TEAM_ID"
    return
  fi
  security find-certificate -c "Apple Development" -p 2>/dev/null |
    openssl x509 -noout -subject -nameopt multiline 2>/dev/null |
    awk -F' = ' '/organizationalUnitName/ { print $2; exit }'
}

device_id() {
  if [ -n "${1:-}" ]; then
    echo "$1"
    return
  fi
  local json
  json="$(mktemp)"
  xcrun devicectl list devices --json-output "$json" >/dev/null
  python3 -I - "$json" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1]))["result"]["devices"]
for d in devices:
    hw, props = d.get("hardwareProperties", {}), d.get("deviceProperties", {})
    if hw.get("reality") == "physical" and hw.get("platform") == "iOS" and d.get("connectionProperties", {}).get("pairingState") == "paired":
        print(d["identifier"])
        break
PY
  rm -f "$json"
}

TEAM="$(team_id)"
[ -n "$TEAM" ] || fail "no Apple Development certificate in the keychain. Set PIKOS_TEAM_ID, or sign in to Xcode once to create one."

DEVICE="$(device_id "${1:-}")"
[ -n "$DEVICE" ] || fail "no paired iPhone. Connect it by USB once, trust this Mac, and turn on Developer Mode (Settings › Privacy & Security)."

if stale "$XCFRAMEWORK/Info.plist" "$ROOT/crates" "$ROOT/Cargo.lock"; then
  step "the Rust changed: rebuilding the framework"
  bash "$ROOT/scripts/build-ios-framework.sh"
fi

if stale "$EDITOR_HTML" "$ROOT/packages/editor-mobile/src" "$ROOT/packages/editor-schema/src"; then
  step "the editor changed: rebuilding its bundle"
  bash "$ROOT/scripts/build-editor-bundle.sh"
fi

if stale "$PROJECT_DIR/Pikos.xcodeproj/project.pbxproj" "$PROJECT_DIR/project.yml"; then
  step "generating the Xcode project"
  (cd "$PROJECT_DIR" && xcodegen generate --quiet)
fi

step "building for the phone (team $TEAM)"
set -o pipefail
xcodebuild build \
  -project "$PROJECT_DIR/Pikos.xcodeproj" \
  -scheme Pikos \
  -configuration "$CONFIGURATION" \
  -destination "generic/platform=iOS" \
  -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" \
  PIKOS_CLOUDKIT_ENVIRONMENT="${PIKOS_CLOUDKIT_ENVIRONMENT:-Production}" \
  CODE_SIGN_STYLE=Automatic |
  if command -v xcbeautify >/dev/null; then xcbeautify --quiet; else grep -E 'error:|warning: .*Pikos|BUILD'; fi

APP="$DERIVED/Build/Products/$CONFIGURATION-iphoneos/Pikos.app"
[ -d "$APP" ] || fail "the build finished without $APP"

if [ "$CONFIGURATION" = Staging ]; then
  bash "$ROOT/scripts/check-sync-pairing.sh" "$APP" || true
fi

step "installing on $DEVICE"
# Once more on failure: over Wi-Fi to a sleeping phone, the first attempt can drop its connection.
xcrun devicectl device install app --device "$DEVICE" "$APP" >/dev/null 2>&1 ||
  xcrun devicectl device install app --device "$DEVICE" "$APP" >/dev/null

step "opening it"
if ! xcrun devicectl device process launch --device "$DEVICE" --terminate-existing "$BUNDLE_ID" >/dev/null 2>&1; then
  echo "  installed, but the phone is locked: it opens on the next tap"
fi

# Left running when another build is going, which is usually an agent's test run on a simulator.
if pgrep -qx xcodebuild; then
  step "another build is running: leaving the simulators and Xcode alone"
else
  step "freeing the laptop: simulators down, Xcode and Simulator closed"
  # Only Xcode's stock devices: an agent works on one it created and named, often between builds.
  xcrun simctl list devices booted \
    | sed -nE 's/^ +(iPhone|iPad).* \(([0-9A-F-]{36})\) \(Booted\) *$/\2/p' \
    | while read -r udid; do xcrun simctl shutdown "$udid" 2>/dev/null || true; done
  osascript -e 'quit app "Simulator"' -e 'quit app "Xcode"' 2>/dev/null || true
fi

printf '\033[32m✓ Pikos is on the phone.\033[0m\n'
