"use client";

// WorkspaceContext — owns all data + mutations: pages, folders, tags.
// Auto-creates/reopens workspace on mount via @tauri-apps/plugin-store.

import type {
  CompletedPagesFilter,
  CompletedPagesResponse,
  Folder,
  Page,
  PagePriority,
  PageRecurrenceRule,
  PageStatus,
  PageSummary,
  SearchResponse,
  Tag,
  Workspace,
} from "@pikos/core";
import {
  computeNextEnd,
  MockStorageAdapter,
  nextOccurrenceAfter,
  parseLocalISO,
} from "@pikos/core";
import type {
  FolderUpdate,
  NewRecurrenceRule,
  PageUpdate,
  RecurrenceRuleUpdate,
  StorageAdapter,
} from "@pikos/core";
import { appDataDir } from "@tauri-apps/api/path";
import { load } from "@tauri-apps/plugin-store";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import { connectDb, TauriSQLiteAdapter } from "@/shared/adapters/TauriSQLiteAdapter";
import { createLogger } from "@/shared/logger";

const log = createLogger("WorkspaceContext");

/** Strip heavy fields (content, contentText) to produce a lightweight page summary for lists. */
function toPageSummary(page: Page): PageSummary {
  const { content: _, contentText: _ct, ...summary } = page;
  return summary;
}

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
  resetAndSeed: (
    scenario:
      | "tutorial"
      | "realistic"
      | "stress"
      | "calendar"
      | "calendar-colors"
      | "calendar-edges"
  ) => Promise<void>;
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
  /** Soft-delete folder + all its pages. Recoverable via restoreFolder. */
  softDeleteFolder: (id: string) => Promise<void>;
  /** Restore a soft-deleted folder and all its pages. */
  restoreFolder: (id: string) => Promise<void>;
  reorderPages: (folderId: string | null, orderedIds: string[]) => Promise<void>;
  reorderFolders: (orderedIds: string[]) => Promise<void>;
  /** Create or update the one-off schedule block for a page. */
  scheduleOnce: (pageId: string, start: string, end?: string) => Promise<void>;
  /** Delete all one-off schedule blocks for a page. */
  clearSchedule: (pageId: string) => Promise<void>;
  /** All recurrence rules (one per recurring page). */
  recurrenceRules: PageRecurrenceRule[];
  /** Create a recurrence rule for a page. */
  createRecurrence: (data: NewRecurrenceRule) => Promise<PageRecurrenceRule>;
  /** Update an existing recurrence rule. */
  updateRecurrence: (ruleId: string, updates: RecurrenceRuleUpdate) => Promise<PageRecurrenceRule>;
  /** Delete a recurrence rule by its ID. Cascades to materialised page_schedules overrides. */
  deleteRecurrence: (ruleId: string) => Promise<void>;
  /** List all materialised schedule rows in a date range (for rrule override filtering). */
  listSchedulesRange: (start: string, end: string) => Promise<import("@pikos/core").PageSchedule[]>;
  /** Complete a recurring page: clone as done, advance head to next occurrence. */
  completeRecurringPage: (pageId: string) => Promise<void>;
  /** Skip a single occurrence of a recurring page (add date to exdates). Returns an undo function. */
  skipOccurrence: (ruleId: string, date: string) => Promise<() => void>;
  /** Paginated completed pages — lazy-loaded when the "Completed" section is expanded. */
  listCompletedPages: (filter: CompletedPagesFilter) => Promise<CompletedPagesResponse>;
  /** Merge lazy-loaded pages (e.g. completed) into the pages array, deduplicating by ID. */
  mergePages: (incoming: PageSummary[]) => void;
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
  /** Batch-import pages and folders from an external source. Returns IDs for undo. */
  importBatch: (data: ImportBatchInput) => Promise<ImportBatchResult>;
  /** Direct access to the storage adapter — used by features that need raw CRUD (e.g. reminders). */
  storage: StorageAdapter | null;
  /** Result of the last import — persists across settings open/close for undo. */
  lastImportResult: LastImportResult | null;
  /** Clear the last import result (after user dismisses). */
  clearLastImport: () => void;
  /** Undo the last import — soft-deletes all imported pages and folders. */
  undoLastImport: () => Promise<void>;
}

/** Input for batch import. */
export interface ImportBatchItem {
  title: string;
  content: string;
  contentText: string;
  folderKey: string | null;
  status: PageStatus;
  priority: PagePriority;
  tags: string[];
  scheduledStart: string | null;
  scheduledEnd: string | null;
  createdAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  sourceId: string | null;
  sourceParentId: string | null;
  /** Per-page reminder lead times in minutes (from TickTick import). */
  reminderMinutes: number[];
}

