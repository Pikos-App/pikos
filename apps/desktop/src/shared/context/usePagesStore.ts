// usePagesStore — the read half of PagesContext: folders, recurrence rules and tags, the write
// paths' view of the held pages, and the loader WorkspaceContext dispatches at the right point in
// its lifecycle.
//
// Pages aren't a list here: the view cache's store holds them, and each screen reads what it
// shows. The write paths still describe their edits as a change to a list (`setPages`), which the
// mirror turns into pending writes on the store, so none of them had to be rewritten.

import type {
  Folder,
  PageRecurrenceRule,
  PageSummary,
  StorageAdapter,
  Tag,
  TagCount,
} from "@pikos/core";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";

import { createLogger } from "@/shared/logger";
import type { ViewCacheController } from "@/shared/viewCache/controller";

const log = createLogger("PagesStore");

export interface PagesStore {
  folders: Folder[];
  foldersRef: RefObject<Folder[]>;
  /** Hold pages read elsewhere (the Completed section, a calendar range) as confirmed rows. */
  mergePages: (incoming: PageSummary[]) => void;
  /** The held pages as they are now, for write paths whose closures outlive their render. */
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
  viewCache,
}: {
  adapter: StorageAdapter;
  registerDataLoader: (loader: (() => Promise<void>) | null) => void;
  viewCache: ViewCacheController;
}): PagesStore {
  const [tagList, setTagList] = useState<TagCount[]>([]);
  useEffect(() => viewCache.onTags(setTagList), [viewCache]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [recurrenceRules, setRecurrenceRules] = useState<PageRecurrenceRule[]>([]);

  // Latest-state mirrors for the write closures: a mutation that read state from its own closure
  // would see whatever the render that created it saw, and these closures outlive their render
  // (debounce timers, queued writes, promise continuations). Written during render, not in an
  // effect: a handler handed out by this render must already read this render's data.
  const [pagesRef] = useState<RefObject<PageSummary[]>>(() => ({
    get current() {
      return viewCache.heldPages();
    },
    set current(_ignored: PageSummary[]) {},
  }));
  const foldersRef = useRef(folders);
  const recurrenceRulesRef = useRef(recurrenceRules);
  foldersRef.current = folders;
  recurrenceRulesRef.current = recurrenceRules;

  // A change to the list is a change to the store, made through the mirror. Read and applied at
  // once, so a second change in the same tick builds on the first.
  function setPages(action: SetStateAction<PageSummary[]>): void {
    const prev = viewCache.heldPages();
    const next = typeof action === "function" ? action(prev) : action;
    viewCache.mirror.apply(prev, next);
  }

  async function loadData(): Promise<void> {
    // Heal the recurring display cache: an out-of-process writer (CLI, mobile) or a prior bug can
    // leave a head's schedule stale. Not awaited: the lists read themselves and refresh if the
    // recompute changes a head.
    adapter.recomputeRecurringSchedules().catch((err: unknown) => {
      log.error("recomputing recurring schedules at launch failed", err);
    });
    const [loadedFolders, loadedRules] = await Promise.all([
      adapter.listFolders(),
      adapter.listRecurrenceRules(),
    ]);
    await viewCache.loadSeriesHeads();
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
    viewCache.store.confirm(incoming);
  }

  return {
    folders,
    foldersRef,
    mergePages,
    pagesRef,
    recurrenceRules,
    recurrenceRulesRef,
    setFolders,
    setPages,
    setRecurrenceRules,
    tags: tagList.map((t) => ({ name: t.name, pageCount: t.pageCount, pageIds: [] })),
  };
}
