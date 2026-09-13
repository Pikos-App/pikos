// The adapter's own logic, which sits above every command and below every caller.
//
// Only one thing here is worth pinning and it is the write/read classification.
// A mutating command left out of `WRITE_COMMANDS` still works — it just lets the
// DB watcher mistake the app's own echo for someone else's write and refetch the
// workspace on top of the user's action. Nothing fails, nothing logs; the user sees
// a flicker after a bulk complete or a drag. So the test here is "is every command
// classified at all" — whether a classification is *true* depends on what the Rust
// handler does, and is proved by driving it (`db/ipc_tests.rs`).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { READ_COMMANDS, WRITE_COMMANDS } from "./TauriSQLiteAdapter";

const SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "./TauriSQLiteAdapter.ts"),
  "utf8"
);

/** Every command name the adapter actually invokes. Read from the source because
 *  the point is to catch a command someone adds without classifying it — a list
 *  maintained by hand would go stale in exactly that case. */
function invokedCommands(): string[] {
  const names = [...SOURCE.matchAll(/\binvoke<[^>]*>\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
  return [...new Set(names)].sort();
}

describe("TauriSQLiteAdapter command classification", () => {
  it("invokes a non-trivial number of commands", () => {
    expect(invokedCommands().length).toBeGreaterThan(40);
  });

  it("classifies every command it invokes as a read or a write", () => {
    const unclassified = invokedCommands().filter(
      (cmd) => !WRITE_COMMANDS.has(cmd) && !READ_COMMANDS.has(cmd)
    );
    expect(unclassified).toEqual([]);
  });

  it("never classifies a command as both", () => {
    const both = [...WRITE_COMMANDS].filter((cmd) => READ_COMMANDS.has(cmd));
    expect(both).toEqual([]);
  });

  it("lists no command it does not invoke", () => {
    const invoked = new Set(invokedCommands());
    const stale = [...WRITE_COMMANDS, ...READ_COMMANDS].filter((cmd) => !invoked.has(cmd));
    expect(stale).toEqual([]);
  });
});
