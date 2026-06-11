import { useEffect, useRef } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { RecurringCompleteDialog } from "@/features/calendar/components/RecurringCompleteDialog";
import { ThreePanelLayout } from "@/features/layout";
import { QuickAddDialog, UNDO_TOAST_DURATION_MS } from "@/features/pages";
import { SearchPalette } from "@/features/search";
import { SettingsPage } from "@/features/settings";
import { PaneErrorFallback } from "@/shared/components/PaneErrorFallback";
import { Toast } from "@/shared/components/Toast";
import { UpdateDialog } from "@/shared/components/UpdateDialog";
import { AppSettingsProvider } from "@/shared/context/AppSettingsContext";
import { CalendarDnDProvider } from "@/shared/context/CalendarDnDContext";
import { CalendarSettingsProvider } from "@/shared/context/CalendarSettingsContext";
import { EditorSettingsProvider } from "@/shared/context/EditorSettingsContext";
import { ImportProvider } from "@/shared/context/ImportContext";
import { ListSettingsProvider } from "@/shared/context/ListSettingsContext";
import { PagesProvider, usePages } from "@/shared/context/PagesContext";
import { RecurringCompleteDialogProvider } from "@/shared/context/RecurringCompleteDialogContext";
import { SelectionProvider } from "@/shared/context/SelectionContext";
import { ThemeProvider } from "@/shared/context/ThemeContext";
import { UIProvider, useUI } from "@/shared/context/UIContext";
import { UndoDeleteProvider, useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { UpdateProvider, useUpdate } from "@/shared/context/UpdateContext";
import { WorkspaceProvider } from "@/shared/context/WorkspaceContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useDeepLinkRouter } from "@/shared/deep-link/useDeepLinkRouter";
import { ErrorBoundary } from "@/shared/ErrorBoundary";
import { useExternalChangeReload } from "@/shared/hooks/useExternalChangeReload";
import { Keyboard } from "@/shared/keyboard/registry";
import { useKeyboardListener, useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

function useTrackPageOpened() {
  const { activePageId } = useUI();
  const { updatePage } = usePages();
  const prevIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (activePageId && activePageId !== prevIdRef.current) {
      prevIdRef.current = activePageId;
      updatePage(activePageId, { lastOpenedAt: new Date().toISOString() });
    }
    if (!activePageId) prevIdRef.current = null;
  }, [activePageId]);
}

/** Native menu event IDs — Rust calls `webview.eval('__onMenuEvent("<id>")')`
 *  from src-tauri so the strings must stay in sync. Keep this union and the
 *  Rust dispatch list synchronised on every menu addition. */
type MenuEventId =
  | "new_page"
  | "close_page"
  | "settings"
  | "toggle_sidebar"
  | "toggle_calendar"
  | "check_updates"
  | "keyboard_shortcuts";

declare global {
  interface Window {
    __onMenuEvent?: (id: MenuEventId) => void;
  }
}

/** Handle native menu events via global callback invoked from Tauri eval(). */
function useMenuEvents() {
  const ui = useUI();
  const updater = useUpdate();
  const { setRightPanel, setSidebarCollapsed } = ui;
  const stateRef = useRef({ rightPanel: ui.rightPanel });
  const updaterRef = useRef(updater);

  useEffect(() => {
    stateRef.current = { rightPanel: ui.rightPanel };
    updaterRef.current = updater;
  });

  useEffect(() => {
    window.__onMenuEvent = (id) => {
      switch (id) {
        case "new_page":
          ui.setOpenDialog("quick-add");
          break;
        case "close_page":
          ui.setActivePage(null);
          break;
        case "settings":
          ui.setSettingsOpen(true);
          break;
        case "toggle_sidebar":
          setSidebarCollapsed((prev: boolean) => !prev);
          break;
        case "toggle_calendar": {
          const current = stateRef.current.rightPanel;
          setRightPanel(current === "calendar" ? "editor" : "calendar");
          break;
        }
        case "check_updates":
          updaterRef.current.checkForUpdates();
          break;
        case "keyboard_shortcuts":
          ui.setSettingsSection("shortcuts");
          ui.setSettingsOpen(true);
          break;
      }
    };
    return () => {
      delete window.__onMenuEvent;
    };
  }, [setSidebarCollapsed, setRightPanel]);
}

function useGlobalShortcuts() {
  const { setActivePage, setActiveViewId, setSettingsOpen, setSettingsSection, settingsOpen } =
    useUI();
  const { folders } = usePages();

  useKeyboardShortcut("Mod+,", () => setSettingsOpen(!settingsOpen), { allowInInputs: true });
  useKeyboardShortcut("Mod+W", () => setActivePage(null), { allowInInputs: true });
  // Cmd+/ — macOS reserves Cmd+? for the Help menu's search field, so we use
  // Cmd+/ (the standard for shortcut overlays — Linear, Notion, Slack).
  useKeyboardShortcut(
    "Mod+/",
    () => {
      setSettingsSection("shortcuts");
      setSettingsOpen(true);
    },
    { allowInInputs: true }
  );

  // ⌘1-9 — switch to folder by index (1-based).
  // Use the Keyboard registry directly to register all 9 bindings in one effect,
  // avoiding calling useKeyboardShortcut in a loop (violates rules of hooks).
  const foldersRef = useRef(folders);
  const setViewRef = useRef(setActiveViewId);
  foldersRef.current = folders;
  setViewRef.current = setActiveViewId;

  useEffect(() => {
    const ids: string[] = [];
    for (let i = 1; i <= 9; i++) {
      const id = `global-folder-${i}`;
      ids.push(id);
      Keyboard.register({
        allowInInputs: true,
        combo: `Mod+${i}`,
        handler: () => {
          const folder = foldersRef.current[i - 1];
          if (folder) setViewRef.current(folder.id);
        },
        id,
        scope: "global",
      });
    }
    return () => ids.forEach((id) => Keyboard.unregister(id));
  }, []);
}

