import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Captures the handler the hook subscribes so a test can fire a sync pass.
const passHandlers: Array<() => void> = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: () => void) => {
    if (event === "calendar-sync:pass") passHandlers.push(handler);
    return Promise.resolve(() => {});
  },
}));

import { usePages } from "@/shared/context/PagesContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

import { useCalendarSync } from "./useCalendarSync";

const CONN = {
  baseUrl: "https://caldav.example.com",
  displayName: "me@example.com · caldav.example.com",
  password: "app-pw",
  username: "me@example.com",
};

function setup() {
  return renderHookWithProviders(() => useCalendarSync());
}

async function ready(hook: ReturnType<typeof setup>) {
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
}

beforeEach(() => {
  localStorage.clear();
  passHandlers.length = 0;
});

describe("useCalendarSync", () => {
  it("starts empty once the workspace is ready", async () => {
    const hook = setup();
    await ready(hook);
    expect(hook.result.current.accounts).toEqual([]);
  });

  it("connect adds an account with its discovered calendars", async () => {
    const hook = setup();
    await ready(hook);

    await act(async () => {
      await hook.result.current.connect(CONN);
    });

    expect(hook.result.current.accounts).toHaveLength(1);
    expect(hook.result.current.accounts[0]!.calendars).toHaveLength(2);
    expect(hook.result.current.accounts[0]!.calendars.every((c) => !c.enabled)).toBe(true);
  });

  it("toggleCalendar enables a calendar and materializes its folder", async () => {
    const hook = setup();
    await ready(hook);
    await act(async () => {
      await hook.result.current.connect(CONN);
    });

    const cal = hook.result.current.accounts[0]!.calendars[0]!;
    await act(async () => {
      await hook.result.current.toggleCalendar(cal.id, true, "#A8CDB4");
    });

    const updated = hook.result.current.accounts[0]!.calendars.find((c) => c.id === cal.id)!;
    expect(updated.enabled).toBe(true);
    expect(updated.color).toBe("#A8CDB4");
    expect(updated.folderId).not.toBeNull();
  });

  // Enabling a calendar only pokes the backfill, so the freshness that first sync
  // stamps lands after this hook's own post-toggle read. The pass event is what
  // pulls it in; without it the row sits on a pre-sync snapshot.
  it("re-reads the panel when a background pass completes", async () => {
    const hook = renderHookWithProviders(() => ({
      storage: useWorkspace().storage,
      sync: useCalendarSync(),
    }));
    await waitFor(() => expect(hook.result.current.sync.loading).toBe(false));
    await act(async () => {
      await hook.result.current.sync.connect(CONN);
    });
    const account = hook.result.current.sync.accounts[0]!;
    const cal = account.calendars[0]!;
    await act(async () => {
      await hook.result.current.sync.toggleCalendar(cal.id, true, "#A8CDB4");
    });
    const shown = () =>
      hook.result.current.sync.accounts[0]!.calendars.find((c) => c.id === cal.id)!;
    expect(shown().lastSyncedAt).toBeNull();

    // Out of band, as the background loop would: sync, then announce the pass.
    await act(async () => {
      await hook.result.current.storage!.resyncSyncAccount(account.id);
      passHandlers.forEach((h) => h());
    });

    await waitFor(() => expect(shown().lastSyncedAt).not.toBeNull());
  });

  it("recolorCalendar changes the colour without flipping enabled", async () => {
    const hook = setup();
    await ready(hook);
    await act(async () => {
      await hook.result.current.connect(CONN);
    });
    const cal = hook.result.current.accounts[0]!.calendars[0]!;

    await act(async () => {
      await hook.result.current.recolorCalendar(cal.id, "#E5534B");
    });

    const updated = hook.result.current.accounts[0]!.calendars.find((c) => c.id === cal.id)!;
    expect(updated.color).toBe("#E5534B");
    expect(updated.enabled).toBe(false);
  });

  it("recolorCalendar patches the enabled calendar's folder colour in place", async () => {
    const hook = renderHookWithProviders(() => ({
      pages: usePages(),
      sync: useCalendarSync(),
    }));
    await waitFor(() => expect(hook.result.current.sync.loading).toBe(false));
    await act(async () => {
      await hook.result.current.sync.connect(CONN);
    });
    const cal = hook.result.current.sync.accounts[0]!.calendars[0]!;
    await act(async () => {
      await hook.result.current.sync.toggleCalendar(cal.id, true, "#A8CDB4");
    });
    const folderId = hook.result.current.sync.accounts[0]!.calendars.find(
      (c) => c.id === cal.id
    )!.folderId!;

    await act(async () => {
      await hook.result.current.sync.recolorCalendar(cal.id, "#E5534B");
    });

    expect(hook.result.current.pages.folders.find((f) => f.id === folderId)?.color).toBe("#E5534B");
  });

  it("a sidebar recolour reaches the calendar, so the panel swatch follows it", async () => {
    const hook = renderHookWithProviders(() => ({
      pages: usePages(),
      sync: useCalendarSync(),
      ws: useWorkspace(),
    }));
    await waitFor(() => expect(hook.result.current.sync.loading).toBe(false));
    await act(async () => {
      await hook.result.current.sync.connect(CONN);
    });
    const account = hook.result.current.sync.accounts[0]!;
    const cal = account.calendars[0]!;
    await act(async () => {
      await hook.result.current.sync.toggleCalendar(cal.id, true, "#A8CDB4");
    });
    const folderId = hook.result.current.sync.accounts[0]!.calendars.find(
      (c) => c.id === cal.id
    )!.folderId!;

    await act(async () => {
      await hook.result.current.pages.updateFolder(folderId, { color: "#E5534B" });
    });

    const calendars = await hook.result.current.ws.storage!.listSyncCalendars(account.id);
    expect(calendars.find((c) => c.id === cal.id)?.color).toBe("#E5534B");
  });

  it("resync records per-calendar results and clears the busy flag", async () => {
    const hook = setup();
    await ready(hook);
    await act(async () => {
      await hook.result.current.connect(CONN);
    });
    const account = hook.result.current.accounts[0]!;
    const cal = account.calendars[0]!;
    await act(async () => {
      await hook.result.current.toggleCalendar(cal.id, true, "#A8CDB4");
    });

    await act(async () => {
      await hook.result.current.resync(account.id);
    });

    // See `ResultMap` in useCalendarSync.ts for why it's keyed by row id.
    expect(hook.result.current.results[cal.id]).toBe("synced");
    expect(hook.result.current.busyAccountId).toBeNull();
  });

  it("prunes a calendar's result when it's toggled, so no stale dot lingers", async () => {
    const hook = setup();
    await ready(hook);
    await act(async () => {
      await hook.result.current.connect(CONN);
    });
    const account = hook.result.current.accounts[0]!;
    const cal = account.calendars[0]!;
    await act(async () => {
      await hook.result.current.toggleCalendar(cal.id, true, "#A8CDB4");
      await hook.result.current.resync(account.id);
    });
    expect(hook.result.current.results[cal.id]).toBe("synced");

    await act(async () => {
      await hook.result.current.toggleCalendar(cal.id, false, "#A8CDB4");
    });
    expect(hook.result.current.results[cal.id]).toBeUndefined();
  });

  it("prunes results when an account is disconnected", async () => {
    const hook = setup();
    await ready(hook);
    await act(async () => {
      await hook.result.current.connect(CONN);
    });
    const account = hook.result.current.accounts[0]!;
    const cal = account.calendars[0]!;
    await act(async () => {
      await hook.result.current.toggleCalendar(cal.id, true, "#A8CDB4");
      await hook.result.current.resync(account.id);
    });
    expect(hook.result.current.results[cal.id]).toBe("synced");

    await act(async () => {
      await hook.result.current.disconnect(account.id);
    });
    expect(hook.result.current.results[cal.id]).toBeUndefined();
  });

  it("disconnect removes the account", async () => {
    const hook = setup();
    await ready(hook);
    await act(async () => {
      await hook.result.current.connect(CONN);
    });
    const account = hook.result.current.accounts[0]!;

    await act(async () => {
      await hook.result.current.disconnect(account.id);
    });

    expect(hook.result.current.accounts).toEqual([]);
  });

  describe("surfaces action failures instead of swallowing them", () => {
    // Why these need catching (unlike connect): see actionError in useCalendarSync.ts.
    function setupWithWorkspace() {
      return renderHookWithProviders(() => ({
        sync: useCalendarSync(),
        ws: useWorkspace(),
      }));
    }

    async function connectedAccount(hook: ReturnType<typeof setupWithWorkspace>) {
      await waitFor(() => expect(hook.result.current.sync.loading).toBe(false));
      await act(async () => {
        await hook.result.current.sync.connect(CONN);
      });
      return hook.result.current.sync.accounts[0]!;
    }

    it("disconnect failure surfaces as error, keeps the account", async () => {
      const hook = setupWithWorkspace();
      const account = await connectedAccount(hook);
      vi.spyOn(hook.result.current.ws.storage!, "disconnectSyncAccount").mockRejectedValueOnce(
        new Error("keychain locked")
      );

      await act(async () => {
        await hook.result.current.sync.disconnect(account.id);
      });

      expect(hook.result.current.sync.error).toBe("keychain locked");
      expect(hook.result.current.sync.accounts).toHaveLength(1);
    });

    it("toggleCalendar failure surfaces as error", async () => {
      const hook = setupWithWorkspace();
      const account = await connectedAccount(hook);
      const cal = account.calendars[0]!;
      vi.spyOn(hook.result.current.ws.storage!, "toggleSyncCalendar").mockRejectedValueOnce(
        new Error("folder write failed")
      );

      await act(async () => {
        await hook.result.current.sync.toggleCalendar(cal.id, true, "#A8CDB4");
      });

      expect(hook.result.current.sync.error).toBe("folder write failed");
    });

    it("resync failure surfaces as error and still clears the busy flag", async () => {
      const hook = setupWithWorkspace();
      const account = await connectedAccount(hook);
      vi.spyOn(hook.result.current.ws.storage!, "resyncSyncAccount").mockRejectedValueOnce(
        new Error("network down")
      );

      await act(async () => {
        await hook.result.current.sync.resync(account.id);
      });

      expect(hook.result.current.sync.error).toBe("network down");
      expect(hook.result.current.sync.busyAccountId).toBeNull();
    });

    it("a non-Error rejection falls back to a friendly message", async () => {
      const hook = setupWithWorkspace();
      const account = await connectedAccount(hook);
      vi.spyOn(hook.result.current.ws.storage!, "resyncSyncAccount").mockRejectedValueOnce("boom");

      await act(async () => {
        await hook.result.current.sync.resync(account.id);
      });

      expect(hook.result.current.sync.error).toMatch(/couldn't sync/i);
    });

    it("a later successful action clears a stale error", async () => {
      const hook = setupWithWorkspace();
      const account = await connectedAccount(hook);
      vi.spyOn(hook.result.current.ws.storage!, "resyncSyncAccount").mockRejectedValueOnce(
        new Error("network down")
      );
      await act(async () => {
        await hook.result.current.sync.resync(account.id);
      });
      expect(hook.result.current.sync.error).toBe("network down");

      await act(async () => {
        await hook.result.current.sync.resync(account.id);
      });
      expect(hook.result.current.sync.error).toBeNull();
    });
  });
});
