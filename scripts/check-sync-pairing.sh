#!/usr/bin/env bash
# Fails when the staging phone and Mac builds can't see each other's iCloud data. A different
# container or environment raises no error anywhere: each device just syncs alone.
#
#   scripts/check-sync-pairing.sh [phone.app] [mac.app]
#
# Defaults to the phone build `ios-device.sh --staging` leaves and the Mac app `qa-build.sh --icloud`
# installs. Reads only their signatures, so it runs offline, and passes with a note when one of the
# two isn't built.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PHONE="${1:-$ROOT/target/ios-device/Build/Products/Staging-iphoneos/Pikos.app}"
MAC="${2:-$HOME/Applications/Pikos Staging.app}"

for app in "$PHONE" "$MAC"; do
  if [ ! -d "$app" ]; then
    echo "[sync-pairing] $app isn't built, so there's nothing to pair with yet"
    exit 0
  fi
done

# "<container> <environment>" from an app's signed entitlements.
icloud() {
  codesign -d --entitlements - --xml "$1" 2>/dev/null | python3 -I -c '
import plistlib, sys
e = plistlib.loads(sys.stdin.buffer.read())
containers = e.get("com.apple.developer.icloud-container-identifiers") or ["none"]
print(containers[0], e.get("com.apple.developer.icloud-container-environment", "none"))
'
}

phone="$(icloud "$PHONE")"
mac="$(icloud "$MAC")"
if [ "$phone" = "$mac" ]; then
  echo "[sync-pairing] phone and Mac sync through $phone"
  exit 0
fi

echo "[sync-pairing] the phone syncs through $phone and the Mac through $mac, so neither sees the other" >&2
echo "[sync-pairing] a Developer ID Mac reaches Production only: build the phone without PIKOS_CLOUDKIT_ENVIRONMENT=Development" >&2
exit 1
