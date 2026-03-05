"use client";

// VaultContext — owns all data + mutations: pages, folders, tags.
// Adapter is created once on mount; vault connection is triggered by selectVault().
// selectVault() is a stub — full implementation lives in GOO-15 (welcome screen).

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Folder, Page, Tag, Vault } from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core";
import type { FolderUpdate, PageUpdate, StorageAdapter } from "@pikos/core";
import { TauriSQLiteAdapter, connectDb } from "@/shared/adapters/TauriSQLiteAdapter";

// ─── Event emitter ────────────────────────────────────────────────────────────

type VaultEvent = "page:created" | "page:updated" | "page:deleted" | "vault:loaded";

interface EventPayloadMap {
  "page:created": Page;
  "page:updated": Page;
  "page:deleted": string;
  "vault:loaded": Vault;
}

type AnyHandler = (payload: unknown) => void;

// ─── Context shape ────────────────────────────────────────────────────────────

export interface VaultContextValue {
  vault: Vault | null;
  pages: Page[];
  folders: Folder[];
  /** Derived reactively from pages[].tags — never stored separately. */
  tags: Tag[];
  isLoading: boolean;
  /** Opens a folder picker and connects the chosen vault. Full UI in GOO-15. */
  selectVault(): Promise<void>;
  createPage(opts: { title?: string; folderId?: string | null }): Promise<Page>;
  /** Debounced 800ms — optimistic update applied immediately; DB write batched. */
  updatePage(id: string, patch: PageUpdate): void;
  deletePage(id: string): Promise<void>;
  createFolder(opts: { name: string; color?: string }): Promise<Folder>;
  updateFolder(id: string, updates: FolderUpdate): Promise<void>;
  deleteFolder(id: string): Promise<void>;
  reorderPages(folderId: string | null, orderedIds: string[]): Promise<void>;
  reorderFolders(orderedIds: string[]): Promise<void>;
  on<E extends VaultEvent>(event: E, handler: (payload: EventPayloadMap[E]) => void): () => void;
}

const VaultContext = createContext<VaultContextValue | null>(null);

// ─── Derived tags ─────────────────────────────────────────────────────────────

