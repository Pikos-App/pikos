import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { StorageAdapter } from "@pikos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteAllData } from "./deleteAllData";

const invoke = vi.fn<(cmd: string) => Promise<unknown>>();
const relaunch = vi.fn<() => Promise<void>>();

const storage = {
  releaseSyncCredentials: () => invoke("release_sync_credentials").then(() => undefined),
  wipeAllData: () => invoke("wipe_app_data").then(() => undefined),
} as unknown as StorageAdapter;
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

vi.mock("@/shared/platform", () => ({
  getPlatform: () => ({ relaunch: (): Promise<void> => relaunch() }),
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
  // qa: TRASH-08:3
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

    await deleteAllData(storage);

    expect(invoke).toHaveBeenCalledWith("wipe_app_data");
    expect(storeClear).toHaveBeenCalledTimes(1);
    expect(storeSave).toHaveBeenCalledTimes(1);
    // Release runs first: the account ids it keys on live in the DB the wipe deletes.
    expect(order).toEqual([
      "invoke:release_sync_credentials",
      "invoke:wipe_app_data",
      "store.clear",
      "store.save",
      "relaunch",
    ]);
  });

  it("still wipes when releasing sync credentials fails", async () => {
    invoke.mockImplementation((cmd) =>
      cmd === "release_sync_credentials"
        ? Promise.reject(new Error("keychain unavailable"))
        : Promise.resolve(undefined)
    );

    await deleteAllData(storage);

    expect(invoke).toHaveBeenCalledWith("wipe_app_data");
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("clears only pikos:* localStorage keys", async () => {
    localStorage.setItem("pikos:theme", "dark");
    localStorage.setItem("pikos:listSort", "manual");
    localStorage.setItem("other-app:foo", "keep");

    await deleteAllData(storage);

    expect(localStorage.getItem("pikos:theme")).toBeNull();
    expect(localStorage.getItem("pikos:listSort")).toBeNull();
    expect(localStorage.getItem("other-app:foo")).toBe("keep");
  });

  it("still relaunches if clearing the store fails", async () => {
    load.mockRejectedValue(new Error("store unavailable"));

    await deleteAllData(storage);

    expect(invoke).toHaveBeenCalledWith("wipe_app_data");
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("falls back to emptying the workspaces key when clear() is denied", async () => {
    // clear() throws without store:allow-clear in capabilities; the fallback must still empty the
    // store so the relaunch reseeds.
    storeClear.mockRejectedValue(new Error("store.clear not allowed"));

    await deleteAllData(storage);

    expect(storeSet).toHaveBeenCalledWith("workspaces", []);
    expect(storeSave).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});

// Capabilities are Tauri config the mocked tests don't exercise; guard against config drift
// removing the grant.
describe("capabilities", () => {
  it("grants store:allow-clear (required by deleteAllData)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const capPath = join(here, "../../../src-tauri/capabilities/default.json");
    const cap = JSON.parse(readFileSync(capPath, "utf8")) as { permissions: unknown[] };
    expect(cap.permissions).toContain("store:allow-clear");
  });
});
