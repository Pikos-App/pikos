// Asks the TypeScript `snapAnchorToRule` directly; arguments are (rrule, anchor) pairs.
//
//   pnpm --filter @pikos/core probe:snap -- "FREQ=DAILY;BYHOUR=14" "2026-03-15T09:00:00"

import { snapAnchorToRule } from "../../src/utils/recurrence";

function main(): void {
  // pnpm forwards its own `--` separator; drop it so the pairing lines up.
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  for (let i = 0; i + 1 < args.length; i += 2) {
    const rrule = args[i]!;
    const anchor = args[i + 1]!;
    let rendered: string;
    try {
      rendered = JSON.stringify(snapAnchorToRule(rrule, anchor));
    } catch (error) {
      rendered = `threw ${error instanceof Error ? error.message : String(error)}`;
    }
    process.stdout.write(`${rrule} @ ${anchor} -> ${rendered}\n`);
  }
}

main();
