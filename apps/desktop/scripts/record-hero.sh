#!/usr/bin/env bash
set -euo pipefail

# record-hero.sh — Record marketing hero videos (dark + light mode).
#
# 1. Runs the Playwright recording script to capture .webm videos
# 2. Converts them to optimized .mp4 (H.264, silent, web-ready)
# 3. Copies output to the marketing site's public/ directory
#
# Data is auto-seeded via VITE_SEED=marketing — no setup appears in the video.
#
# Prerequisites:
#   - ffmpeg installed (brew install ffmpeg)
#   - Dev server running on :1420, or it will be auto-started by Playwright
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

# Run Playwright — VITE_SEED=marketing auto-populates the app with demo data
cd "$DESKTOP_DIR"
VITE_TEST_MODE=true VITE_SEED=marketing npx playwright test e2e/record-hero.spec.ts \
  --project=recording \
  --timeout=120000 \
  --reporter=list

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

  # H.264, no audio, web-optimized (faststart moves moov atom to front for streaming)
  ffmpeg -y -i "$input" \
    -c:v libx264 \
    -preset slow \
    -crf 23 \
    -an \
    -pix_fmt yuv420p \
    -vf "scale=1280:-2:flags=lanczos" \
    -movflags +faststart \
    "$output" \
    -loglevel warning

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

echo ""
echo "Done! Videos are at:"
echo "  $MARKETING_PUBLIC/pikos-hero-dark.mp4"
echo "  $MARKETING_PUBLIC/pikos-hero-light.mp4"
