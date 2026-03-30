"use client";

// WorkspaceContext — owns all data + mutations: pages, folders, tags.
// GOO-15: auto-creates/reopens workspace on mount via @tauri-apps/plugin-store.

import type { Folder, Page, PageSummary, SearchResponse, Tag, Workspace } from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core";
import type { FolderUpdate, PageUpdate, StorageAdapter } from "@pikos/core";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import { connectDb, TauriSQLiteAdapter } from "@/shared/adapters/TauriSQLiteAdapter";

// ─── Event emitter ────────────────────────────────────────────────────────────

type WorkspaceEvent = "page:created" | "page:updated" | "page:deleted" | "workspace:loaded";

interface EventPayloadMap {
  "page:created": Page;
  "page:updated": Page;
  "page:deleted": string;
  "workspace:loaded": Workspace;
}

type AnyHandler = (payload: unknown) => void;

// ─── Context shape ────────────────────────────────────────────────────────────

export interface WorkspaceContextValue {
  workspace: Workspace | null;
  /** Lightweight summaries (no content) — use getPage() to load full content. */
  pages: PageSummary[];
  folders: Folder[];
  /** Load full page with content — use when opening the editor. */
  getPage: (id: string) => Promise<Page | null>;
  /** Derived reactively from pages[].tags — never stored separately. */
  tags: Tag[];
  /** True while the workspace is being initialised or data is being loaded. */
  isLoading: boolean;
  /** Reload pages + folders from the DB (e.g. after an external seed). */
  reload: () => Promise<void>;
  /** First-launch: create default workspace + connect. Subsequent: already handled on mount. */
  selectWorkspace: () => Promise<void>;
  /** Consume one-shot navigation target set by tutorial seed. Returns null if none pending. */
  consumePendingNavigation: () => { pageId: string; folderId: string } | null;
  /** Dev tool: wipe all data and re-seed with a scenario. */
  resetAndSeed: (scenario: "tutorial" | "realistic" | "stress") => Promise<void>;
  createPage: (opts: { title?: string; folderId?: string | null }) => Promise<Page>;
  /** Debounced 800ms — optimistic update applied immediately; DB write batched. */
  updatePage: (id: string, patch: PageUpdate) => void;
  /** Immediately flush any pending debounced write for a page. */
  flushPage: (id: string) => Promise<void>;
  deletePage: (id: string) => Promise<void>;
  /** Soft-delete: sets deleted_at. Page is hidden everywhere but recoverable via restorePage. */
  softDeletePage: (id: string) => Promise<void>;
  /** Restore a soft-deleted page — clears deleted_at and re-adds to pages list. */
  restorePage: (id: string) => Promise<void>;
  createFolder: (opts: { name: string; color?: string }) => Promise<Folder>;
  updateFolder: (id: string, updates: FolderUpdate) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  reorderPages: (folderId: string | null, orderedIds: string[]) => Promise<void>;
  reorderFolders: (orderedIds: string[]) => Promise<void>;
  /** Create or update the one-off schedule block for a page. */
  scheduleOnce: (pageId: string, start: string, end?: string) => Promise<void>;
  /** Delete all one-off schedule blocks for a page. */
  clearSchedule: (pageId: string) => Promise<void>;
  /** Unified FTS5 search — title matches ranked above content via bm25(). */
  searchPages: (query: string, includeCompleted?: boolean) => Promise<SearchResponse>;
  /** Tag name prefix search — for autocomplete in tag chip inputs. */
  searchTags: (query: string) => Promise<string[]>;
  /** Per-page error state from failed debounced writes or scheduling mutations. */
  pageErrors: Map<string, string>;
  /** Dismiss the error indicator for a page. */
  clearPageError: (id: string) => void;
  on: <E extends WorkspaceEvent>(
    event: E,
    handler: (payload: EventPayloadMap[E]) => void
  ) => () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

// ─── Derived tags ─────────────────────────────────────────────────────────────

function deriveTags(pages: PageSummary[]): Tag[] {
  const map = new Map<string, { count: number; ids: string[] }>();
  for (const page of pages) {
    for (const tag of page.tags) {
      const entry = map.get(tag);
      if (entry) {
        entry.count++;
        entry.ids.push(page.id);
      } else {
        map.set(tag, { count: 1, ids: [page.id] });
      }
    }
  }
  return Array.from(map.entries()).map(([name, { count, ids }]) => ({
    name,
    pageCount: count,
    pageIds: ids,
  }));
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [adapter] = useState<StorageAdapter>(() =>
    import.meta.env["VITE_TEST_MODE"] === "true"
      ? new MockStorageAdapter()
      : new TauriSQLiteAdapter()
  );

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  // Start true so we don't flash the welcome screen before init completes
  const [isLoading, setIsLoading] = useState(true);

  // One-shot navigation target from tutorial seed — consumed once by AppShell.
  const pendingNavigationRef = useRef<{ pageId: string; folderId: string } | null>(null);

  function consumePendingNavigation(): { pageId: string; folderId: string } | null {
    const nav = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    return nav;
  }

  // Lightweight event emitter
  const listenersRef = useRef(new Map<string, Set<AnyHandler>>());

  function emit<E extends WorkspaceEvent>(event: E, payload: EventPayloadMap[E]) {
    listenersRef.current.get(event)?.forEach((h) => h(payload as unknown));
  }

  function on<E extends WorkspaceEvent>(event: E, handler: (payload: EventPayloadMap[E]) => void) {
    let set = listenersRef.current.get(event);
    if (!set) {
      set = new Set();
      listenersRef.current.set(event, set);
    }
    set.add(handler as AnyHandler);
    return () => {
      listenersRef.current.get(event)?.delete(handler as AnyHandler);
    };
  }

  // Shared helper — loads pages + folders from adapter. Stored in a ref so both
  // the mount effect and selectWorkspace can call it without dep-array issues.
  const loadWorkspaceDataRef = useRef(async () => {
    setIsLoading(true);
    try {
      const [loadedPages, loadedFolders] = await Promise.all([
        adapter.listPages(),
        adapter.listFolders(),
      ]);
      setPages(loadedPages);
      setFolders(loadedFolders);
    } finally {
      setIsLoading(false);
    }
  });

  // ─── Auto-init on mount ────────────────────────────────────────────────────
  // Attempts to reopen the most recently used workspace from the store.
  // On first launch (empty store) → auto-creates workspace + seeds tutorial.

  const seedRanRef = useRef(false);

  useEffect(() => {
    if (import.meta.env["VITE_TEST_MODE"] === "true") {
      // Guard against React strict mode double-invoke
      if (seedRanRef.current) return;
      seedRanRef.current = true;

      void (async () => {
        const seedScenario = import.meta.env["VITE_SEED"] as string | undefined;
        if (seedScenario === "marketing") {
          const { seedMarketing } = await import("@/shared/seeds/marketing");
          await seedMarketing(adapter);
        } else if (seedScenario === "tutorial") {
          const { seedTutorial } = await import("@/shared/seeds/tutorial");
          const result = await seedTutorial(adapter);
          if (result) {
            pendingNavigationRef.current = {
              folderId: result.folderId,
              pageId: result.welcomePageId,
            };
          }
        } else if (seedScenario === "realistic") {
          const { seedRealistic } = await import("@/shared/seeds/realistic");
          await seedRealistic(adapter);
        } else if (seedScenario === "stress") {
          const { seedStress } = await import("@/shared/seeds/stress");
          await seedStress(adapter);
        }
        await loadWorkspaceDataRef.current();
        setWorkspace({
          createdAt: new Date().toISOString(),
          dbPath: ":memory:",
          id: seedScenario ? "seed" : "mock",
          lastOpenedAt: new Date().toISOString(),
          name: seedScenario ? "Seed Workspace" : "Test Workspace",
        });
      })();
      return;
    }

    async function initWorkspace() {
      try {
        const { load } = await import("@tauri-apps/plugin-store");
        const store = await load("workspaces.json", { autoSave: false, defaults: {} });
        const workspaces = (await store.get<Workspace[]>("workspaces")) ?? [];

        if (workspaces.length === 0) {
          // First launch — auto-create workspace + seed tutorial
          await selectWorkspace();
          return;
        }

        // Find most recently opened workspace
        const sorted = [...workspaces].sort((a, b) => {
          const ta = a.lastOpenedAt ?? "";
          const tb = b.lastOpenedAt ?? "";
          return tb.localeCompare(ta);
        });
        const ws = sorted[0]!;

        // connectDb uses create_if_missing — silently recreates if file is gone (stale path)
        await connectDb(ws.dbPath);

        // Update lastOpenedAt in the registry
        const now = new Date().toISOString();
        const updated: Workspace = { ...ws, lastOpenedAt: now };
        const updatedList = workspaces.map((w) => (w.id === ws.id ? updated : w));
        await store.set("workspaces", updatedList);
        await store.save();

        await loadWorkspaceDataRef.current();
        setWorkspace(updated);
        listenersRef.current.get("workspace:loaded")?.forEach((h) => h(updated as unknown));
      } catch (e) {
        console.error("[WorkspaceContext] auto-init failed:", e);
        setIsLoading(false);
      }
    }

    void initWorkspace();
  }, [adapter]);

  // ─── selectWorkspace ───────────────────────────────────────────────────────
  // Creates the default workspace on first launch. Called by initWorkspace when no workspaces exist.

  async function selectWorkspace(): Promise<void> {
    if (import.meta.env["VITE_TEST_MODE"] === "true") {
      // Test mode: set a mock workspace so the app shell renders
      const mockWs: Workspace = {
        createdAt: new Date().toISOString(),
        dbPath: ":memory:",
        id: "mock",
        lastOpenedAt: new Date().toISOString(),
        name: "Test Workspace",
      };
      await loadWorkspaceDataRef.current();
      setWorkspace(mockWs);
      emit("workspace:loaded", mockWs);
      return;
    }

    setIsLoading(true);
    try {
      const [{ appDataDir }, { load }] = await Promise.all([
        import("@tauri-apps/api/path"),
        import("@tauri-apps/plugin-store"),
      ]);

      const dataDir = await appDataDir();
      const sep = dataDir.endsWith("/") || dataDir.endsWith("\\") ? "" : "/";
      const dbPath = `${dataDir}${sep}default.sqlite`;

      const ws: Workspace = {
        createdAt: new Date().toISOString(),
        dbPath,
        id: crypto.randomUUID(),
        lastOpenedAt: new Date().toISOString(),
        name: "My Workspace",
      };

      await connectDb(dbPath);

      // Seed tutorial data for first-time users (idempotent — skips if already seeded)
      const { seedTutorial } = await import("@/shared/seeds/tutorial");
      const seedResult = await seedTutorial(adapter);
      if (seedResult) {
        pendingNavigationRef.current = {
          folderId: seedResult.folderId,
          pageId: seedResult.welcomePageId,
        };
      }

      const store = await load("workspaces.json", { autoSave: false, defaults: {} });
      const existing = (await store.get<Workspace[]>("workspaces")) ?? [];
      await store.set("workspaces", [...existing, ws]);
      await store.save();

      await loadWorkspaceDataRef.current();
      setWorkspace(ws);
      emit("workspace:loaded", ws);
    } catch (e) {
      console.error("[WorkspaceContext] selectWorkspace failed:", e);
      setIsLoading(false);
    }
  }

  // ─── Debounced updatePage ──────────────────────────────────────────────────

  const pendingPatches = useRef<Map<string, PageUpdate>>(new Map());
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const snapshotsRef = useRef<Map<string, PageSummary>>(new Map());
  const [pageErrors, setPageErrors] = useState<Map<string, string>>(new Map());

  // ─── Per-page mutation queue ───────────────────────────────────────────────
  // Serialises concurrent DB writes for the same page so that a fast debounced
  // write and a concurrent scheduleOnce can never interleave or clobber each other.

  const mutationQueues = useRef<Map<string, Promise<void>>>(new Map());

  function enqueue(pageId: string, fn: () => Promise<void>): Promise<void> {
    const prev = mutationQueues.current.get(pageId) ?? Promise.resolve();
    // Pass fn as both fulfilment and rejection handler so the queue never stalls
    // on a previous error.
    const next = prev.then(fn, fn);
    mutationQueues.current.set(pageId, next);
    return next;
  }

  function clearPageError(id: string): void {
    setPageErrors((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  function updatePage(id: string, patch: PageUpdate): void {
    // Snapshot current state before the first pending patch (used for rollback on DB error)
    if (!pendingPatches.current.has(id)) {
      const current = pages.find((p) => p.id === id);
      if (current) snapshotsRef.current.set(id, current);
    }

    // Optimistic local update — instant UI feedback
    setPages((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));

    // Accumulate patch for batched DB write
    const existing = pendingPatches.current.get(id) ?? {};
    pendingPatches.current.set(id, { ...existing, ...patch });

    const prevTimer = debounceTimers.current.get(id);
    if (prevTimer !== undefined) clearTimeout(prevTimer);

    const timer = setTimeout(() => {
      const accumulated = pendingPatches.current.get(id);
      if (!accumulated) return;
      pendingPatches.current.delete(id);
      debounceTimers.current.delete(id);

      void enqueue(id, async () => {
        try {
          const updated = await adapter.updatePage(id, accumulated);
          snapshotsRef.current.delete(id);
          const { content: _, contentText: _ct, ...summary } = updated;
          setPages((prev) => prev.map((p) => (p.id === id ? summary : p)));
          emit("page:updated", updated);
        } catch (err: unknown) {
          const snapshot = snapshotsRef.current.get(id);
          snapshotsRef.current.delete(id);
          if (snapshot) {
            setPages((prev) => prev.map((p) => (p.id === id ? snapshot : p)));
          }
          setPageErrors((prev) =>
            new Map(prev).set(id, err instanceof Error ? err.message : String(err))
          );
        }
      });
    }, 800);

    debounceTimers.current.set(id, timer);
  }

  async function flushPage(id: string): Promise<void> {
    const timer = debounceTimers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    debounceTimers.current.delete(id);

    const accumulated = pendingPatches.current.get(id);
    if (!accumulated) return;
    pendingPatches.current.delete(id);

    return enqueue(id, async () => {
      try {
        const updated = await adapter.updatePage(id, accumulated);
        snapshotsRef.current.delete(id);
        const { content: _, contentText: _ct, ...summary } = updated;
        setPages((prev) => prev.map((p) => (p.id === id ? summary : p)));
        emit("page:updated", updated);
      } catch (err) {
        const snapshot = snapshotsRef.current.get(id);
        snapshotsRef.current.delete(id);
        if (snapshot) {
          setPages((prev) => prev.map((p) => (p.id === id ? snapshot : p)));
        }
        setPageErrors((prev) =>
          new Map(prev).set(id, err instanceof Error ? err.message : String(err))
        );
        throw err;
      }
    });
  }

  // ─── Pages ────────────────────────────────────────────────────────────────

  async function createPage({ folderId, title }: { title?: string; folderId?: string | null }) {
    const page = await adapter.createPage({
      content: "",
      contentText: "",
      folderId: folderId ?? null,
      priority: 0,
      status: "not_started",
      tags: [],
      title: title ?? "",
    });
    const { content: _, contentText: _ct, ...summary } = page;
    setPages((prev) => [...prev, summary]);
    emit("page:created", page);
    return page;
  }

  async function deletePage(id: string) {
    // Cancel any pending debounced write for this page (GOO-93 fix)
    const timer = debounceTimers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    debounceTimers.current.delete(id);
    pendingPatches.current.delete(id);

    await adapter.deletePage(id);
    setPages((prev) => prev.filter((p) => p.id !== id));
    emit("page:deleted", id);
  }

  async function softDeletePage(id: string) {
    const timer = debounceTimers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    debounceTimers.current.delete(id);
    pendingPatches.current.delete(id);

    await adapter.softDeletePage(id);
    setPages((prev) => prev.filter((p) => p.id !== id));
    emit("page:deleted", id);
  }

  async function restorePage(id: string) {
    await adapter.restorePage(id);
    // Re-fetch the page to get its current state and add back to the list
    const page = await adapter.getPage(id);
    if (page) {
      const { content: _, contentText: _ct, ...summary } = page;
      setPages((prev) => [...prev, summary]);
    }
  }

  async function reorderPages(folderId: string | null, orderedIds: string[]) {
    const snapshot = [...pages];
    setPages((prev) => {
      const indexMap = new Map(orderedIds.map((id, i) => [id, i]));
      return prev.map((p) => {
        const newOrder = indexMap.get(p.id);
        return newOrder !== undefined ? { ...p, sortOrder: newOrder } : p;
      });
    });
    try {
      await adapter.reorderPages(folderId, orderedIds);
    } catch {
      setPages(snapshot);
    }
  }

  // ─── Folders ──────────────────────────────────────────────────────────────

  async function createFolder({ color, name }: { name: string; color?: string }) {
    const folder = await adapter.createFolder({
      name,
      ...(color !== undefined && { color }),
      parentId: null,
    });
    setFolders((prev) => [...prev, folder]);
    return folder;
  }

  async function updateFolder(id: string, updates: FolderUpdate) {
    const updated = await adapter.updateFolder(id, updates);
    setFolders((prev) => prev.map((f) => (f.id === id ? updated : f)));
  }

  async function deleteFolder(id: string) {
    await adapter.deleteFolder(id);
    setFolders((prev) => prev.filter((f) => f.id !== id));
    // Pages in the deleted folder are soft-deleted by the adapter
    setPages((prev) => prev.filter((p) => p.folderId !== id));
  }

  async function scheduleOnce(pageId: string, start: string, end?: string): Promise<void> {
    const snapshot = pages.find((p) => p.id === pageId);
    // Optimistic update
    setPages((prev) =>
      prev.map((p) =>
        p.id === pageId ? { ...p, scheduledEnd: end ?? null, scheduledStart: start } : p
      )
    );
    return enqueue(pageId, async () => {
      try {
        const schedules = await adapter.listPageSchedules(pageId);
        const existing = schedules.find((s) => !s.ruleId);
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (existing) {
          await adapter.updatePageSchedule(existing.id, {
            scheduledEnd: end ?? null,
            scheduledStart: start,
          });
        } else {
          await adapter.createPageSchedule({
            pageId,
            scheduledStart: start,
            ...(end !== undefined && { scheduledEnd: end }),
            timezone: tz,
          });
        }
      } catch (e) {
        if (snapshot) {
          setPages((prev) => prev.map((p) => (p.id === pageId ? snapshot : p)));
        }
        setPageErrors((prev) =>
          new Map(prev).set(pageId, e instanceof Error ? e.message : String(e))
        );
        throw e;
      }
    });
  }

  async function clearSchedule(pageId: string): Promise<void> {
    const snapshot = pages.find((p) => p.id === pageId);
    // Optimistic update
    setPages((prev) =>
      prev.map((p) => (p.id === pageId ? { ...p, scheduledEnd: null, scheduledStart: null } : p))
    );
    return enqueue(pageId, async () => {
      try {
        const schedules = await adapter.listPageSchedules(pageId);
        const oneOffs = schedules.filter((s) => !s.ruleId);
        await Promise.all(oneOffs.map((s) => adapter.deletePageSchedule(s.id)));
      } catch (e) {
        if (snapshot) {
          setPages((prev) => prev.map((p) => (p.id === pageId ? snapshot : p)));
        }
        setPageErrors((prev) =>
          new Map(prev).set(pageId, e instanceof Error ? e.message : String(e))
        );
        throw e;
      }
    });
  }

  // ─── Flush on window close ────────────────────────────────────────────────
  // Tauri's Rust side calls prevent_close() so we get a chance here to flush
  // any debounced writes, wait for all in-flight mutations, then destroy.

  useEffect(() => {
    if (import.meta.env["VITE_TEST_MODE"] === "true") return;

    let unlisten: (() => void) | undefined;

    async function register() {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      unlisten = await win.onCloseRequested(async (event) => {
        event.preventDefault();

        // Synchronously cancel all pending timers and add their writes to the queue
        for (const id of Array.from(pendingPatches.current.keys())) {
          const timer = debounceTimers.current.get(id);
          if (timer !== undefined) clearTimeout(timer);
          debounceTimers.current.delete(id);
          const accumulated = pendingPatches.current.get(id);
          if (!accumulated) continue;
          pendingPatches.current.delete(id);
          // Inline enqueue: best-effort write, swallow errors since we're closing
          const prev = mutationQueues.current.get(id) ?? Promise.resolve();
          const next = prev
            .then(() => adapter.updatePage(id, accumulated))
            .then(
              () => undefined,
              () => undefined
            );
          mutationQueues.current.set(id, next);
        }

        // Wait for all in-flight mutations (debounced writes + scheduleOnce etc.) to settle
        await Promise.allSettled(Array.from(mutationQueues.current.values()));
        await win.destroy();
      });
    }

    void register();
    return () => {
      unlisten?.();
    };
  }, [adapter]);

  async function reload() {
    await loadWorkspaceDataRef.current();
  }

  async function reorderFolders(orderedIds: string[]) {
    const snapshot = [...folders];
    setFolders((prev) => {
      const indexMap = new Map(orderedIds.map((id, i) => [id, i]));
      return [...prev].sort((a, b) => {
        const ai = indexMap.get(a.id) ?? a.sortOrder;
        const bi = indexMap.get(b.id) ?? b.sortOrder;
        return ai - bi;
      });
    });
    try {
      await adapter.reorderFolders(orderedIds);
    } catch {
      setFolders(snapshot);
    }
  }

  // ─── Derived tags ──────────────────────────────────────────────────────────

  const tags = deriveTags(pages);

  // ─── Context value ────────────────────────────────────────────────────────

  function getPage(id: string): Promise<Page | null> {
    return adapter.getPage(id);
  }

  function searchPages(query: string, includeCompleted?: boolean): Promise<SearchResponse> {
    return adapter.searchPages(query, includeCompleted);
  }

  function searchTags(query: string): Promise<string[]> {
    return adapter.searchTags(query);
  }

  async function resetAndSeed(scenario: "tutorial" | "realistic" | "stress"): Promise<void> {
    if (import.meta.env["VITE_TEST_MODE"] === "true") {
      (adapter as MockStorageAdapter).clear();
    } else {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("reset_db");
    }
    if (scenario === "tutorial") {
      const { seedTutorial } = await import("@/shared/seeds/tutorial");
      const result = await seedTutorial(adapter);
      if (result) {
        pendingNavigationRef.current = {
          folderId: result.folderId,
          pageId: result.welcomePageId,
        };
      }
    } else if (scenario === "realistic") {
      const { seedRealistic } = await import("@/shared/seeds/realistic");
      await seedRealistic(adapter);
    } else if (scenario === "stress") {
      const { seedStress } = await import("@/shared/seeds/stress");
      await seedStress(adapter);
    }
    await loadWorkspaceDataRef.current();
  }

  const value: WorkspaceContextValue = {
    clearPageError,
    clearSchedule,
    consumePendingNavigation,
    createFolder,
    createPage,
    deleteFolder,
    deletePage,
    flushPage,
    folders,
    getPage,
    isLoading,
    on,
    pageErrors,
    pages,
    reload,
    reorderFolders,
    reorderPages,
    resetAndSeed,
    restorePage,
    scheduleOnce,
    searchPages,
    searchTags,
    selectWorkspace,
    softDeletePage,
    tags,
    updateFolder,
    updatePage,
    workspace,
  };

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
// eslint-disable-next-line react-refresh/only-export-components
export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within <WorkspaceProvider>");
  return ctx;
}