export interface ImportBatchFolder {
  key: string;
  name: string;
}

export interface ImportBatchInput {
  pages: ImportBatchItem[];
  folders: ImportBatchFolder[];
  batchTag: string;
  source: string;
}

export interface LastImportResult {
  pageIds: string[];
  folderIds: string[];
  pageCount: number;
  folderCount: number;
  source: string;
  importedAt: string;
}

export interface ImportBatchResult {
  pageIds: string[];
  folderIds: string[];
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
  const [recurrenceRules, setRecurrenceRules] = useState<PageRecurrenceRule[]>([]);
  // Start true so we don't flash the welcome screen before init completes
  const [isLoading, setIsLoading] = useState(true);
  const [lastImportResult, setLastImportResult] = useState<LastImportResult | null>(null);

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
  // Loads only active pages at init; completed pages are fetched lazily —
  // via useCompletedPages for the per-folder Completed section, and via
  // CalendarView for the visible date range.
  const loadWorkspaceDataRef = useRef(async () => {
    setIsLoading(true);
    try {
      const [loadedPages, loadedFolders, loadedRules] = await Promise.all([
        adapter.listPages({ status: "not_started" }),
        adapter.listFolders(),
        adapter.listRecurrenceRules(),
      ]);
      setPages(loadedPages);
      setFolders(loadedFolders);
      setRecurrenceRules(loadedRules);
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
        if (seedScenario === "tutorial") {
          const { seedTutorial } = await import("@/shared/seeds/tutorial");
          const result = await seedTutorial(adapter);
          if (result) {
            pendingNavigationRef.current = {
              folderId: result.folderId,
              pageId: result.welcomePageId,
            };
          }
        } else if (import.meta.env.DEV && seedScenario === "marketing") {
          const { seedMarketing } = await import("@/shared/seeds/marketing");
          await seedMarketing(adapter);
        } else if (import.meta.env.DEV && seedScenario === "realistic") {
          const { seedRealistic } = await import("@/shared/seeds/realistic");
          await seedRealistic(adapter);
        } else if (import.meta.env.DEV && seedScenario === "stress") {
          const { seedStress } = await import("@/shared/seeds/stress");
          await seedStress(adapter);
        } else if (import.meta.env.DEV && seedScenario === "calendar") {
          const { seedCalendar } = await import("@/shared/seeds/calendar");
          await seedCalendar(adapter);
        } else if (import.meta.env.DEV && seedScenario === "calendar-colors") {
          const { seedCalendarColors } = await import("@/shared/seeds/calendarColors");
          await seedCalendarColors(adapter);
        } else if (import.meta.env.DEV && seedScenario === "calendar-edges") {
          const { seedCalendarEdgeCases } = await import("@/shared/seeds/calendarEdgeCases");
          await seedCalendarEdgeCases(adapter);
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

        // Ensure the workspace assets directory exists alongside the DB
        const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
        await tauriInvoke("init_assets_dir");

        // Update lastOpenedAt in the registry
        const now = new Date().toISOString();
        const updated: Workspace = { ...ws, lastOpenedAt: now };
        const updatedList = workspaces.map((w) => (w.id === ws.id ? updated : w));
        await store.set("workspaces", updatedList);
        await store.save();

        await loadWorkspaceDataRef.current();
        setWorkspace(updated);
        log.info(`Workspace loaded (id=${ws.id})`);
        listenersRef.current.get("workspace:loaded")?.forEach((h) => h(updated as unknown));
      } catch (e) {
        log.error("auto-init failed", e);
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

      // Ensure the workspace assets directory exists alongside the DB
      const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
      await tauriInvoke("init_assets_dir");

      // Seed tutorial data for first-time users (idempotent — skips if already seeded)
      const { seedTutorial } = await import("@/shared/seeds/tutorial");
      const seedResult = await seedTutorial(adapter);
      if (seedResult) {
        log.info("Tutorial seed planted");
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
      log.info(`Workspace created (id=${ws.id})`);
      emit("workspace:loaded", ws);
    } catch (e) {
      log.error("selectWorkspace failed", e);
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
        const summary = toPageSummary(updated);
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
    setPages((prev) => [...prev, toPageSummary(page)]);
    emit("page:created", page);
    return page;
  }

  async function deletePage(id: string) {
    // Cancel any pending debounced write for this page
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
      setPages((prev) => [...prev, toPageSummary(page)]);
    }
  }

  function mergePages(incoming: PageSummary[]) {
    setPages((prev) => {
      const existing = new Set(prev.map((p) => p.id));
      const newPages = incoming.filter((p) => !existing.has(p.id));
      return newPages.length > 0 ? [...prev, ...newPages] : prev;
    });
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
    // Optimistic update — apply immediately so the UI never flashes the old value.
    setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, ...updates } : f)));
    const updated = await adapter.updateFolder(id, updates);
    setFolders((prev) => prev.map((f) => (f.id === id ? updated : f)));
  }

  async function deleteFolder(id: string) {
    await adapter.deleteFolder(id);
    setFolders((prev) => prev.filter((f) => f.id !== id));
    // Pages in the deleted folder are soft-deleted by the adapter
    setPages((prev) => prev.filter((p) => p.folderId !== id));
  }

  async function softDeleteFolder(id: string) {
    await adapter.softDeleteFolder(id);
    setFolders((prev) => prev.filter((f) => f.id !== id));
    setPages((prev) => prev.filter((p) => p.folderId !== id));
  }

  async function restoreFolder(id: string) {
    await adapter.restoreFolder(id);
    // Re-fetch folders and pages to get the restored state
    const [loadedPages, loadedFolders] = await Promise.all([
      adapter.listPages({ status: "not_started" }),
      adapter.listFolders(),
    ]);
    setPages(loadedPages);
    setFolders(loadedFolders);
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

  // ─── Recurrence rules ─────────────────────────────────────────────────────

  async function createRecurrence(data: NewRecurrenceRule): Promise<PageRecurrenceRule> {
    const rule = await adapter.createRecurrenceRule(data);
    setRecurrenceRules((prev) => [...prev, rule]);
    return rule;
  }

  async function updateRecurrence(
    ruleId: string,
    updates: RecurrenceRuleUpdate
  ): Promise<PageRecurrenceRule> {
    const updated = await adapter.updateRecurrenceRule(ruleId, updates);
    setRecurrenceRules((prev) => prev.map((r) => (r.id === ruleId ? updated : r)));
    return updated;
  }

  async function deleteRecurrence(ruleId: string): Promise<void> {
    await adapter.deleteRecurrenceRule(ruleId);
    setRecurrenceRules((prev) => prev.filter((r) => r.id !== ruleId));
  }

  function listSchedulesRange(start: string, end: string) {
    return adapter.listPageSchedulesRange(start, end);
  }

  async function completeRecurringPage(pageId: string): Promise<void> {
    const rule = recurrenceRules.find((r) => r.pageId === pageId);
    if (!rule) throw new Error(`No recurrence rule for page ${pageId}`);

    // Advance past whichever is later: today or the current occurrence.
    // - If head is overdue (scheduledStart in the past): use today → skips missed occurrences.
    // - If head is future (completing early): use scheduledStart → ensures we advance past it.
    const head = pages.find((p) => p.id === pageId);
    const headDate = head?.scheduledStart ? parseLocalISO(head.scheduledStart) : new Date();
    const afterDate = headDate > new Date() ? headDate : new Date();
    const next = nextOccurrenceAfter(rule.rrule, rule.scheduledStart, afterDate);
    const nextEnd =
      next && rule.scheduledEnd ? computeNextEnd(rule.scheduledEnd, next.scheduledStart) : null;

    // Add the completed date to exdates so the virtual expansion won't generate
    // a duplicate for this date (the clone now occupies it as a real page).
    const completedDate = head?.scheduledStart?.slice(0, 10);
    const updatedExdates = completedDate
      ? [...rule.rruleExdates, completedDate]
      : rule.rruleExdates;

    // Persist both changes to DB
    const [result] = await Promise.all([
      adapter.completeRecurringPage({
        nextScheduledEnd: nextEnd,
        nextScheduledStart: next?.scheduledStart ?? null,
        pageId,
      }),
      completedDate
        ? adapter.updateRecurrenceRule(rule.id, { rruleExdates: updatedExdates })
        : Promise.resolve(null),
    ]);

    // Batch all state updates together so React renders them atomically.
    // Clone renders on the calendar as a done block (independent page).
    // Exdate prevents the virtual expansion from generating a duplicate.
    setRecurrenceRules((prev) =>
      prev.map((r) => (r.id === rule.id ? { ...r, rruleExdates: updatedExdates } : r))
    );
    setPages((prev) => {
      const updated = prev.map((p) => (p.id === pageId ? result.head : p));
      return [...updated, result.clone];
    });
  }

  async function skipOccurrence(ruleId: string, date: string): Promise<() => void> {
    const rule = recurrenceRules.find((r) => r.id === ruleId);
    if (!rule) throw new Error(`Recurrence rule not found: ${ruleId}`);

    const updatedExdates = [...rule.rruleExdates, date];
    await adapter.updateRecurrenceRule(ruleId, { rruleExdates: updatedExdates });
    setRecurrenceRules((prev) =>
      prev.map((r) => (r.id === ruleId ? { ...r, rruleExdates: updatedExdates } : r))
    );

    // Return undo function
    return () => {
      const restored = updatedExdates.filter((d) => d !== date);
      void adapter.updateRecurrenceRule(ruleId, { rruleExdates: restored }).then(() => {
        setRecurrenceRules((prev) =>
          prev.map((r) => (r.id === ruleId ? { ...r, rruleExdates: restored } : r))
        );
      });
    };
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

  function listCompletedPages(filter: CompletedPagesFilter): Promise<CompletedPagesResponse> {
    return adapter.listCompletedPages(filter);
  }

  function searchPages(query: string, includeCompleted?: boolean): Promise<SearchResponse> {
    return adapter.searchPages(query, includeCompleted);
  }

  function searchTags(query: string): Promise<string[]> {
    return adapter.searchTags(query);
  }

  async function resetAndSeed(
    scenario:
      | "tutorial"
      | "realistic"
      | "stress"
      | "calendar"
      | "calendar-colors"
      | "calendar-edges"
  ): Promise<void> {
    if (!import.meta.env.DEV) return;
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
    } else if (scenario === "calendar") {
      const { seedCalendar } = await import("@/shared/seeds/calendar");
      await seedCalendar(adapter);
    } else if (scenario === "calendar-colors") {
      const { seedCalendarColors } = await import("@/shared/seeds/calendarColors");
      await seedCalendarColors(adapter);
    } else if (scenario === "calendar-edges") {
      const { seedCalendarEdgeCases } = await import("@/shared/seeds/calendarEdgeCases");
      await seedCalendarEdgeCases(adapter);
    }
    await loadWorkspaceDataRef.current();
  }

  async function importBatch(data: ImportBatchInput): Promise<ImportBatchResult> {
    const folderIds: string[] = [];
    const pageIds: string[] = [];

    // Build a map of existing folders by name for dedup
    const existingFoldersByName = new Map(folders.map((f) => [f.name, f]));

    // Create or resolve folders
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

    // Create pages (pass 1: create all pages, track source ID → Pikos ID mapping)
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
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

      // Track source ID mapping for parent resolution
      if (p.sourceId) {
        sourceIdToPikosId.set(p.sourceId, page.id);
      }
      if (p.sourceParentId) {
        pagesNeedingParent.push({ pikosId: page.id, sourceParentId: p.sourceParentId });
      }

      // Create schedule if needed
      if (p.scheduledStart) {
        await adapter.createPageSchedule({
          pageId: page.id,
          scheduledStart: p.scheduledStart,
          ...(p.scheduledEnd ? { scheduledEnd: p.scheduledEnd } : {}),
          timezone: tz,
        });
      }

      // Create per-page reminders if any (from TickTick import)
      for (const mins of p.reminderMinutes) {
        await adapter.createPageReminder({ minutesBefore: mins, pageId: page.id });
      }
    }

    // Pass 2: resolve parent IDs
    for (const { pikosId, sourceParentId } of pagesNeedingParent) {
      const parentPikosId = sourceIdToPikosId.get(sourceParentId);
      if (parentPikosId) {
        await adapter.updatePage(pikosId, { parentId: parentPikosId });
      }
    }

    // Store result for undo before reload (reload unmounts components, losing local state)
    const result = {
      folderCount: folderIds.length,
      folderIds,
      importedAt: new Date().toISOString(),
      pageCount: data.pages.length,
      pageIds,
      source: data.source,
    };
    setLastImportResult(result);

    // Reload all data to reflect the import
    await loadWorkspaceDataRef.current();

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
    await loadWorkspaceDataRef.current();
  }

  const value: WorkspaceContextValue = {
    clearLastImport,
    clearPageError,
    clearSchedule,
    completeRecurringPage,
    consumePendingNavigation,
    createFolder,
    createPage,
    createRecurrence,
    deleteFolder,
    deletePage,
    deleteRecurrence,
    flushPage,
    folders,
    getPage,
    importBatch,
    isLoading,
    lastImportResult,
    listCompletedPages,
    listSchedulesRange,
    mergePages,
    on,
    pageErrors,
    pages,
    recurrenceRules,
    reload,
    reorderFolders,
    reorderPages,
    resetAndSeed,
    restoreFolder,
    restorePage,
    scheduleOnce,
    searchPages,
    searchTags,
    selectWorkspace,
    skipOccurrence,
    softDeleteFolder,
    softDeletePage,
    storage: workspace ? adapter : null,
    tags,
    undoLastImport,
    updateFolder,
    updatePage,
    updateRecurrence,
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
