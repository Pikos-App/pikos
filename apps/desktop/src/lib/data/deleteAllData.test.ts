import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteAllData } from "./deleteAllData";

// ─── Mocks ────────────────────────────────────────────────────────────────
//
// deleteAllData drives three Tauri boundaries: the wipe_app_data command, the
// plugin-store (to neutralize the exit-save that would otherwise resurrect the
// old workspace), and relaunch. We mock all three and assert the order of
// effects — the store must be cleared so the relaunched app boots first-run and
// reseeds the tutorial.

const invoke = vi.fn<(cmd: string) => Promise<unknown>>();
const relaunch = vi.fn<() => Promise<void>>();
const storeClear = vi.fn<() => Promise<void>>();
const storeSet = vi.fn<(key: string, value: unknown) => Promise<void>>();
const storeSave = vi.fn<() => Promise<void>>();
const load = vi.fn<
  () => Promise<{
    clear: () => Promise<void>;
    set: (key: string, value: unknown) => Promise<void>;
    save: () => Promise<void>;
  }>
>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string): Promise<unknown> => invoke(cmd),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (): Promise<void> => relaunch(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: (): Promise<unknown> => load(),
}));

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  relaunch.mockReset().mockResolvedValue(undefined);
  storeClear.mockReset().mockResolvedValue(undefined);
  storeSet.mockReset().mockResolvedValue(undefined);
  storeSave.mockReset().mockResolvedValue(undefined);
  load.mockReset().mockResolvedValue({ clear: storeClear, save: storeSave, set: storeSet });
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("deleteAllData", () => {
  it("wipes disk, then clears the workspaces store so relaunch reseeds, then relaunches", async () => {
    const order: string[] = [];
    invoke.mockImplementation((cmd) => {
      order.push(`invoke:${cmd}`);
      return Promise.resolve(undefined);
    });
    storeClear.mockImplementation(() => {
      order.push("store.clear");
      return Promise.resolve();
    });
    storeSave.mockImplementation(() => {
      order.push("store.save");
      return Promise.resolve();
    });
    relaunch.mockImplementation(() => {
      order.push("relaunch");
      return Promise.resolve();
    });

    await deleteAllData();

    expect(invoke).toHaveBeenCalledWith("wipe_app_data");
    // The store clear must happen so the plugin's exit-save can't write the old
    // workspace back — that's what forces the first-run tutorial reseed.
    expect(storeClear).toHaveBeenCalledTimes(1);
    expect(storeSave).toHaveBeenCalledTimes(1);
    // Order: wipe → clear+save store → relaunch.
    expect(order).toEqual(["invoke:wipe_app_data", "store.clear", "store.save", "relaunch"]);
  });

  it("clears only pikos:* localStorage keys", async () => {
    localStorage.setItem("pikos:theme", "dark");
    localStorage.setItem("pikos:listSort", "manual");
    localStorage.setItem("other-app:foo", "keep");

    await deleteAllData();

    expect(localStorage.getItem("pikos:theme")).toBeNull();
    expect(localStorage.getItem("pikos:listSort")).toBeNull();
    expect(localStorage.getItem("other-app:foo")).toBe("keep");
  });

  it("still relaunches if clearing the store fails", async () => {
    load.mockRejectedValue(new Error("store unavailable"));

    await deleteAllData();

    expect(invoke).toHaveBeenCalledWith("wipe_app_data");
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("falls back to emptying the workspaces key when clear() is denied", async () => {
    // Regression: store:allow-clear was once missing from capabilities, so
    // clear() threw and the old workspace was resurrected on exit-save. The
    // fallback must still empty the store so the relaunch reseeds.
    storeClear.mockRejectedValue(new Error("store.clear not allowed"));

    await deleteAllData();

    expect(storeSet).toHaveBeenCalledWith("workspaces", []);
    expect(storeSave).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});

// The reseed-on-delete-all flow depends on store.clear() being permitted at
// runtime. Capabilities are Tauri config, not exercised by the mocked tests
// above, so guard against config drift removing the grant.
describe("capabilities", () => {
  it("grants store:allow-clear (required by deleteAllData)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const capPath = join(here, "../../../src-tauri/capabilities/default.json");
    const cap = JSON.parse(readFileSync(capPath, "utf8")) as { permissions: unknown[] };
    expect(cap.permissions).toContain("store:allow-clear");
  });
});
