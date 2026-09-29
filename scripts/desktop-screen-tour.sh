#!/usr/bin/env bash
# Screenshot every screen, dialog, popover, menu and panel of the desktop app into two review PDFs,
# one per theme.
#
#   scripts/desktop-screen-tour.sh [output-dir]
#
# Runs apps/desktop/e2e/screen-tour.spec.ts through playwright.tour.config.ts against the demo
# workspace seed, then lays each theme's screenshots out with scripts/screen-tour-pdf.py.
# Output defaults to build/desktop-screen-tour.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/build/desktop-screen-tour}"

rm -rf "$OUT"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

# The tour records what it could not reach instead of failing, so a non-zero exit here is a server
# or runner problem; whatever screenshots landed are still laid out.
(cd "$ROOT/apps/desktop" && PIKOS_TOUR_OUT="$OUT" pnpm exec playwright test \
  --config playwright.tour.config.ts --reporter=list 2>&1) \
  | grep -E "✓|✘|passed|failed|Error" || true

BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD)"
DIRTY=""
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then DIRTY=" plus uncommitted changes"; fi

for THEME in light dark; do
  PDF="$OUT/Pikos desktop screens ($THEME).pdf"
  python3 "$ROOT/scripts/screen-tour-pdf.py" "$OUT/$THEME" "$PDF" \
    --layout window \
    --work-dir "$OUT/$THEME" \
    --title "Pikos for desktop, every screen" \
    --subtitle "1440 × 900 window · $THEME · $BRANCH @ $COMMIT$DIRTY" \
    --not-captured "Native macOS menus, the Dock, window traffic lights and system notification banners (the tour drives the web view in WebKit, not the Tauri shell)" \
    --not-captured "Anything that needs the Tauri backend: the update dialog, file pickers for import and image upload, export save results, and Show in Finder" \
    --not-captured "Import review: the CSV column mapping and import preview pages (both start from a picked file)" \
    --not-captured "A live provider: sync errors, the Reconnect dialog, and an event edited upstream (section 10 uses the mock sync seed, which plants mirrors and detached pages without a network)" \
    --not-captured "The Developer settings tab, which only exists in development builds"
  echo "$PDF"
done