function AppShell() {
  useKeyboardListener();
  useTrackPageOpened();
  useGlobalShortcuts();
  useMenuEvents();
  useDeepLinkRouter();
  useExternalChangeReload();
  // Mark first usable render — workspace loaded, shell mounted, layout about to paint.
  // Perf tests measure boot time to this mark instead of domInteractive (which fires
  // before React mounts).
  useEffect(() => {
    performance.mark("pikos:ready");
  }, []);
  const updater = useUpdate();
  const { consumePendingNavigation } = useWorkspace();
  const ui = useUI();
  const { folders, pages } = usePages();
  const { handleToastDismiss, toastItems } = useUndoDelete();

  // One-shot: validate persisted view/page, then consume one-shot tutorial nav.
  // pages[] only contains active (not_started, not soft-deleted) summaries, so a
  // missing ID covers all the "shouldn't restore" cases — completed, soft-deleted,
  // or genuinely gone.
  const didInitRef = useRef<boolean | null>(null);
  if (didInitRef.current == null) {
    didInitRef.current = true;

    if (
      ui.activeViewId !== "today" &&
      ui.activeViewId !== "inbox" &&
      !folders.some((f) => f.id === ui.activeViewId)
    ) {
      ui.setActiveViewId("inbox");
    }
    if (ui.activePageId !== null && !pages.some((p) => p.id === ui.activePageId)) {
      ui.setActivePage(null);
    }
    if (ui.lastEditorPageId !== null && !pages.some((p) => p.id === ui.lastEditorPageId)) {
      ui.setLastEditorPageId(null);
    }

    const nav = consumePendingNavigation();
    if (nav) {
      ui.setActiveViewId(nav.folderId);
      ui.openPage(nav.pageId);
    }
  }
  // Per-surface ErrorBoundary so a render error in one dialog/page can't
  // black-screen the rest of the shell. Each boundary uses a compact inline
  // fallback (PaneErrorFallback) — the app-level full-screen boundary in
  // <App> below stays as the last-resort catch.
  return (
    <>
      <ThreePanelLayout />
      <ErrorBoundary
        fallback={({ error, reset }) => (
          <PaneErrorFallback error={error} label="Settings" onReset={reset} />
        )}
      >
        <SettingsPage />
      </ErrorBoundary>
      <ErrorBoundary
        fallback={({ error, reset }) => (
          <PaneErrorFallback error={error} label="Quick Add" onReset={reset} />
        )}
      >
        <QuickAddDialog />
      </ErrorBoundary>
      <ErrorBoundary
        fallback={({ error, reset }) => (
          <PaneErrorFallback error={error} label="Search" onReset={reset} />
        )}
      >
        <SearchPalette />
      </ErrorBoundary>
      <Toast duration={UNDO_TOAST_DURATION_MS} items={toastItems} onDismiss={handleToastDismiss} />
      <UpdateDialog updater={updater} />
    </>
  );
}

function WorkspaceLoadError({ error }: { error: unknown }) {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-md">
        <p className="text-lg font-medium">Couldn't open your workspace</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Quit and relaunch the app. If this keeps happening, file a bug — connect_db failures are
          usually a path or permission problem on disk.
        </p>
        <pre className="mt-4 max-h-48 overflow-auto rounded-md border border-border bg-card px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {detail}
        </pre>
      </div>
    </div>
  );
}

function WorkspaceGate() {
  const { isLoading, loadError, workspace } = useWorkspace();

  if (loadError !== null) {
    return <WorkspaceLoadError error={loadError} />;
  }
  if (isLoading || !workspace) {
    // Blank while initializing — workspace is auto-created on first launch
    return null;
  }

  return <AppShell />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <AppSettingsProvider>
          <WorkspaceProvider>
            <PagesProvider>
              <ImportProvider>
                <UpdateProvider>
                  <UIProvider>
                    <SelectionProvider>
                      <CalendarDnDProvider>
                        <EditorSettingsProvider>
                          <CalendarSettingsProvider>
                            <ListSettingsProvider>
                              <UndoDeleteProvider>
                                <RecurringCompleteDialogProvider>
                                  <TooltipProvider delayDuration={400}>
                                    <WorkspaceGate />
                                    <ErrorBoundary
                                      fallback={({ error, reset }) => (
                                        <PaneErrorFallback
                                          error={error}
                                          label="Recurring page dialog"
                                          onReset={reset}
                                        />
                                      )}
                                    >
                                      <RecurringCompleteDialog />
                                    </ErrorBoundary>
                                  </TooltipProvider>
                                </RecurringCompleteDialogProvider>
                              </UndoDeleteProvider>
                            </ListSettingsProvider>
                          </CalendarSettingsProvider>
                        </EditorSettingsProvider>
                      </CalendarDnDProvider>
                    </SelectionProvider>
                  </UIProvider>
                </UpdateProvider>
              </ImportProvider>
            </PagesProvider>
          </WorkspaceProvider>
        </AppSettingsProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
