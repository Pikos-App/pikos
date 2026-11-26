#!/usr/bin/env bash
set -euo pipefail

# Build the mobile editor and place it where the iOS package expects it. Runs anywhere Node
# runs. Run after cloning and after changing packages/editor-mobile or packages/editor-schema.
# The output is gitignored.
#
# One HTML file with JS and CSS inlined: the webview loads it through a WKURLSchemeHandler whose
# callbacks run on the main thread, so each extra request is a hop through the thread typing needs.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/apps/ios/PikosEditorBridge/Sources/PikosEditorBridge/Resources"

echo "▶ building @pikos/editor-mobile"
(cd "$ROOT" && pnpm --filter @pikos/editor-mobile build)

SRC="$ROOT/packages/editor-mobile/dist/index.html"
[ -f "$SRC" ] || { echo "error: $SRC was not produced" >&2; exit 1; }

# The vite inliner already fails on an external reference. Re-checked here because a stray
# <script src> would 404 silently in the webview and leave the editor blank with nothing logged.
if grep -Eq '<script[^>]*src=|<link[^>]*rel="stylesheet"' "$SRC"; then
  echo "error: the built editor still references external files" >&2
  exit 1
fi

mkdir -p "$DEST"
cp "$SRC" "$DEST/editor.html"

BYTES=$(wc -c < "$DEST/editor.html" | tr -d ' ')
echo "✓ $DEST/editor.html ($(( BYTES / 1024 )) KB)"
echo "  Cold-load time is measured on device — EditorWebView reports it via onReady."
