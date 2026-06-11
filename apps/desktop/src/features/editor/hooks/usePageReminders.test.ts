import { MockStorageAdapter } from "@pikos/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePageReminders } from "./usePageReminders";

vi.stubEnv("VITE_TEST_MODE", "true");

let adapter: MockStorageAdapter;
const PAGE_ID = "page-1";

beforeEach(() => {
  adapter = new MockStorageAdapter();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setup(pageId = PAGE_ID) {
  return renderHook(() => usePageReminders(adapter, pageId));
}

describe("initial state", () => {
  it("starts with empty reminders", () => {
    const { result } = setup();
    expect(result.current.reminders).toEqual([]);
    expect(result.current.isNone).toBe(false);
    expect(result.current.hasCustomReminders).toBe(false);
    expect(result.current.activeReminders).toEqual([]);
  });

  it("loads existing reminders from storage", async () => {
    await adapter.createPageReminder({ minutesBefore: 10, pageId: PAGE_ID });
    await adapter.createPageReminder({ minutesBefore: 30, pageId: PAGE_ID });

    const { result } = setup();
    await act(async () => {
      await result.current.load();
    });

    expect(result.current.reminders).toHaveLength(2);
    expect(result.current.hasCustomReminders).toBe(true);
    expect(result.current.activeReminders.map((r) => r.minutesBefore)).toEqual([10, 30]);
  });
});

describe("add", () => {
  it("adds a reminder and updates state", async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.add(10);
    });

    expect(result.current.reminders).toHaveLength(1);
    expect(result.current.reminders[0]?.minutesBefore).toBe(10);
    expect(result.current.hasCustomReminders).toBe(true);
  });

  it("keeps reminders sorted by minutesBefore", async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.add(30);
    });
    await act(async () => {
      await result.current.add(5);
    });
    await act(async () => {
      await result.current.add(15);
    });

    expect(result.current.activeReminders.map((r) => r.minutesBefore)).toEqual([5, 15, 30]);
  });

  it("deduplicates — adding the same lead time twice is a no-op", async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.add(10);
    });
    await act(async () => {
      await result.current.add(10);
    });

    expect(result.current.reminders).toHaveLength(1);
  });

  it("clears None sentinel when adding a reminder", async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.setNone();
    });
    expect(result.current.isNone).toBe(true);

    await act(async () => {
      await result.current.add(15);
    });

    expect(result.current.isNone).toBe(false);
    expect(result.current.activeReminders).toHaveLength(1);
    expect(result.current.activeReminders[0]?.minutesBefore).toBe(15);

    // Storage should only have the real reminder, not the sentinel
    const stored = await adapter.listPageReminders(PAGE_ID);
    expect(stored.every((r) => r.minutesBefore >= 0)).toBe(true);
  });

  it("does nothing when storage is null", async () => {
    const { result } = renderHook(() => usePageReminders(null, PAGE_ID));

    await act(async () => {
      await result.current.add(10);
    });

    expect(result.current.reminders).toEqual([]);
  });
});

describe("remove", () => {
  it("removes a reminder by ID", async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.add(10);
    });
    await act(async () => {
      await result.current.add(30);
    });

    const idToRemove = result.current.reminders[0]!.id;
    await act(async () => {
      await result.current.remove(idToRemove);
    });

    expect(result.current.reminders).toHaveLength(1);
    expect(result.current.reminders[0]?.minutesBefore).toBe(30);
  });

  it("returns to default state when last reminder is removed", async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.add(10);
    });

    const id = result.current.reminders[0]!.id;
    await act(async () => {
      await result.current.remove(id);
    });

    expect(result.current.reminders).toHaveLength(0);
    expect(result.current.hasCustomReminders).toBe(false);
    expect(result.current.isNone).toBe(false);
  });
});

describe("setNone", () => {
  it("sets isNone state with sentinel value -1", async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.setNone();
    });

    expect(result.current.isNone).toBe(true);
    expect(result.current.hasCustomReminders).toBe(false);
    expect(result.current.activeReminders).toHaveLength(0);
    expect(result.current.reminders).toHaveLength(1);
    expect(result.current.reminders[0]?.minutesBefore).toBe(-1);
  });

  it("replaces existing reminders with sentinel", async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.add(10);
    });
    await act(async () => {
      await result.current.add(30);
    });
    await act(async () => {
      await result.current.setNone();
    });

    expect(result.current.isNone).toBe(true);
    expect(result.current.reminders).toHaveLength(1);

    const stored = await adapter.listPageReminders(PAGE_ID);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.minutesBefore).toBe(-1);
  });
});

describe("resetToDefault", () => {
  it("clears custom reminders back to empty (default) state", async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.add(5);
    });
    await act(async () => {
      await result.current.add(30);
    });
    await act(async () => {
      await result.current.resetToDefault();
    });

    expect(result.current.reminders).toHaveLength(0);
    expect(result.current.hasCustomReminders).toBe(false);
    expect(result.current.isNone).toBe(false);

    const stored = await adapter.listPageReminders(PAGE_ID);
    expect(stored).toHaveLength(0);
  });

  it("clears None sentinel back to default", async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.setNone();
    });
    await act(async () => {
      await result.current.resetToDefault();
    });

    expect(result.current.isNone).toBe(false);
    expect(result.current.reminders).toHaveLength(0);
  });
});

describe("page scoping", () => {
  it("load only returns reminders for the given page", async () => {
    await adapter.createPageReminder({ minutesBefore: 10, pageId: PAGE_ID });
    await adapter.createPageReminder({ minutesBefore: 30, pageId: "other-page" });

    const { result } = setup(PAGE_ID);
    await act(async () => {
      await result.current.load();
    });

    expect(result.current.reminders).toHaveLength(1);
    expect(result.current.reminders[0]?.minutesBefore).toBe(10);
  });
});
