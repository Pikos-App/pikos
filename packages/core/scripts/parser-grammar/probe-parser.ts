// Asks the TypeScript quick-add parser directly, for what it does just outside the corpus (does a
// day list keep its order? what does an empty tag do?), so the Rust port answers from the
// reference, not a guess:
//
//   pnpm --filter @pikos/core probe:parser -- "every friday and monday"
//
// The reference defaults to the corpus's sun_noon; override with PROBE_REF.

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
