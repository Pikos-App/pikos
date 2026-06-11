// ImportContext — batch import flow + last-import undo. Carves out the
// import concern from WorkspaceContext so DataSettings doesn't re-render
// on every page mutation. Reads folders/storage from WorkspaceContext and
// dispatches soft-delete + reload through it on undo.

import { getLocalTimezone } from "@pikos/core";
import { createContext, type ReactNode, useContext, useState } from "react";

import type {
  ImportBatchInput,
  ImportBatchResult,
  LastImportResult,
} from "@/features/import/types";

import { usePages } from "./PagesContext";
import { useWorkspace } from "./WorkspaceContext";

export interface ImportContextValue {
  /** Batch-import pages and folders from an external source. Returns IDs for undo. */
  importBatch: (data: ImportBatchInput) => Promise<ImportBatchResult>;
  /** Result of the last import — persists across settings open/close for undo. */
  lastImportResult: LastImportResult | null;
  clearLastImport: () => void;
  /** Undo the last import — soft-deletes all imported pages and folders. */
  undoLastImport: () => Promise<void>;
}

const ImportContext = createContext<ImportContextValue | null>(null);

export function ImportProvider({ children }: { children: ReactNode }) {
  const { reload, storage } = useWorkspace();
  const { folders, softDeleteFolder, softDeletePage } = usePages();
  const [lastImportResult, setLastImportResult] = useState<LastImportResult | null>(null);

  async function importBatch(data: ImportBatchInput): Promise<ImportBatchResult> {
    if (!storage) throw new Error("Cannot import before workspace is ready");
    const adapter = storage;
    const folderIds: string[] = [];
    const pageIds: string[] = [];

    const existingFoldersByName = new Map(folders.map((f) => [f.name, f]));

    const folderKeyToId = new Map<string, string>();
    for (const f of data.folders) {
      const existing = existingFoldersByName.get(f.name);
      if (existing) {
        folderKeyToId.set(f.key, existing.id);
      } else {
        const created = await adapter.createFolder({ name: f.name, parentId: null });
        folderKeyToId.set(f.key, created.id);
        folderIds.push(created.id);
      }
    }

    const tz = getLocalTimezone();
    const sourceIdToPikosId = new Map<string, string>();
    const pagesNeedingParent: { pikosId: string; sourceParentId: string }[] = [];

    for (const p of data.pages) {
      const folderId = p.folderKey ? (folderKeyToId.get(p.folderKey) ?? null) : null;
      const tagsWithBatch = [...p.tags, data.batchTag];

      const page = await adapter.createPage({
        content: p.content,
        contentText: p.contentText,
        folderId,
        priority: p.priority,
        status: p.status,
        tags: tagsWithBatch,
        title: p.title,
        ...(p.completedAt ? { completedAt: p.completedAt } : {}),
        ...(p.createdAt ? { createdAt: p.createdAt } : {}),
        ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}),
      });
      pageIds.push(page.id);

      if (p.sourceId) {
        sourceIdToPikosId.set(p.sourceId, page.id);
      }
      if (p.sourceParentId) {
        pagesNeedingParent.push({ pikosId: page.id, sourceParentId: p.sourceParentId });
      }

      // Create schedule if needed. Recurring pages also get a recurrence rule
      // anchored at the same start/end — the rule's scheduledStart is the
      // DTSTART used by rrule.js to expand virtual occurrences.
      if (p.scheduledStart) {
        await adapter.createPageSchedule({
          pageId: page.id,
          scheduledStart: p.scheduledStart,
          ...(p.scheduledEnd ? { scheduledEnd: p.scheduledEnd } : {}),
          timezone: tz,
        });
        if (p.rrule) {
          await adapter.createRecurrenceRule({
            pageId: page.id,
            rrule: p.rrule,
            scheduledStart: p.scheduledStart,
            ...(p.scheduledEnd ? { scheduledEnd: p.scheduledEnd } : {}),
            timezone: tz,
          });
        }
      }

      for (const mins of p.reminderMinutes) {
        await adapter.createPageReminder({ minutesBefore: mins, pageId: page.id });
      }
    }

    for (const { pikosId, sourceParentId } of pagesNeedingParent) {
      const parentPikosId = sourceIdToPikosId.get(sourceParentId);
      if (parentPikosId) {
        await adapter.updatePage(pikosId, { parentId: parentPikosId });
      }
    }

    // Store result for undo before reload (reload unmounts components, losing local state)
    const result: LastImportResult = {
      folderCount: folderIds.length,
      folderIds,
      importedAt: new Date().toISOString(),
      pageCount: data.pages.length,
      pageIds,
      source: data.source,
    };
    setLastImportResult(result);

    await reload();

    return { folderIds, pageIds };
  }

  function clearLastImport() {
    setLastImportResult(null);
  }

  async function undoLastImport() {
    if (!lastImportResult) return;
    const { folderIds: fIds, pageIds: pIds } = lastImportResult;
    await Promise.all(pIds.map((id) => softDeletePage(id)));
    await Promise.all(fIds.map((id) => softDeleteFolder(id)));
    setLastImportResult(null);
    await reload();
  }

  const value: ImportContextValue = {
    clearLastImport,
    importBatch,
    lastImportResult,
    undoLastImport,
  };

  return <ImportContext.Provider value={value}>{children}</ImportContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useImportBatch(): ImportContextValue {
  const ctx = useContext(ImportContext);
  if (!ctx) throw new Error("useImportBatch must be used within <ImportProvider>");
  return ctx;
}
