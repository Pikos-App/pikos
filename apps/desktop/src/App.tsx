import { useEffect, useRef } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ThreePanelLayout } from "@/features/layout";
import { QuickAddDialog, UNDO_TOAST_DURATION_MS } from "@/features/pages";
import { SearchPalette } from "@/features/search";
import { SettingsPage } from "@/features/settings";
import { UndoToast } from "@/shared/components/UndoToast";
import { AppSettingsProvider } from "@/shared/context/AppSettingsContext";
import { EditorSettingsProvider } from "@/shared/context/EditorSettingsContext";
import { ThemeProvider } from "@/shared/context/ThemeContext";
import { UIProvider, useUI } from "@/shared/context/UIContext";
import { UndoDeleteProvider, useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { WorkspaceProvider } from "@/shared/context/WorkspaceContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { ErrorBoundary } from "@/shared/ErrorBoundary";
import { Keyboard } from "@/shared/keyboard/registry";
import { useKeyboardListener, useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

/** Update lastOpenedAt on the page whenever activePageId changes. */
function useTrackPageOpened() {
  const { activePageId } = useUI();
  const { updatePage } = useWorkspace();
  const prevIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (activePageId && activePageId !== prevIdRef.current) {
      prevIdRef.current = activePageId;
      updatePage(activePageId, { lastOpenedAt: new Date().toISOString() });
    }
    if (!activePageId) prevIdRef.current = null;
  }, [activePageId, updatePage]);
}

/** Listen for native menu events emitted from Tauri (View menu items). */
function useMenuEvents() {
  const { rightPanel, setRightPanel, setSidebarCollapsed, sidebarCollapsed } = useUI();
  const stateRef = useRef({ rightPanel, sidebarCollapsed });
  stateRef.current = { rightPanel, sidebarCollapsed };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      void listen<string>("menu-event", (event) => {
        if (event.payload === "toggle_sidebar") {
          setSidebarCollapsed((prev: boolean) => !prev);
        } else if (event.payload === "toggle_calendar") {
          const current = stateRef.current.rightPanel;
          setRightPanel(current === "calendar" ? "editor" : "calendar");
        }
      }).then((fn) => {
        unlisten = fn;
      });
    });
    return () => unlisten?.();
  }, [setSidebarCollapsed, setRightPanel]);
}

/** ⌘, opens settings, ⌘1-9 switches to folder by index. */
function useGlobalShortcuts() {
  const { setActiveViewId, setSettingsOpen, settingsOpen } = useUI();
  const { folders } = useWorkspace();

  useKeyboardShortcut("Mod+,", () => setSettingsOpen(!settingsOpen), { allowInInputs: true });

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
  const { consumePendingNavigation } = useWorkspace();
  const ui = useUI();
  const { handleUndoDelete, handleUndoDismiss, undoItems } = useUndoDelete();

  // One-shot: navigate to tutorial welcome page after first workspace creation.
  const didConsumeRef = useRef<boolean | null>(null);
  if (didConsumeRef.current == null) {
    didConsumeRef.current = true;
    const nav = consumePendingNavigation();
    if (nav) {
      ui.setActiveViewId(nav.folderId);
      ui.openPage(nav.pageId);
    }
  }
  return (
    <>
      <ThreePanelLayout />
      <SettingsPage />
      <QuickAddDialog />
      <SearchPalette />
      <UndoToast
        duration={UNDO_TOAST_DURATION_MS}
        items={undoItems}
        onDismiss={handleUndoDismiss}
        onUndo={handleUndoDelete}
      />
    </>
  );
}

function WorkspaceGate() {
  const { isLoading, workspace } = useWorkspace();

  if (isLoading || !workspace) {
    // Blank while initialising — workspace is auto-created on first launch
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
            <UIProvider>
              <EditorSettingsProvider>
                <UndoDeleteProvider>
                  <TooltipProvider delayDuration={400}>
                    <WorkspaceGate />
                  </TooltipProvider>
                </UndoDeleteProvider>
              </EditorSettingsProvider>
            </UIProvider>
          </WorkspaceProvider>
        </AppSettingsProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
