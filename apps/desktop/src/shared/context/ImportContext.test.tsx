// ImportContext — unit tests for the batch import + last-import undo flow.
//
// Runs in VITE_TEST_MODE so the provider tree uses MockStorageAdapter. Spies
// on the adapter prototype assert which writes the importer issues; the merged
// hook exposes workspace + pages + import APIs so a test can seed folders and
// read back state without a second render.

import { MockStorageAdapter } from "@pikos/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ImportBatchInput, ImportBatchItem } from "@/features/import/types";
import { useImportBatch } from "@/shared/context/ImportContext";
import { usePages } from "@/shared/context/PagesContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Merge workspace + pages + import into one hook so a single render exposes
 * seeding (createFolder), reading (pages/folders), and the import API. */
async function setup() {
  const hook = renderHookWithProviders(() => ({
    ...useWorkspace(),
    ...usePages(),
    ...useImportBatch(),
  }));

  await act(async () => {
    await hook.result.current.selectWorkspace();
  });

  return { hook };
}

/** Build an ImportBatchItem with sensible defaults; override per test. */
function item(overrides: Partial<ImportBatchItem> = {}): ImportBatchItem {
  return {
    completedAt: null,
    content: "<p>body</p>",
    contentText: "body",
    createdAt: null,
    folderKey: null,
    priority: 0,
    reminderMinutes: [],
    rrule: null,
    scheduledEnd: null,
    scheduledStart: null,
    sourceId: null,
    sourceParentId: null,
    status: "not_started",
    tags: [],
    title: "Imported",
    updatedAt: null,
    ...overrides,
  };
}

function batch(overrides: Partial<ImportBatchInput> = {}): ImportBatchInput {
  return { batchTag: "import-2026", folders: [], pages: [], source: "ticktick", ...overrides };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── importBatch ────────────────────────────────────────────────────────────

describe("importBatch", () => {
  it("creates new folders and pages, returning their IDs", async () => {
    const { hook } = await setup();

    let result!: Awaited<ReturnType<typeof hook.result.current.importBatch>>;
    await act(async () => {
      result = await hook.result.current.importBatch(
        batch({
          folders: [{ key: "f1", name: "Work" }],
          pages: [item({ folderKey: "f1", title: "Task A" })],
        })
      );
    });

    expect(result.folderIds).toHaveLength(1);
    expect(result.pageIds).toHaveLength(1);
    const imported = hook.result.current.pages.find((p) => p.id === result.pageIds[0]);
    expect(imported?.title).toBe("Task A");
    expect(imported?.tags).toContain("import-2026");
  });

  it("reuses an existing folder by name instead of creating a duplicate", async () => {
    const { hook } = await setup();
    await act(async () => {
      await hook.result.current.createFolder({ name: "Work" });
    });
    const createFolder = vi.spyOn(MockStorageAdapter.prototype, "createFolder");

    let result!: Awaited<ReturnType<typeof hook.result.current.importBatch>>;
    await act(async () => {
      result = await hook.result.current.importBatch(
        batch({
          folders: [{ key: "f1", name: "Work" }],
          pages: [item({ folderKey: "f1" })],
        })
      );
    });

    // Folder already existed → no new folder created, none reported for undo.
    expect(createFolder).not.toHaveBeenCalled();
    expect(result.folderIds).toHaveLength(0);
  });

  it("creates schedule, recurrence rule, and reminders for a recurring page", async () => {
    const { hook } = await setup();
    const createSchedule = vi.spyOn(MockStorageAdapter.prototype, "createPageSchedule");
    const createRule = vi.spyOn(MockStorageAdapter.prototype, "createRecurrenceRule");
    const createReminder = vi.spyOn(MockStorageAdapter.prototype, "createPageReminder");

    await act(async () => {
      await hook.result.current.importBatch(
        batch({
          pages: [
            item({
              reminderMinutes: [10, 30],
              rrule: "FREQ=DAILY",
              scheduledEnd: "2026-06-10T10:00:00.000Z",
              scheduledStart: "2026-06-10T09:00:00.000Z",
            }),
          ],
        })
      );
    });

    expect(createSchedule).toHaveBeenCalledOnce();
    expect(createRule).toHaveBeenCalledOnce();
    expect(createReminder).toHaveBeenCalledTimes(2);
  });

  it("links a child page to its parent via sourceParentId", async () => {
    const { hook } = await setup();
    const updatePage = vi.spyOn(MockStorageAdapter.prototype, "updatePage");

    let result!: Awaited<ReturnType<typeof hook.result.current.importBatch>>;
    await act(async () => {
      result = await hook.result.current.importBatch(
        batch({
          pages: [
            item({ sourceId: "src-parent", title: "Parent" }),
            item({ sourceParentId: "src-parent", title: "Child" }),
          ],
        })
      );
    });

    // The child's parentId is rewired to the parent's freshly-minted Pikos id.
    const [parentId, childId] = result.pageIds;
    expect(updatePage).toHaveBeenCalledOnce();
    expect(updatePage).toHaveBeenCalledWith(childId, { parentId });
  });
});

// ─── lastImportResult + undo ──────────────────────────────────────────────────

describe("last import result", () => {
  it("records the last import and clears it on demand", async () => {
    const { hook } = await setup();

    await act(async () => {
      await hook.result.current.importBatch(
        batch({ folders: [{ key: "f1", name: "Work" }], pages: [item(), item()] })
      );
    });

    expect(hook.result.current.lastImportResult).toMatchObject({
      folderCount: 1,
      pageCount: 2,
      source: "ticktick",
    });

    act(() => {
      hook.result.current.clearLastImport();
    });
    expect(hook.result.current.lastImportResult).toBeNull();
  });

  it("soft-deletes every imported page and folder on undo", async () => {
    const { hook } = await setup();
    const deletePage = vi.spyOn(MockStorageAdapter.prototype, "softDeletePage");
    const deleteFolder = vi.spyOn(MockStorageAdapter.prototype, "softDeleteFolder");

    await act(async () => {
      await hook.result.current.importBatch(
        batch({ folders: [{ key: "f1", name: "Work" }], pages: [item(), item()] })
      );
    });
    await act(async () => {
      await hook.result.current.undoLastImport();
    });

    expect(deletePage).toHaveBeenCalledTimes(2);
    expect(deleteFolder).toHaveBeenCalledTimes(1);
    expect(hook.result.current.lastImportResult).toBeNull();
  });

  it("undo is a no-op when there is nothing to undo", async () => {
    const { hook } = await setup();
    const deletePage = vi.spyOn(MockStorageAdapter.prototype, "softDeletePage");

    await act(async () => {
      await hook.result.current.undoLastImport();
    });

    expect(deletePage).not.toHaveBeenCalled();
  });
});

// ─── Provider guard ─────────────────────────────────────────────────────────

describe("useImportBatch", () => {
  it("throws when used outside <ImportProvider>", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useImportBatch())).toThrow(
      /useImportBatch must be used within <ImportProvider>/
    );
  });
});