function deriveTags(pages: Page[]): Tag[] {
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

export function VaultProvider({ children }: { children: ReactNode }) {
  const [adapter] = useState<StorageAdapter>(() =>
    import.meta.env["VITE_TEST_MODE"] === "true"
      ? new MockStorageAdapter()
      : new TauriSQLiteAdapter()
  );

  const [vault, setVault] = useState<Vault | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Lightweight event emitter
  const listenersRef = useRef(new Map<string, Set<AnyHandler>>());

  const emit = useCallback(<E extends VaultEvent>(event: E, payload: EventPayloadMap[E]) => {
    listenersRef.current.get(event)?.forEach((h) => h(payload as unknown));
  }, []);

  const on = useCallback(
    <E extends VaultEvent>(event: E, handler: (payload: EventPayloadMap[E]) => void) => {
      let set = listenersRef.current.get(event);
      if (!set) {
        set = new Set();
        listenersRef.current.set(event, set);
      }
      set.add(handler as AnyHandler);
      return () => {
        listenersRef.current.get(event)?.delete(handler as AnyHandler);
      };
    },
    []
  );

  // Load all data after vault connection
  const loadVaultData = useCallback(async () => {
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
  }, [adapter]);

  // selectVault — stub; full vault selection UX is GOO-15
  const selectVault = useCallback((): Promise<void> => {
    // TODO GOO-15: open dialog, persist vault config, call connectDb(path)
    // For now, connect to a test DB so the app is usable during development
    if (!(import.meta.env.DEV === true && import.meta.env["VITE_TEST_MODE"] !== "true")) {
      return Promise.resolve();
    }
    const testPath = "/tmp/pikos-dev.sqlite";
    const devVault: Vault = {
      id: "dev",
      name: "Dev Vault",
      dbPath: testPath,
      createdAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
    };
    return connectDb(testPath)
      .then(() => loadVaultData())
      .then(() => {
        setVault(devVault);
        emit("vault:loaded", devVault);
      });
  }, [loadVaultData, emit]);

  // ─── Debounced updatePage ──────────────────────────────────────────────────

  const pendingPatches = useRef<Map<string, PageUpdate>>(new Map());
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const updatePage = useCallback(
    (id: string, patch: PageUpdate): void => {
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
          setPages((prev) => prev.map((p) => (p.id === id ? updated : p)));
          emit("page:updated", updated);
        });
      }, 800);

      debounceTimers.current.set(id, timer);
    },
    [adapter, emit]
  );

  // ─── Pages ────────────────────────────────────────────────────────────────

  const createPage = useCallback(
    async ({ title, folderId }: { title?: string; folderId?: string | null }) => {
      const page = await adapter.createPage({
        title: title ?? "",
        folderId: folderId ?? null,
        content: "",
        status: "not_started",
        priority: 0,
        tags: [],
      });
      setPages((prev) => [...prev, page]);
      emit("page:created", page);
      return page;
    },
    [adapter, emit]
  );

  const deletePage = useCallback(
    async (id: string) => {
      await adapter.deletePage(id);
      setPages((prev) => prev.filter((p) => p.id !== id));
      emit("page:deleted", id);
    },
    [adapter, emit]
  );

  const reorderPages = useCallback(
    async (folderId: string | null, orderedIds: string[]) => {
      await adapter.reorderPages(folderId, orderedIds);
      setPages((prev) => {
        const indexMap = new Map(orderedIds.map((id, i) => [id, i]));
        return [...prev].sort((a, b) => {
          const ai = indexMap.get(a.id) ?? a.sortOrder;
          const bi = indexMap.get(b.id) ?? b.sortOrder;
          return ai - bi;
        });
      });
    },
    [adapter]
  );

  // ─── Folders ──────────────────────────────────────────────────────────────

  const createFolder = useCallback(
    async ({ name, color }: { name: string; color?: string }) => {
      const folder = await adapter.createFolder({
        name,
        ...(color !== undefined && { color }),
        parentId: null,
      });
      setFolders((prev) => [...prev, folder]);
      return folder;
    },
    [adapter]
  );

  const updateFolder = useCallback(
    async (id: string, updates: FolderUpdate) => {
      const updated = await adapter.updateFolder(id, updates);
      setFolders((prev) => prev.map((f) => (f.id === id ? updated : f)));
    },
    [adapter]
  );

  const deleteFolder = useCallback(
    async (id: string) => {
      await adapter.deleteFolder(id);
      setFolders((prev) => prev.filter((f) => f.id !== id));
      // Pages in the deleted folder become inbox items (ON DELETE SET NULL in DB)
      setPages((prev) => prev.map((p) => (p.folderId === id ? { ...p, folderId: null } : p)));
    },
    [adapter]
  );

  const reorderFolders = useCallback(
    async (orderedIds: string[]) => {
      await adapter.reorderFolders(orderedIds);
      setFolders((prev) => {
        const indexMap = new Map(orderedIds.map((id, i) => [id, i]));
        return [...prev].sort((a, b) => {
          const ai = indexMap.get(a.id) ?? a.sortOrder;
          const bi = indexMap.get(b.id) ?? b.sortOrder;
          return ai - bi;
        });
      });
    },
    [adapter]
  );

  // ─── Derived tags ──────────────────────────────────────────────────────────

  const tags = useMemo(() => deriveTags(pages), [pages]);

  // ─── Context value ────────────────────────────────────────────────────────

  const value = useMemo<VaultContextValue>(
    () => ({
      vault,
      pages,
      folders,
      tags,
      isLoading,
      selectVault,
      createPage,
      updatePage,
      deletePage,
      createFolder,
      updateFolder,
      deleteFolder,
      reorderPages,
      reorderFolders,
      on,
    }),
    [
      vault,
      pages,
      folders,
      tags,
      isLoading,
      selectVault,
      createPage,
      updatePage,
      deletePage,
      createFolder,
      updateFolder,
      deleteFolder,
      reorderPages,
      reorderFolders,
      on,
    ]
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
// eslint-disable-next-line react-refresh/only-export-components
export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("useVault must be used within <VaultProvider>");
  return ctx;
}
