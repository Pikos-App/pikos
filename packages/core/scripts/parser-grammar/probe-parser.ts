// Ask the TypeScript quick-add parser directly.
//
// The corpus says what `parseInput` does for the 317 inputs it happens to
// contain. When the Rust port needs to know what it does just outside that —
// does a day list keep the order it was typed? what does an empty tag do? —
// this asks, so the answer comes from the reference rather than from a guess:
//
//   pnpm --filter @pikos/core probe:parser -- "every friday and monday"
//
// Reference defaults to the corpus's sun_noon; override with PROBE_REF.

import { parseInput } from "../../src/nlp/parser";

function main(): void {
  const ref = new Date(process.env["PROBE_REF"] ?? "2026-03-15T12:00:00");
  for (const input of process.argv.slice(2)) {
    let rendered: string;
    try {
      rendered = JSON.stringify(parseInput(input, ref));
    } catch (error) {
      rendered = `threw ${error instanceof Error ? error.message : String(error)}`;
    }
    process.stdout.write(`${JSON.stringify(input)} -> ${rendered}\n`);
  }
}

main();
