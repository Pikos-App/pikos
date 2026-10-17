// Ask chrono a question directly.
//
// The corpora say what chrono does for the expressions the parser corpus
// happens to contain. When the Rust engine needs to know what it does for
// something just outside that — is a bare "may" a month? does "18-25" without a
// month parse? — this asks, rather than guessing from the corpus:
//
//   pnpm --filter @pikos/core probe:chrono -- "may day" "trip 18-25"
//
// Reference defaults to the corpus's sun_noon; override with PROBE_REF.

import { createRequire } from "node:module";

import type * as ChronoNode from "chrono-node";

const chrono = createRequire(import.meta.url)("chrono-node") as typeof ChronoNode;

const GRANULARITIES = ["hour", "minute", "second", "day", "month", "year", "weekday"] as const;

function localIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function main(): void {
  const ref = new Date(process.env["PROBE_REF"] ?? "2026-03-15T12:00:00");
  for (const text of process.argv.slice(2)) {
    const results = chrono.parse(text, ref, { forwardDate: true });
    if (results.length === 0) {
      process.stdout.write(`${JSON.stringify(text)} -> no match\n`);
      continue;
    }
    for (const r of results) {
      const certain = GRANULARITIES.filter((g) => r.start.isCertain(g)).join(",");
      const end = r.end
        ? ` end=${localIso(r.end.date())} ` +
          `[${GRANULARITIES.filter((g) => r.end!.isCertain(g)).join(",")}]`
        : "";
      process.stdout.write(
        `${JSON.stringify(text)} -> idx=${r.index} text=${JSON.stringify(r.text)} ` +
          `start=${localIso(r.start.date())} [${certain}]${end}\n`
      );
    }
  }
}

main();
