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

import { describe, expect, it, vi } from "vitest";

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

const CORRUPT = { kind: "Corrupt", message: "corrupt: database disk image is malformed" };

/** A fresh copy of the module, since what it learns about damage lasts the session. */
async function freshAdapter(fail: (command: string) => boolean) {
  vi.resetModules();
  const mod = await import("./TauriSQLiteAdapter");
  const sent: string[] = [];
  mod.setCommandTransport(<T>(command: string) => {
    sent.push(command);
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain { kind, message } object
    return (fail(command) ? Promise.reject(CORRUPT) : Promise.resolve(null)) as Promise<T>;
  });
  return { adapter: new mod.TauriSQLiteAdapter(), mod, sent };
}

describe("a workspace found damaged mid-session", () => {
  it("is reported once, from whichever command found it", async () => {
    const { adapter, mod } = await freshAdapter((cmd) => cmd === "get_page");
    const heard = vi.fn();
    mod.onWorkspaceDamaged(heard);

    await expect(adapter.getPage("p1")).rejects.toMatchObject({ kind: "Corrupt" });
    await expect(adapter.getPage("p2")).rejects.toMatchObject({ kind: "Corrupt" });

    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0]![0]).toMatchObject({ kind: "Corrupt" });
  });

  it("closes the workspace and lets no further write reach it", async () => {
    const { adapter, sent } = await freshAdapter((cmd) => cmd === "get_page");

    await adapter.getPage("p1").catch(() => {});
    await expect(adapter.updatePage("p1", { title: "x" })).rejects.toMatchObject({
      kind: "Corrupt",
    });

    expect(sent).toContain("close_damaged_workspace");
    expect(sent).not.toContain("update_page");
  });

  it("still lets a backup be put back", async () => {
    const { adapter, sent } = await freshAdapter((cmd) => cmd === "get_page");

    await adapter.getPage("p1").catch(() => {});
    await adapter.restoreBackup("pre-migration-x.sqlite");

    expect(sent).toContain("restore_backup");
  });

  it("is not raised by a damaged backup, which is a different file", async () => {
    const { adapter, mod, sent } = await freshAdapter((cmd) => cmd === "restore_backup");
    const heard = vi.fn();
    mod.onWorkspaceDamaged(heard);

    await adapter.restoreBackup("pre-migration-x.sqlite").catch(() => {});

    expect(heard).not.toHaveBeenCalled();
    expect(sent).not.toContain("close_damaged_workspace");
  });
});
