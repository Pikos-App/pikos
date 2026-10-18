#!/usr/bin/env bash
# Screenshot every screen, sheet, dialog, menu and popover of the iOS app into one review PDF.
#
#   scripts/ios-screen-tour.sh [output-dir]
#
# Runs the ScreenTour UI tests on a simulator against the debug demo workspace, then lays the
# screenshots out with scripts/screen-tour-pdf.py. Output defaults to build/ios-screen-tour.
#
# PIKOS_TOUR_APPEARANCE is light or dark. PIKOS_TOUR_TEXT_SIZE takes a simctl content size, such as
# accessibility-extra-large, and PIKOS_TOUR_CONTRAST=enabled turns on Increase Contrast; both are put
# back when the run ends. Reduce Transparency has no simctl switch, so it is not covered.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVICE="${PIKOS_TOUR_DEVICE:-iPhone 17 Pro}"
APPEARANCE="${PIKOS_TOUR_APPEARANCE:-light}"
TEXT_SIZE="${PIKOS_TOUR_TEXT_SIZE:-large}"
CONTRAST="${PIKOS_TOUR_CONTRAST:-disabled}"
OUT="${1:-$ROOT/build/ios-screen-tour}"

rm -rf "$OUT"
mkdir -p "$OUT"

xcodegen generate --spec "$ROOT/apps/ios/Pikos/project.yml" --project "$ROOT/apps/ios/Pikos" >/dev/null
xcrun simctl boot "$DEVICE" 2>/dev/null || true
xcrun simctl bootstatus "$DEVICE" -b >/dev/null
xcrun simctl ui "$DEVICE" appearance "$APPEARANCE"
xcrun simctl ui "$DEVICE" content_size "$TEXT_SIZE"
xcrun simctl ui "$DEVICE" increase_contrast "$CONTRAST"
xcrun simctl status_bar "$DEVICE" override --time 9:41 --dataNetwork wifi --wifiBars 3 \
  --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
restore() {
  xcrun simctl status_bar "$DEVICE" clear || true
  xcrun simctl ui "$DEVICE" content_size large || true
  xcrun simctl ui "$DEVICE" increase_contrast disabled || true
}
trap restore EXIT

# A surface the tour could not reach fails the run, which is not a reason to skip the PDF: the
# attachments are exported whenever the bundle exists, and the PDF lists what was missed.
xcodebuild test \
  -project "$ROOT/apps/ios/Pikos/Pikos.xcodeproj" \
  -scheme Pikos \
  -destination "platform=iOS Simulator,name=$DEVICE" \
  -only-testing:PikosUITests/ScreenTour \
  -resultBundlePath "$OUT/tour.xcresult" \
  CODE_SIGNING_ALLOWED=NO \
  | grep -E "Test Case .*(passed|failed)|error:|\*\* TEST" || true

xcrun xcresulttool export attachments --path "$OUT/tour.xcresult" --output-path "$OUT/attachments" >/dev/null

BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD)"
DIRTY=""
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then DIRTY=" plus uncommitted changes"; fi
python3 "$ROOT/scripts/screen-tour-pdf.py" "$OUT/attachments" "$OUT/Pikos iOS screens.pdf" \
  --subtitle "$DEVICE · $APPEARANCE · text $TEXT_SIZE · contrast $CONTRAST · $BRANCH @ $COMMIT$DIRTY"
echo "$OUT/Pikos iOS screens.pdf"
