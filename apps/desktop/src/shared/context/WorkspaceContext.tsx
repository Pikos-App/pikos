"use client";

// WorkspaceContext — owns all data + mutations: pages, folders, tags.
// GOO-15: auto-creates/reopens workspace on mount via @tauri-apps/plugin-store.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Folder, Page, PageSummary, Tag, Workspace } from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core";
import type { FolderUpdate, PageUpdate, StorageAdapter } from "@pikos/core";
import { TauriSQLiteAdapter, connectDb } from "@/shared/adapters/TauriSQLiteAdapter";

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
  /** First-launch: create default workspace + connect. Subsequent: already handled on mount. */
  selectWorkspace: () => Promise<void>;
  createPage: (opts: { title?: string; folderId?: string | null }) => Promise<Page>;
  /** Debounced 800ms — optimistic update applied immediately; DB write batched. */
  updatePage: (id: string, patch: PageUpdate) => void;
  /** Immediately flush any pending debounced write for a page. */
  flushPage: (id: string) => Promise<void>;
  deletePage: (id: string) => Promise<void>;
  createFolder: (opts: { name: string; color?: string }) => Promise<Folder>;
  updateFolder: (id: string, updates: FolderUpdate) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  reorderPages: (folderId: string | null, orderedIds: string[]) => Promise<void>;
  reorderFolders: (orderedIds: string[]) => Promise<void>;
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
  // On first launch (empty store) → sets isLoading=false, workspace stays null → WelcomeScreen.

  useEffect(() => {
    if (import.meta.env["VITE_TEST_MODE"] === "true") {
      // Test mode: no Tauri APIs available; skip auto-init and show welcome
      setIsLoading(false);
      return;
    }

    async function initWorkspace() {
      try {
        const { load } = await import("@tauri-apps/plugin-store");
        const store = await load("workspaces.json", { autoSave: false, defaults: {} });
        const workspaces = (await store.get<Workspace[]>("workspaces")) ?? [];

        if (workspaces.length === 0) {
          setIsLoading(false);
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
  // Called by WelcomeScreen "Get started". Creates the default workspace on first launch.

  async function selectWorkspace(): Promise<void> {
    if (import.meta.env["VITE_TEST_MODE"] === "true") {
      // Test mode: set a mock workspace so the app shell renders
      const mockWs: Workspace = {
        id: "mock",
        name: "Test Workspace",
        dbPath: ":memory:",
        createdAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
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
        id: crypto.randomUUID(),
        name: "My Workspace",
        dbPath,
        createdAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
      };

      await connectDb(dbPath);

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

  function updatePage(id: string, patch: PageUpdate): void {
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

      void adapter.updatePage(id, accumulated).then((updated) => {
        const { content: _, contentText: _ct, ...summary } = updated;
        setPages((prev) => prev.map((p) => (p.id === id ? summary : p)));
        emit("page:updated", updated);
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

    const updated = await adapter.updatePage(id, accumulated);
    const { content: _, contentText: _ct, ...summary } = updated;
    setPages((prev) => prev.map((p) => (p.id === id ? summary : p)));
    emit("page:updated", updated);
  }

  // ─── Pages ────────────────────────────────────────────────────────────────

  async function createPage({ title, folderId }: { title?: string; folderId?: string | null }) {
    const page = await adapter.createPage({
      title: title ?? "",
      folderId: folderId ?? null,
      content: "",
      contentText: "",
      status: "not_started",
      priority: 0,
      tags: [],
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

  async function reorderPages(folderId: string | null, orderedIds: string[]) {
    await adapter.reorderPages(folderId, orderedIds);
    setPages((prev) => {
      const indexMap = new Map(orderedIds.map((id, i) => [id, i]));
      return prev.map((p) => {
        const newOrder = indexMap.get(p.id);
        return newOrder !== undefined ? { ...p, sortOrder: newOrder } : p;
      });
    });
  }

  // ─── Folders ──────────────────────────────────────────────────────────────

  async function createFolder({ name, color }: { name: string; color?: string }) {
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
    // Pages in the deleted folder become inbox items (ON DELETE SET NULL in DB)
    setPages((prev) => prev.map((p) => (p.folderId === id ? { ...p, folderId: null } : p)));
  }

  async function reorderFolders(orderedIds: string[]) {
    await adapter.reorderFolders(orderedIds);
    setFolders((prev) => {
      const indexMap = new Map(orderedIds.map((id, i) => [id, i]));
      return [...prev].sort((a, b) => {
        const ai = indexMap.get(a.id) ?? a.sortOrder;
        const bi = indexMap.get(b.id) ?? b.sortOrder;
        return ai - bi;
      });
    });
  }

  // ─── Derived tags ──────────────────────────────────────────────────────────

  const tags = deriveTags(pages);

  // ─── Context value ────────────────────────────────────────────────────────

  function getPage(id: string): Promise<Page | null> {
    return adapter.getPage(id);
  }

  const value: WorkspaceContextValue = {
    workspace,
    pages,
    folders,
    getPage,
    tags,
    isLoading,
    selectWorkspace,
    createPage,
    updatePage,
    flushPage,
    deletePage,
    createFolder,
    updateFolder,
    deleteFolder,
    reorderPages,
    reorderFolders,
    on,
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
