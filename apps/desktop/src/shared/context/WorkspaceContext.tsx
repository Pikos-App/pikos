// WorkspaceContext — workspace lifecycle. Owns adapter, workspace identity,
// init/seed/reset orchestration, and the event bus. Data state (pages,
// folders, schedules, recurrence) lives in PagesContext; import flow lives
// in ImportContext. Both nest inside this provider and dispatch their own
// data load via a registered loader callback.

import type { StorageAdapter, Workspace } from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core";
import { appDataDir } from "@tauri-apps/api/path";
import { load } from "@tauri-apps/plugin-store";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import { connectDb, TauriSQLiteAdapter } from "@/shared/adapters/TauriSQLiteAdapter";
import {
  createWorkspaceEventBus,
  type WorkspaceEvent,
  type WorkspaceEventBus,
  type WorkspaceEventPayloadMap,
} from "@/shared/events/workspaceEvents";
import { createLogger } from "@/shared/logger";

const log = createLogger("WorkspaceContext");

type DataLoader = () => Promise<void>;

type SeedScenario =
  | "tutorial"
  | "realistic"
  | "stress"
  | "notifications"
  | "calendar"
  | "calendar-colors"
  | "calendar-edges";

export interface WorkspaceContextValue {
  workspace: Workspace | null;
  isLoading: boolean;
  /** Set when the auto-init or selectWorkspace path fails. UI surfaces this
   *  so the user sees the actual error + a guidance message instead of an
   *  indefinite blank screen. No in-app retry — connect_db failure is
   *  almost always a path/permission issue that needs a relaunch. */
  loadError: unknown;
  /** Reload pages + folders from the DB (e.g. after an external seed). */
  reload: () => Promise<void>;
  /** First-launch: create default workspace + connect. Subsequent: already handled on mount. */
  selectWorkspace: () => Promise<void>;
  /** Consume one-shot navigation target set by tutorial seed. Returns null if none pending. */
  consumePendingNavigation: () => { pageId: string; folderId: string } | null;
  /** Dev tool: wipe all data and re-seed with a scenario. */
  resetAndSeed: (scenario: SeedScenario) => Promise<void>;
  on: <E extends WorkspaceEvent>(
    event: E,
    handler: (payload: WorkspaceEventPayloadMap[E]) => void
  ) => () => void;
  /** Direct access to the storage adapter — used by features that need raw CRUD (e.g. reminders). */
  storage: StorageAdapter | null;
}

interface WorkspaceInternalValue extends WorkspaceContextValue {
  /** Always-defined adapter (use storage publicly to gate on workspace readiness). */
  adapter: StorageAdapter;
  eventBus: WorkspaceEventBus;
  /** Register a data loader called during init/reload/resetAndSeed. Pass null to unregister. */
  registerDataLoader: (loader: DataLoader | null) => void;
}

