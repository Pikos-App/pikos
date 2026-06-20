import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

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

  it("recolorCalendar changes the colour without flipping enabled", async () => {
    const hook = setup();
    await ready(hook);
    await act(async () => {
      await hook.result.current.connect(CONN);
    });
    const cal = hook.result.current.accounts[0]!.calendars[0]!;

    await act(async () => {
      await hook.result.current.recolorCalendar(cal.id, false, "#E5534B");
    });

    const updated = hook.result.current.accounts[0]!.calendars.find((c) => c.id === cal.id)!;
    expect(updated.color).toBe("#E5534B");
    expect(updated.enabled).toBe(false);
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

    // Keyed by row id, not the provider calendarId (which can collide across accounts).
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
});
