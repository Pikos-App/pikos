// The trash's data half: read the soft-deleted rows, and restore, destroy or empty them. Restore goes
// through `usePages().restorePage`, not the adapter, because clearing `deleted_at` is only half: the
// page must also reappear in the live store, and that hook re-reads and merges the row (the undo
// toast takes the same path).

import type { TrashedPage } from "@pikos/core";
import { useEffect, useRef, useState } from "react";

import { usePages } from "@/shared/context/PagesContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { createLogger } from "@/shared/logger";

const log = createLogger("Trash");

export interface TrashState {
  entries: TrashedPage[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  restore: (id: string) => Promise<void>;
  /** Destroy one page. Only ever called for a row the backend will actually
   *  destroy — a mirror keeps its tombstone, so the UI does not offer this. */
  deleteForever: (id: string) => Promise<void>;
  emptyTrash: () => Promise<number>;
}

/** `active` gates the fetch: the trash lives behind a dialog, so a closed one
 *  must not keep issuing reads, and every open should show current truth
 *  rather than what was there last time. */
export function useTrash(active: boolean): TrashState {
  const { on, storage } = useWorkspace();
  const { deletePage, restorePage } = usePages();
  const [entries, setEntries] = useState<TrashedPage[]>([]);
  const [loading, setLoading] = useState(false);
  // A successful read clears only a read's error. Every write re-reads after it, so clearing a
  // write's error there would hide the failure: an empty that destroyed nothing would look done.
  const [error, setError] = useState<{ from: "read" | "write"; message: string } | null>(null);
  // Reads overlap (a delete event's and a write's own re-read), and only the latest is kept: an
  // earlier read landing after it would put back pages the write had just destroyed.
  const askedRef = useRef(0);

  async function refresh(): Promise<void> {
    if (!storage) return;
    const asked = ++askedRef.current;
    setLoading(true);
    try {
      const rows = await storage.listTrashedPages();
      if (asked !== askedRef.current) return;
      setEntries(rows);
      setError((prev) => (prev?.from === "read" ? null : prev));
    } catch (e) {
      if (asked !== askedRef.current) return;
      log.error("listTrashedPages failed", e);
      setError({ from: "read", message: "Couldn't read the trash." });
    } finally {
      if (asked === askedRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (active) void refresh();
    else setError(null);
  }, [active, storage]);

  // Something can be deleted while the trash is open (a page from the calendar or a shortcut, a
  // folder from the sidebar), and the rows belong in the list at once. A folder needs its own
  // subscription: the adapter soft-deletes its pages itself, so no page events fire. `storage` is in
  // the deps because `refresh` closes over it and it starts null.
  useEffect(() => {
    if (!active) return;
    const offPage = on("page:deleted", () => {
      void refresh();
    });
    const offFolder = on("folder:deleted", () => {
      void refresh();
    });
    return () => {
      offPage();
      offFolder();
    };
  }, [active, on, storage]);

  /** Run a write, then re-read: the backend decides what survives (a mirror is
   *  kept), so the list is refetched rather than patched from the outcome. */
  async function mutate(label: string, write: () => Promise<void>): Promise<void> {
    try {
      await write();
      setError(null);
    } catch (e) {
      log.error(`${label} failed`, e);
      setError({ from: "write", message: "That didn't work. Try again." });
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

  return {
    deleteForever,
    emptyTrash,
    entries,
    error: error?.message ?? null,
    loading,
    refresh,
    restore,
  };
}
