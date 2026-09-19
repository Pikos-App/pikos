#!/usr/bin/env node
// Regenerate the design-token tiers of apps/desktop/src/app.css from @pikos/ui.
//
// The token *values* live in packages/ui/src/tokens.ts as typed data, because a
// Tailwind v4 stylesheet is readable by exactly one renderer and the mobile app
// will need the same palette. This script is the web renderer's build step: it
// splices `renderTokenCss()` between the GENERATED markers in app.css and leaves
// everything outside them — the imports, keyframes, @layer base, the type-scale
// utilities, the calendar event-block rules — hand-authored and untouched.
//
// Usage:
//   node scripts/gen-ui-tokens.mjs            rewrite app.css in place
//   node scripts/gen-ui-tokens.mjs --check    exit 1 if app.css is out of date
//
// --check compares content rather than shelling out to `git diff` (the shape the
// bindings and wasm gates use): those regenerate whole directories, where git is
// the only practical differ, while this one owns a single region of a file other
// people also edit by hand. Comparing the rendered region catches both halves of
// the drift — a token edited without regenerating, and app.css hand-edited
// inside the markers — without ever tripping over unrelated working-tree changes.
//
// The import below reaches straight into the package's TypeScript source; Node
// strips the types on load (>= 22.18), which is why the relative imports inside
// packages/ui carry explicit .ts extensions.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderTokenCssBlock, TOKEN_CSS_END, TOKEN_CSS_START } from "../packages/ui/src/css.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "apps/desktop/src/app.css");
const REL = "apps/desktop/src/app.css";

const START_FIRST_LINE = TOKEN_CSS_START.split("\n")[0];

/** Replace the marked region of `css` with a freshly rendered one. */
function regenerate(css) {
  const lines = css.split("\n");
  const start = lines.findIndex((l) => l === START_FIRST_LINE);
  const end = lines.findIndex((l) => l === TOKEN_CSS_END);

  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `${REL} is missing the GENERATED token markers. Expected a block opening with\n` +
        `  ${START_FIRST_LINE}\nand closing with\n  ${TOKEN_CSS_END}`
    );
  }

  return [...lines.slice(0, start), renderTokenCssBlock(), ...lines.slice(end + 1)].join("\n");
}

const current = readFileSync(TARGET, "utf-8");
const next = regenerate(current);

if (process.argv.includes("--check")) {
  if (current === next) process.exit(0);

  // Point at the first line that differs — enough to see which token moved.
  const a = current.split("\n");
  const b = next.split("\n");
  const i = a.findIndex((line, n) => line !== b[n]);
  console.error(`${REL} is out of date with packages/ui/src/tokens.ts.`);
  console.error(`  first difference at line ${i + 1}:`);
  console.error(`    committed: ${a[i] ?? "<end of file>"}`);
  console.error(`    generated: ${b[i] ?? "<end of file>"}`);
  console.error(`Run \`node scripts/gen-ui-tokens.mjs\` and commit the result.`);
  process.exit(1);
}

if (current !== next) {
  writeFileSync(TARGET, next);
  console.log(`Regenerated the token block in ${REL}.`);
}
