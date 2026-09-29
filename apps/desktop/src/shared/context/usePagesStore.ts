// usePagesStore — the read half of PagesContext: the three collections every
// view reads (pages, folders, recurrence rules), the tags derived from them, and
// the loader WorkspaceContext dispatches at the right point in its lifecycle.
//
// It also owns the latest-state refs the write paths close over. Those are part
// of the store, not of any one write: every mutation needs to read the current
// list from a closure that outlived the render which created it.

import type { Folder, PageRecurrenceRule, PageSummary, StorageAdapter, Tag } from "@pikos/core";
import { deriveTags } from "@pikos/core";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";

export interface PagesStore {
  folders: Folder[];
  foldersRef: RefObject<Folder[]>;
  /** Add lazily-loaded pages (e.g. the Completed section) without disturbing
   *  the ones already in state. */
  mergePages: (incoming: PageSummary[]) => void;
  pages: PageSummary[];
  pagesRef: RefObject<PageSummary[]>;
  recurrenceRules: PageRecurrenceRule[];
  recurrenceRulesRef: RefObject<PageRecurrenceRule[]>;
  setFolders: Dispatch<SetStateAction<Folder[]>>;
  setPages: Dispatch<SetStateAction<PageSummary[]>>;
  setRecurrenceRules: Dispatch<SetStateAction<PageRecurrenceRule[]>>;
  tags: Tag[];
}

export function usePagesStore({
  adapter,
  registerDataLoader,
}: {
  adapter: StorageAdapter;
  registerDataLoader: (loader: (() => Promise<void>) | null) => void;
}): PagesStore {
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [recurrenceRules, setRecurrenceRules] = useState<PageRecurrenceRule[]>([]);

  // Latest-state mirrors for the write closures: a mutation that read `pages`
  // from its own closure would see whatever the render that created it saw, and
  // these closures outlive their render (debounce timers, queued writes, promise
  // continuations). The write is deliberately render-phase, not effect-phase — a
  // handler handed out by THIS render must already read this render's data, and
  // an effect-time mirror would leave it one commit behind.
  const pagesRef = useRef(pages);
  const foldersRef = useRef(folders);
  const recurrenceRulesRef = useRef(recurrenceRules);
  /* eslint-disable react-hooks/refs -- deliberate latest-state mirror; see above */
  pagesRef.current = pages;
  foldersRef.current = folders;
  recurrenceRulesRef.current = recurrenceRules;
  /* eslint-enable react-hooks/refs */

  // Loads only active pages at init; completed pages are fetched lazily —
  // via useCompletedPages for the per-folder Completed section, and via
  // CalendarView for the visible date range.
  async function loadData(): Promise<void> {
    // Heal the recurring display cache before reading it: an out-of-process writer
    // (CLI/mobile) or a prior bug can leave pages.scheduled_start stale. In steady
    // state (every in-session write already recomputes) this is a no-op.
    await adapter.recomputeRecurringSchedules();
    const [loadedPages, loadedFolders, loadedRules] = await Promise.all([
      adapter.listPages({ status: "not_started" }),
      adapter.listFolders(),
      adapter.listRecurrenceRules(),
    ]);
    setPages(loadedPages);
    setFolders(loadedFolders);
    setRecurrenceRules(loadedRules);
  }

  // Register the loader with WorkspaceContext so its init/selectWorkspace/
  // resetAndSeed can dispatch a data load at the right moment in their
  // sequence. The registered closure reaches the latest adapter through the
  // ref, which is refreshed on every render.
  const loadDataLatestRef = useRef(loadData);
  useEffect(() => {
    loadDataLatestRef.current = loadData;
  });
  useEffect(() => {
    registerDataLoader(() => loadDataLatestRef.current());
    return () => registerDataLoader(null);
  }, [registerDataLoader]);

  function mergePages(incoming: PageSummary[]) {
    setPages((prev) => {
      const existing = new Set(prev.map((p) => p.id));
      const newPages = incoming.filter((p) => !existing.has(p.id));
      return newPages.length > 0 ? [...prev, ...newPages] : prev;
    });
  }

  return {
    folders,
    foldersRef,
    mergePages,
    pages,
    pagesRef,
    recurrenceRules,
    recurrenceRulesRef,
    setFolders,
    setPages,
    setRecurrenceRules,
    tags: deriveTags(pages),
  };
}
