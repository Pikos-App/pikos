// Trace what each of chrono's parsers and refiners did to one string.
//
// chrono takes a `debug` handler and calls it with a closure per decision:
// which parser extracted what, which refiner merged or dropped what. When two
// implementations disagree on a string, this says where they parted company —
// far faster than bisecting the input.
//
//   pnpm --filter @pikos/core probe:trace -- "may 2 to 10 2026-04-01"

import { createRequire } from "node:module";

import type * as ChronoNode from "chrono-node";

const chrono = createRequire(import.meta.url)("chrono-node") as typeof ChronoNode;

function main(): void {
  const ref = new Date(process.env["PROBE_REF"] ?? "2026-03-15T12:00:00");
  for (const text of process.argv.slice(2).filter((a) => a !== "--")) {
    process.stdout.write(`\n=== ${JSON.stringify(text)} ===\n`);
    const results = chrono.parse(text, ref, {
      debug: (block: () => void) => block(),
      forwardDate: true,
    } as Parameters<typeof chrono.parse>[2]);
    for (const r of results) {
      process.stdout.write(
        `RESULT idx=${r.index} text=${JSON.stringify(r.text)} start=${r.start.date().toISOString()}\n`
      );
    }
  }
}

main();