const WorkspaceContext = createContext<WorkspaceInternalValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [adapter] = useState<StorageAdapter>(() =>
    import.meta.env["VITE_TEST_MODE"] === "true"
      ? new MockStorageAdapter()
      : new TauriSQLiteAdapter()
  );

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  // Start true so we don't flash the welcome screen before init completes
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  // One-shot navigation target from tutorial seed — consumed once by AppShell.
  const pendingNavigationRef = useRef<{ pageId: string; folderId: string } | null>(null);

  function consumePendingNavigation(): { pageId: string; folderId: string } | null {
    const nav = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    return nav;
  }

  const eventBusRef = useRef(createWorkspaceEventBus());
  const eventBus = eventBusRef.current;

  // PagesProvider registers its loader here on mount. Lifecycle calls it
  // during init / selectWorkspace / resetAndSeed / reload so a single
  // sequence (seed → set workspace → load data → emit) stays atomic.
  const dataLoaderRef = useRef<DataLoader>(async () => {});
  function registerDataLoader(loader: DataLoader | null) {
    dataLoaderRef.current = loader ?? (async () => {});
  }

  // ─── Auto-init on mount ────────────────────────────────────────────────────
  // Attempts to reopen the most recently used workspace from the store.
  // On first launch (empty store) → auto-creates workspace + seeds tutorial.

  // Init runs at most once per provider instance: concurrent callers (StrictMode
  // double-mount, HMR, anything that re-fires the effect) await the same
  // in-flight promise instead of racing. selectWorkspace() reuses the same ref.
  const initPromiseRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    initPromiseRef.current ??= runInit();
    void initPromiseRef.current;

    async function runInit(): Promise<void> {
      if (import.meta.env["VITE_TEST_MODE"] === "true") {
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
        await dataLoaderRef.current();
        setWorkspace({
          createdAt: new Date().toISOString(),
          dbPath: ":memory:",
          id: seedScenario ? "seed" : "mock",
          lastOpenedAt: new Date().toISOString(),
          name: seedScenario ? "Seed Workspace" : "Test Workspace",
        });
        setIsLoading(false);
        return;
      }

      try {
        const store = await load("workspaces.json", { autoSave: false, defaults: {} });
        const workspaces = (await store.get<Workspace[]>("workspaces")) ?? [];

        if (workspaces.length === 0) {
          // Call the impl directly: the public selectWorkspace dedups against
          // initPromiseRef, which is *this* in-flight promise, so calling it
          // here would self-await.
          await selectWorkspaceImpl();
          return;
        }

        const sorted = [...workspaces].sort((a, b) => {
          const ta = a.lastOpenedAt ?? "";
          const tb = b.lastOpenedAt ?? "";
          return tb.localeCompare(ta);
        });
        const ws = sorted[0]!;

        // connectDb uses create_if_missing — silently recreates if file is gone (stale path)
        await connectDb(ws.dbPath);

        const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
        await tauriInvoke("init_assets_dir");

        const now = new Date().toISOString();
        const updated: Workspace = { ...ws, lastOpenedAt: now };
        const updatedList = workspaces.map((w) => (w.id === ws.id ? updated : w));
        await store.set("workspaces", updatedList);
        await store.save();

        await dataLoaderRef.current();
        setWorkspace(updated);
        setIsLoading(false);
        log.info(`Workspace loaded (id=${ws.id})`);
        eventBus.emit("workspace:loaded", updated);
      } catch (e) {
        log.error("auto-init failed", e);
        setLoadError(e);
        setIsLoading(false);
      }
    }
  }, [adapter]);

  // ─── selectWorkspace ───────────────────────────────────────────────────────
  // Creates the default workspace on first launch. Called by initWorkspace when no workspaces exist.
  // Safe to call concurrently — re-entrant callers share the in-flight promise.

  function selectWorkspace(): Promise<void> {
    return (initPromiseRef.current ??= selectWorkspaceImpl());
  }

  async function selectWorkspaceImpl(): Promise<void> {
    if (import.meta.env["VITE_TEST_MODE"] === "true") {
      const mockWs: Workspace = {
        createdAt: new Date().toISOString(),
        dbPath: ":memory:",
        id: "mock",
        lastOpenedAt: new Date().toISOString(),
        name: "Test Workspace",
      };
      await dataLoaderRef.current();
      setWorkspace(mockWs);
      setIsLoading(false);
      eventBus.emit("workspace:loaded", mockWs);
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

      // Seed tutorial data for first-time users (idempotent — skips if already seeded).
      // A seed failure must not block workspace creation: an empty workspace is
      // recoverable for the user, but a hard error screen here would lock them
      // out of an otherwise-working DB. Log and continue.
      try {
        const { seedTutorial } = await import("@/shared/seeds/tutorial");
        const seedResult = await seedTutorial(adapter);
        if (seedResult) {
          log.info("Tutorial seed planted");
          pendingNavigationRef.current = {
            folderId: seedResult.folderId,
            pageId: seedResult.welcomePageId,
          };
        }
      } catch (seedError) {
        log.error("Tutorial seed failed — continuing with empty workspace", seedError);
      }

      const store = await load("workspaces.json", { autoSave: false, defaults: {} });
      const existing = (await store.get<Workspace[]>("workspaces")) ?? [];
      await store.set("workspaces", [...existing, ws]);
      await store.save();

      await dataLoaderRef.current();
      setWorkspace(ws);
      setIsLoading(false);
      log.info(`Workspace created (id=${ws.id})`);
      eventBus.emit("workspace:loaded", ws);
    } catch (e) {
      log.error("selectWorkspace failed", e);
      setLoadError(e);
      setIsLoading(false);
    }
  }

  async function reload() {
    await dataLoaderRef.current();
  }

  async function resetAndSeed(scenario: SeedScenario): Promise<void> {
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
    } else if (scenario === "notifications") {
      const { seedNotifications } = await import("@/shared/seeds/notifications");
      await seedNotifications(adapter);
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
    await dataLoaderRef.current();
  }

  const value: WorkspaceInternalValue = {
    adapter,
    consumePendingNavigation,
    eventBus,
    isLoading,
    loadError,
    on: eventBus.on,
    registerDataLoader,
    reload,
    resetAndSeed,
    selectWorkspace,
    storage: workspace ? adapter : null,
    workspace,
  };

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** For data (pages, folders, scheduling, recurrence) use `usePages()` from PagesContext. */
// eslint-disable-next-line react-refresh/only-export-components
export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within <WorkspaceProvider>");
  return ctx;
}

/**
 * Internal hook for nested providers (PagesProvider, ImportProvider). Returns
 * the adapter + event bus + data-loader registration. Don't use from feature
 * code — call useWorkspace() or usePages() instead.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useWorkspaceInternal(): WorkspaceInternalValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspaceInternal must be used within <WorkspaceProvider>");
  return ctx;
}
