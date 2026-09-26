#!/usr/bin/env bash
set -euo pipefail

# record-hero.sh — Record marketing hero videos (dark + light mode).
#
# 1. Runs the Playwright recording script to capture .webm videos
# 2. Converts them to optimized .mp4 (H.264, silent, web-ready)
# 3. Copies output to the marketing site's public/ directory
#
# Data is auto-seeded via the marketing seed — no setup appears in the video.
#
# The server is started by playwright.record.config.ts on its own port, with the
# marketing seed and reuse disabled. Setting VITE_SEED here instead was the old
# way and it silently did nothing whenever a dev server was already listening:
# Playwright handed that one back and the recording ran against an empty calendar.
#
# Prerequisites:
#   - ffmpeg installed (brew install ffmpeg)
#
# Usage:
#   ./scripts/record-hero.sh
#   pnpm record:hero

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RECORDINGS_DIR="$DESKTOP_DIR/recordings"
MARKETING_PUBLIC="$DESKTOP_DIR/../marketing/public"

# Check ffmpeg is available
if ! command -v ffmpeg &>/dev/null; then
  echo "Error: ffmpeg is not installed. Run: brew install ffmpeg"
  exit 1
fi

# Clean previous recordings
rm -rf "$RECORDINGS_DIR"
mkdir -p "$RECORDINGS_DIR"

echo "Recording hero videos..."
echo ""

cd "$DESKTOP_DIR"
npx playwright test --config playwright.record.config.ts --reporter=list

echo ""
echo "Converting .webm → .mp4..."
echo ""

# Find the recorded .webm files (sorted by modification time, oldest first)
WEBM_FILES=()
while IFS= read -r f; do WEBM_FILES+=("$f"); done < <(ls -tr "$RECORDINGS_DIR"/*.webm 2>/dev/null)

if [ ${#WEBM_FILES[@]} -lt 2 ]; then
  echo "Error: Expected 2 .webm files, found ${#WEBM_FILES[@]}"
  echo "Files in $RECORDINGS_DIR:"
  ls -la "$RECORDINGS_DIR/" 2>/dev/null || true
  exit 1
fi

convert_to_mp4() {
  local input="$1"
  local output="$2"

  echo "  Converting: $(basename "$input") → $(basename "$output")"

  # Each take writes its own measured prefix beside the .webm: page load, the
  # inbox flash and the view switch, up to the frame the video should open on.
  # That frame matches the final one, which is what makes the loop read as a
  # restart rather than a jump. 3.0 is the old fixed guess, kept only so a
  # missing sidecar still produces something.
  local trim=3.0
  if [ -f "$input.trim" ]; then
    trim=$(<"$input.trim")
  else
    echo "  Warning: no $input.trim — falling back to a fixed ${trim}s cut"
  fi

  # H.264, no audio, web-optimized (faststart moves moov atom to front).
  ffmpeg -y -ss "$trim" -i "$input" \
    -c:v libx264 \
    -preset slow \
    -crf 23 \
    -an \
    -pix_fmt yuv420p \
    -vf "scale=1280:-2:flags=lanczos" \
    -movflags +faststart \
    "$output" \
    -loglevel warning

  # The poster fronts the video before it plays, under reduced motion, and if it
  # fails to load. Taking it from the finished mp4's own first frame is what stops
  # the two drifting: the pair it replaces were four months older than the video.
  ffmpeg -y -i "$output" -frames:v 1 -update 1 -q:v 4 "${output%.mp4}.jpg" -loglevel warning

  local size
  size=$(du -h "$output" | cut -f1)
  echo "  → $output ($size)"
}

DARK_MP4="$RECORDINGS_DIR/pikos-hero-dark.mp4"
LIGHT_MP4="$RECORDINGS_DIR/pikos-hero-light.mp4"

convert_to_mp4 "${WEBM_FILES[0]}" "$DARK_MP4"
convert_to_mp4 "${WEBM_FILES[1]}" "$LIGHT_MP4"

# Copy to marketing site
echo ""
echo "Copying to marketing site..."
mkdir -p "$MARKETING_PUBLIC"
cp "$DARK_MP4" "$MARKETING_PUBLIC/pikos-hero-dark.mp4"
cp "$LIGHT_MP4" "$MARKETING_PUBLIC/pikos-hero-light.mp4"
cp "${DARK_MP4%.mp4}.jpg" "$MARKETING_PUBLIC/pikos-hero-dark.jpg"
cp "${LIGHT_MP4%.mp4}.jpg" "$MARKETING_PUBLIC/pikos-hero-light.jpg"

echo ""
echo "Done! Videos and posters are at:"
echo "  $MARKETING_PUBLIC/pikos-hero-dark.mp4 + .jpg"
echo "  $MARKETING_PUBLIC/pikos-hero-light.mp4 + .jpg"
