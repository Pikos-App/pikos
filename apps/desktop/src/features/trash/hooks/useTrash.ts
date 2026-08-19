// The trash's data half: read the soft-deleted rows, and the three things a
// user can do to them.
//
// Restore deliberately goes through `usePages().restorePage` rather than the
// adapter, because clearing `deleted_at` is only half of it — the page also has
// to reappear in the live store, and that hook is the one place that re-reads
// the row and merges it back (the undo toast's Undo takes the same path). Going
// straight to the adapter would restore a page the workspace does not show
// until the next reload.

import type { TrashedPage } from "@pikos/core";
import { useEffect, useState } from "react";

import { usePages } from "@/shared/context/PagesContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { createLogger } from "@/shared/logger";

const log = createLogger("Trash");

export interface TrashState {
  entries: TrashedPage[];
  loading: boolean;
  /** Set when a read or a write failed, so the surface says so instead of
   *  silently showing an empty (or stale) trash. */
  error: string | null;
  refresh: () => Promise<void>;
  /** Clear `deleted_at` and put the page back in the live store. */
  restore: (id: string) => Promise<void>;
  /** Destroy one page. Only ever called for a row the backend will actually
   *  destroy — a mirror keeps its tombstone, so the UI does not offer this. */
  deleteForever: (id: string) => Promise<void>;
  /** Purge everything eligible now; resolves to how many rows actually went. */
  emptyTrash: () => Promise<number>;
}

/** `active` gates the fetch: the trash lives behind a dialog, so a closed one
 *  must not keep issuing reads, and every open should show current truth
 *  rather than what was there last time. */
export function useTrash(active: boolean): TrashState {
  const { storage } = useWorkspace();
  const { deletePage, restorePage } = usePages();
  const [entries, setEntries] = useState<TrashedPage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    if (!storage) return;
    setLoading(true);
    try {
      setEntries(await storage.listTrashedPages());
      setError(null);
    } catch (e) {
      log.error("listTrashedPages failed", e);
      setError("Couldn't read the trash.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (active) void refresh();
    else setError(null);
  }, [active, storage]);

  /** Run a write, then re-read: the backend decides what survives (a mirror is
   *  kept), so the list is refetched rather than patched from the outcome. */
  async function mutate(label: string, write: () => Promise<void>): Promise<void> {
    try {
      await write();
      setError(null);
    } catch (e) {
      log.error(`${label} failed`, e);
      setError("That didn't work. Try again.");
    }
    await refresh();
  }

  async function restore(id: string): Promise<void> {
    await mutate("restorePage", () => restorePage(id));
  }

  async function deleteForever(id: string): Promise<void> {
    await mutate("deletePage", () => deletePage(id));
  }

  async function emptyTrash(): Promise<number> {
    if (!storage) return 0;
    let purged = 0;
    await mutate("purgeTrashedPages", async () => {
      purged = await storage.purgeTrashedPages(0);
      // Destructive and user-initiated: the count (never a title) is what makes
      // a "where did my pages go" report readable afterwards.
      log.info(`trash emptied — ${purged} page(s) destroyed`);
    });
    return purged;
  }

  return { deleteForever, emptyTrash, entries, error, loading, refresh, restore };
}
