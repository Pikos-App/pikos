#!/usr/bin/env node
// Regenerate every committed rendering of the design tokens from @pikos/ui.
//
// The token *values* live in packages/ui/src/tokens.ts as typed data, because a
// stylesheet is readable by exactly one renderer and the phone app needs the same
// palette. This script is the build step for each renderer:
//
//   apps/desktop/src/app.css            the token tiers, spliced between markers
//   packages/editor-mobile/src/editor.css   the colour block, spliced between markers
//   PikosSupport/DesignTokens.swift     the native palette, whole file
//   Assets.xcassets/*.colorset          the colours UIKit reads before Swift runs
//
// Everything outside the markers in the two stylesheets stays hand-authored.
//
// Usage:
//   node scripts/gen-ui-tokens.mjs            rewrite every target in place
//   node scripts/gen-ui-tokens.mjs --check    exit 1 if any target is out of date
//
// --check compares content rather than shelling out to `git diff`: two targets are
// regions of files other people also edit by hand, and comparing the rendered
// region catches both halves of the drift — a token edited without regenerating,
// and a target hand-edited inside the markers — without tripping over unrelated
// working-tree changes.
//
// The imports below reach straight into the package's TypeScript source; Node
// strips the types on load (>= 22.18), which is why the relative imports inside
// packages/ui carry explicit .ts extensions.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderTokenCssBlock, TOKEN_CSS_END, TOKEN_CSS_START } from "../packages/ui/src/css.ts";
import {
  EDITOR_CSS_END,
  EDITOR_CSS_PATH,
  EDITOR_CSS_START,
  renderAssetColors,
  renderEditorCssBlock,
  renderSwiftTokens,
  SWIFT_TOKENS_PATH,
} from "../packages/ui/src/swift.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Replace the marked region of `text` with `block`, which carries its own markers. */
function splice(text, rel, startMarker, endMarker, block) {
  const lines = text.split("\n");
  const first = startMarker.split("\n")[0];
  const start = lines.findIndex((l) => l === first);
  const end = lines.findIndex((l) => l === endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `${rel} is missing the GENERATED token markers. Expected a block opening with\n` +
        `  ${first}\nand closing with\n  ${endMarker}`
    );
  }
  return [...lines.slice(0, start), block, ...lines.slice(end + 1)].join("\n");
}

const read = (rel) => {
  const path = join(ROOT, rel);
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
};

const targets = [
  {
    next: (current) =>
      splice(current, "apps/desktop/src/app.css", TOKEN_CSS_START, TOKEN_CSS_END, renderTokenCssBlock()),
    rel: "apps/desktop/src/app.css",
  },
  {
    next: (current) =>
      splice(current, EDITOR_CSS_PATH, EDITOR_CSS_START, EDITOR_CSS_END, renderEditorCssBlock()),
    rel: EDITOR_CSS_PATH,
  },
  { next: () => renderSwiftTokens(), rel: SWIFT_TOKENS_PATH },
  ...renderAssetColors().map((asset) => ({ next: () => asset.contents, rel: asset.path })),
];

const check = process.argv.includes("--check");
let stale = false;

for (const target of targets) {
  const current = read(target.rel);
  const next = target.next(current);
  if (current === next) continue;

  if (check) {
    // Point at the first line that differs — enough to see which token moved.
    const a = current.split("\n");
    const b = next.split("\n");
    const i = a.findIndex((line, n) => line !== b[n]);
    console.error(`${target.rel} is out of date with packages/ui/src/tokens.ts.`);
    console.error(`  first difference at line ${i + 1}:`);
    console.error(`    committed: ${a[i] ?? "<end of file>"}`);
    console.error(`    generated: ${b[i] ?? "<end of file>"}`);
    stale = true;
    continue;
  }

  mkdirSync(dirname(join(ROOT, target.rel)), { recursive: true });
  writeFileSync(join(ROOT, target.rel), next);
  console.log(`Regenerated ${target.rel}.`);
}

if (stale) {
  console.error(`Run \`node scripts/gen-ui-tokens.mjs\` and commit the result.`);
  process.exit(1);
}
