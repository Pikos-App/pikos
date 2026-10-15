#!/usr/bin/env bash
set -euo pipefail

# Replace the iOS simulator's workspace with desktop seed scenarios.
#
#   scripts/seed-ios-simulator.sh wide
#   scripts/seed-ios-simulator.sh editor calendar --device <udid>
#
# The seeds are the desktop's own (apps/desktop/seeds), run through the desktop
# storage adapter and written by the shared Rust writer into a fresh file, which
# then replaces pikos.sqlite in the app's App Group container. The app has to be
# installed on the simulator already; it is stopped and relaunched around the swap.
#
# The runner is built from this checkout, so the workspace carries this
# checkout's migrations. An app built from a tree missing one of them refuses to
# open the file.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/apps/desktop"
TAURI="$DESKTOP/src-tauri"
BUNDLE="$DESKTOP/node_modules/.cache/seed-workspace.mjs"
RUNNER="${CARGO_TARGET_DIR:-$TAURI/target}/debug/examples/seed_workspace"
APP_ID="app.pikos.ios"
APP_GROUP="group.app.pikos"

device="booted"
scenarios=()
while [ $# -gt 0 ]; do
  case "$1" in
    --device)
      device="$2"
      shift 2
      ;;
    -h | --help)
      echo "usage: $0 [scenario...] [--device <udid>]   (default: wide on the booted simulator)"
      exit 0
      ;;
    *)
      scenarios+=("$1")
      shift
      ;;
  esac
done
if [ ${#scenarios[@]} -eq 0 ]; then
  scenarios=(wide)
fi

container="$(xcrun simctl get_app_container "$device" "$APP_ID" "$APP_GROUP" 2>/dev/null)" || {
  echo "error: no $APP_GROUP container for $APP_ID on simulator '$device'." >&2
  echo "Boot a simulator and install the app from Xcode first." >&2
  exit 1
}

if ! build_log="$(cargo build --quiet --manifest-path "$TAURI/Cargo.toml" --example seed_workspace 2>&1)"; then
  echo "$build_log" >&2
  exit 1
fi

"$DESKTOP/node_modules/.bin/esbuild" "$DESKTOP/scripts/seed-workspace/main.ts" \
  --bundle --platform=node --format=esm --log-level=warning \
  --alias:@tauri-apps/api/core="$DESKTOP/scripts/seed-workspace/invoke.ts" \
  --alias:@/shared/logger="$DESKTOP/scripts/seed-workspace/logger.ts" \
  --alias:@seeds="$DESKTOP/seeds" \
  --alias:@="$DESKTOP/src" \
  --alias:@pikos/core="$ROOT/packages/core/src/index.ts" \
  '--define:import.meta.env={"DEV":true}' \
  --outfile="$BUNDLE"

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
node "$BUNDLE" "$RUNNER" "$staging/pikos.sqlite" "${scenarios[@]}"

xcrun simctl terminate "$device" "$APP_ID" 2>/dev/null || true
rm -f "$container/pikos.sqlite" "$container/pikos.sqlite-wal" "$container/pikos.sqlite-shm"
cp "$staging/pikos.sqlite" "$container/pikos.sqlite"
xcrun simctl launch "$device" "$APP_ID" >/dev/null

echo "Seeded ${scenarios[*]} into $container/pikos.sqlite"
