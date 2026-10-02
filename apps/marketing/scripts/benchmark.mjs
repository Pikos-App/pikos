// Measures the database figures /speed shows and writes them to src/data/benchmark.json.
//
//   node apps/marketing/scripts/benchmark.mjs [--pikos <binary>] [--dir <scratch dir>] [--runs N]
//
// Times each corpus size with `pikos stress bench --runs N`: the database calls under the app,
// without the window. benchmark-app.mjs times the app itself.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { arg, conditions, corpus, rest, ROOT, run, SIZES } from "./lib/conditions.mjs";

const OUT = join(ROOT, "apps/marketing/src/data/benchmark.json");
const pikos = arg("--pikos", join(ROOT, "target/release/pikos"));
const dir = arg("--dir", join(tmpdir(), "pikos-bench"));
const runs = Number(arg("--runs", "200"));
mkdirSync(dir, { recursive: true });

const corpora = [];
for (const [i, pages] of SIZES.entries()) {
  const db = corpus(pikos, dir, pages);
  if (i > 0) rest();
  console.log(`timing ${pages} pages, ${runs} runs`);
  const bench = JSON.parse(
    run(pikos, ["--db", db, "stress", "bench", "--runs", String(runs), "--json"])
  );
  corpora.push({
    seeded: pages,
    pages: bench.pages,
    ops: Object.fromEntries(
      bench.timings.map((t) => [t.op, { ms: t.ms, p99: t.p99_ms, max: t.max_ms, runs: t.runs }])
    ),
  });
}

writeFileSync(OUT, `${JSON.stringify({ ...conditions(), runs, corpora }, null, 2)}\n`);
console.log(`wrote ${OUT}`);
