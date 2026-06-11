import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppSettingsProvider } from "@/shared/context/AppSettingsContext";

import { useAutoUpdater } from "./useAutoUpdater";

// ─── Mocks ────────────────────────────────────────────────────────────────
//
// useAutoUpdater dynamically imports @tauri-apps/plugin-updater inside doCheck
// and doInstall. We mock both the dynamic import target and import.meta.env
// flags so the hook actually exercises its check/install branches under test.

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
  // The hook short-circuits in DEV and TEST_MODE — disable both so the real
  // check/install branches run.
  vi.stubEnv("VITE_TEST_MODE", "false");
  vi.stubEnv("DEV", false);
  localStorage.clear();
  // Disable auto-check-on-mount so each test controls which mocked check()
  // call its explicit checkForUpdates() consumes.
  localStorage.setItem("pikos:autoUpdateEnabled", "false");
  check.mockReset();
  downloadAndInstall.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  localStorage.clear();
});

describe("doCheck error path", () => {
  it("tags errors with scope='check' and shows generic copy", async () => {
    // Plugin throws an error whose .message includes a Releases URL — this is
    // exactly what the audit fixed: such messages can echo response bodies.
    check.mockRejectedValueOnce(
      new Error("error fetching https://releases.pikos.app/latest.json — ECONNREFUSED")
    );

    const { result } = renderHook(() => useAutoUpdater(), { wrapper });

    await act(async () => {
      result.current.checkForUpdates();
      // flush the awaited dynamic import + check()
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
    // First check() resolves with an available update so the hook reaches
    // the "available" state. The second check() inside doInstall throws.
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
    // Raw URL from the rejected error must not leak into the user-facing copy.
    expect(result.current.status.message).not.toContain("releases.pikos.app");
    expect(result.current.status.message).not.toContain(".dmg");
    expect(result.current.status.message.toLowerCase()).toContain("install");
  });
});
