#!/usr/bin/env bash
set -euo pipefail

# Build the mobile editor and place it where the iOS package expects it.
#
# Runs anywhere Node runs — no Xcode needed. The output is a single HTML file
# with the JavaScript and CSS inlined, because the webview loads it through a
# WKURLSchemeHandler whose callbacks run on the main thread: one request means
# one hop through the thread that has to stay responsive for typing, which is
# what M0's cold-load bar (< 300 ms on iPhone 12-class hardware) measures.
#
# The output is a build artifact and is gitignored. Run it after cloning, and
# again after changing anything under packages/editor-mobile or
# packages/editor-schema.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/apps/ios/PikosEditorBridge/Sources/PikosEditorBridge/Resources"

echo "▶ building @pikos/editor-mobile"
(cd "$ROOT" && pnpm --filter @pikos/editor-mobile build)

SRC="$ROOT/packages/editor-mobile/dist/index.html"
[ -f "$SRC" ] || { echo "error: $SRC was not produced" >&2; exit 1; }

# The inliner in vite.config.ts already fails the build on a surviving external
# reference. Re-checked here because the consequence lands far from the cause:
# a stray <script src> would 404 silently inside the webview and the editor
# would come up blank with nothing in the logs to explain it.
if grep -Eq '<script[^>]*src=|<link[^>]*rel="stylesheet"' "$SRC"; then
  echo "error: the built editor still references external files" >&2
  exit 1
fi

mkdir -p "$DEST"
cp "$SRC" "$DEST/editor.html"

BYTES=$(wc -c < "$DEST/editor.html" | tr -d ' ')
echo "✓ $DEST/editor.html ($(( BYTES / 1024 )) KB)"
echo "  Cold-load time is measured on device — EditorWebView reports it via onReady."
