// Plants desktop seed scenarios into a workspace file outside the app, through
// the same adapter and Rust writers the developer menu's reset-and-seed uses.
// Run through scripts/seed-ios-simulator.sh, which builds and aliases it.

import { SEED_LOADERS, type SeedName, type SeedScenario } from "@seeds/seedLoaders";

import { TauriSQLiteAdapter } from "@/shared/adapters/TauriSQLiteAdapter";

import { startRunner, stopRunner } from "./invoke";

/** Written against the in-memory mock adapter, so it cannot reach a real file. */
const MOCK_ONLY: ReadonlySet<string> = new Set<Exclude<SeedName, SeedScenario>>([
  "marketing",
  "marketing-sync",
]);

function isScenario(name: string): name is SeedScenario {
  return name in SEED_LOADERS && !MOCK_ONLY.has(name);
}

const [runnerBinary, dbPath, ...names] = process.argv.slice(2);
const unknown = names.filter((name) => !isScenario(name));

if (
  runnerBinary === undefined ||
  dbPath === undefined ||
  names.length === 0 ||
  unknown.length > 0
) {
  if (unknown.length > 0) process.stderr.write(`Unknown scenario: ${unknown.join(", ")}\n`);
  process.stderr.write(
    "usage: seed-workspace <runner-binary> <workspace.sqlite> <scenario>...\n" +
      `scenarios: ${Object.keys(SEED_LOADERS).filter(isScenario).join(", ")}\n`
  );
  process.exit(2);
}

startRunner(runnerBinary, dbPath);
const adapter = new TauriSQLiteAdapter();
try {
  for (const name of names.filter(isScenario)) {
    await SEED_LOADERS[name]({ adapter, phase: "reset", setPendingNavigation: () => {} });
    process.stdout.write(`seeded ${name}\n`);
  }
} finally {
  await stopRunner();
}
