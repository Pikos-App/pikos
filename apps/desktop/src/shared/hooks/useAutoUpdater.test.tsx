import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppSettingsProvider } from "@/shared/context/AppSettingsContext";
import { onFlushPending } from "@/shared/pendingWrites";

import { useAutoUpdater } from "./useAutoUpdater";

const check = vi.fn<() => Promise<unknown>>();
const downloadAndInstall = vi.fn<() => Promise<void>>();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (): Promise<unknown> => check(),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
}));

function wrapper({ children }: { children: ReactNode }) {
  return <AppSettingsProvider>{children}</AppSettingsProvider>;
}

beforeEach(() => {
  vi.stubEnv("VITE_TEST_MODE", "false");
  vi.stubEnv("DEV", false);
  vi.stubGlobal("__PIKOS_BENCH__", false);
  vi.stubGlobal("__PIKOS_STAGING__", false);
  localStorage.clear();
  localStorage.setItem("pikos:autoUpdateEnabled", "false");
  check.mockReset();
  downloadAndInstall.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("bench build", () => {
  it("never asks GitHub for the update manifest", async () => {
    vi.stubGlobal("__PIKOS_BENCH__", true);
    check.mockResolvedValue(null);

    const { result } = renderHook(() => useAutoUpdater(), { wrapper });

    await act(async () => {
      result.current.checkForUpdates();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(check).not.toHaveBeenCalled();
    expect(result.current.status.state).toBe("idle");
  });
});

describe("staging build", () => {
  it("never checks for an update", async () => {
    vi.stubGlobal("__PIKOS_STAGING__", true);
    check.mockResolvedValue(null);

    const { result } = renderHook(() => useAutoUpdater(), { wrapper });

    await act(async () => {
      result.current.checkForUpdates();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(check).not.toHaveBeenCalled();
    expect(result.current.status.state).toBe("idle");
  });
});

describe("doCheck error path", () => {
  it("tags errors with scope='check' and shows generic copy", async () => {
    check.mockRejectedValueOnce(
      new Error("error fetching https://releases.pikos.app/latest.json — ECONNREFUSED")
    );

    const { result } = renderHook(() => useAutoUpdater(), { wrapper });

    await act(async () => {
      result.current.checkForUpdates();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status.state).toBe("error");
    if (result.current.status.state !== "error") return;
    expect(result.current.status.scope).toBe("check");
    expect(result.current.status.message).not.toContain("releases.pikos.app");
    expect(result.current.status.message).not.toContain("ECONNREFUSED");
    expect(result.current.status.message.toLowerCase()).toContain("network");
  });
});

describe("doInstall error path", () => {
  it("tags errors with scope='install' so the modal can surface them", async () => {
    check
      .mockResolvedValueOnce({
        body: "notes",
        date: undefined,
        downloadAndInstall: (): Promise<void> => downloadAndInstall(),
        version: "1.2.3",
      })
      .mockRejectedValueOnce(
        new Error("download failed: https://releases.pikos.app/Pikos_1.2.3_aarch64.dmg")
      );

    const { result } = renderHook(() => useAutoUpdater(), { wrapper });

    await act(async () => {
      result.current.checkForUpdates();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status.state).toBe("available");

    await act(async () => {
      result.current.installUpdate();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status.state).toBe("error");
    if (result.current.status.state !== "error") return;
    expect(result.current.status.scope).toBe("install");
    expect(result.current.status.message).not.toContain("releases.pikos.app");
    expect(result.current.status.message).not.toContain(".dmg");
    expect(result.current.status.message.toLowerCase()).toContain("install");
  });
});

// Relaunch restarts the process without closing the window, so the write queue's close-time flush
// never runs: "Update now" with an editor open would drop what sits on the debounce.
describe("doInstall flushes pending writes first", () => {
  it("drains unwritten edits before the installer runs", async () => {
    const order: string[] = [];
    const off = onFlushPending(() => void order.push("flush"));
    downloadAndInstall.mockImplementation(() => {
      order.push("install");
      return Promise.resolve();
    });

    const update = {
      body: "notes",
      date: undefined,
      downloadAndInstall: (): Promise<void> => downloadAndInstall(),
      version: "1.2.3",
    };
    check.mockResolvedValueOnce(update).mockResolvedValueOnce(update);

    const { result } = renderHook(() => useAutoUpdater(), { wrapper });

    await act(async () => {
      result.current.checkForUpdates();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status.state).toBe("available");

    await act(async () => {
      result.current.installUpdate();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    expect(order).toEqual(["flush", "install"]);
    off();
  });
});
