// The synced-calendar case needs a real external-calendar folder, and connecting
// an account then enabling a calendar is the only path that mints one.

import { MockStorageAdapter } from "@pikos/core/testing";
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppSettings } from "@/shared/context/AppSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

import { useCalendarPageCreate } from "./useCalendarPageCreate";

const START = new Date(2026, 5, 17, 9, 0, 0);

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

function setup() {
  const created: string[] = [];
  const hook = renderHookWithProviders(() => {
    const create = useCalendarPageCreate((id) => created.push(id));
    return {
      create,
      pages: usePages(),
      settings: useAppSettings(),
      ui: useUI(),
      undo: useUndoDelete(),
      workspace: useWorkspace(),
    };
  });
  return { created, hook };
}

type Hook = ReturnType<typeof setup>["hook"];

async function init(hook: Hook) {
  await act(async () => {
    await hook.result.current.workspace.selectWorkspace();
  });
}

/** Returns the id of the external-calendar folder a newly enabled calendar mints. */
async function enableSyncedCalendar(hook: Hook): Promise<string> {
  let folderId!: string;
  await act(async () => {
    const storage = hook.result.current.workspace.storage!;
    const account = await storage.connectCaldavAccount({
      baseUrl: "https://caldav.example.com",
      displayName: "you@example.com",
      password: "app-password",
      username: "you",
    });
    const calendar = await storage.toggleSyncCalendar(account.calendars[0]!.id, true, null);
    folderId = calendar.folderId!;
    await hook.result.current.workspace.reload();
  });
  return folderId;
}

function folderOf(hook: Hook, pageId: string) {
  return hook.result.current.pages.pages.find((p) => p.id === pageId)?.folderId;
}

describe("useCalendarPageCreate", () => {
  it("creates in the active folder when a page may be placed there", async () => {
    const { created, hook } = setup();
    await init(hook);
    let folderId!: string;
    await act(async () => {
      folderId = (await hook.result.current.pages.createFolder({ name: "Work" })).id;
    });
    act(() => hook.result.current.ui.setActiveViewId(folderId));

    await act(async () => {
      await hook.result.current.create.createTimedPage(START);
    });

    expect(created).toHaveLength(1);
    await waitFor(() => expect(folderOf(hook, created[0]!)).toBe(folderId));
  });

  it("lands in Inbox rather than failing when a synced calendar is selected", async () => {
    const { created, hook } = setup();
    await init(hook);
    const calendarFolderId = await enableSyncedCalendar(hook);
    act(() => hook.result.current.ui.setActiveViewId(calendarFolderId));

    await act(async () => {
      await hook.result.current.create.createTimedPage(START);
    });

    expect(created).toHaveLength(1);
    await waitFor(() => expect(folderOf(hook, created[0]!)).toBeNull());
    expect(hook.result.current.undo.toastItems).toHaveLength(0);
  });

  it("falls back past a default folder that is itself a synced calendar", async () => {
    const { created, hook } = setup();
    await init(hook);
    const calendarFolderId = await enableSyncedCalendar(hook);
    act(() => hook.result.current.settings.setDefaultFolderId(calendarFolderId));

    await act(async () => {
      await hook.result.current.create.createAllDayPage(START);
    });

    expect(created).toHaveLength(1);
    await waitFor(() => expect(folderOf(hook, created[0]!)).toBeNull());
  });

  it("reports a refused create instead of leaving it an unhandled rejection", async () => {
    const { created, hook } = setup();
    await init(hook);
    vi.spyOn(MockStorageAdapter.prototype, "createPage").mockRejectedValue(
      new Error("disk is full")
    );

    await act(async () => {
      await hook.result.current.create.createTimedPage(START);
    });

    expect(created).toEqual([]);
    expect(hook.result.current.undo.toastItems.map((t) => t.label)).toEqual([
      "Something went wrong while creating the page.",
    ]);
  });

  it("reports a schedule that fails after the page is created", async () => {
    const { created, hook } = setup();
    await init(hook);
    vi.spyOn(MockStorageAdapter.prototype, "createPageSchedule").mockRejectedValue(
      new Error("disk is full")
    );

    await act(async () => {
      await hook.result.current.create.createAllDayPage(START);
    });

    expect(created).toEqual([]);
    expect(hook.result.current.undo.toastItems).toHaveLength(1);
  });
});
