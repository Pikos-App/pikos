import { useEffect, useRef } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ThreePanelLayout } from "@/features/layout";
import { QuickAddDialog, UNDO_TOAST_DURATION_MS } from "@/features/pages";
import { SearchPalette } from "@/features/search";
import { SettingsPage } from "@/features/settings";
import { Toast } from "@/shared/components/Toast";
import { UpdateDialog } from "@/shared/components/UpdateDialog";
import { AppSettingsProvider } from "@/shared/context/AppSettingsContext";
import { CalendarSettingsProvider } from "@/shared/context/CalendarSettingsContext";
import { EditorSettingsProvider } from "@/shared/context/EditorSettingsContext";
import { ListSettingsProvider } from "@/shared/context/ListSettingsContext";
import { ThemeProvider } from "@/shared/context/ThemeContext";
import { UIProvider, useUI } from "@/shared/context/UIContext";
import { UndoDeleteProvider, useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { UpdateProvider, useUpdate } from "@/shared/context/UpdateContext";
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
  }, [activePageId]);
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
    (window as unknown as Record<string, unknown>)["__onMenuEvent"] = (id: string) => {
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
      delete (window as unknown as Record<string, unknown>)["__onMenuEvent"];
    };
  }, [setSidebarCollapsed, setRightPanel]);
}

/** ⌘, opens settings, ⌘? opens settings → shortcuts, ⌘1-9 switches to folder by index. */
function useGlobalShortcuts() {
  const { setActivePage, setActiveViewId, setSettingsOpen, setSettingsSection, settingsOpen } =
    useUI();
  const { folders } = useWorkspace();

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
  const updater = useUpdate();
  const { consumePendingNavigation } = useWorkspace();
  const ui = useUI();
  const { handleToastDismiss, toastItems } = useUndoDelete();

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
      <Toast duration={UNDO_TOAST_DURATION_MS} items={toastItems} onDismiss={handleToastDismiss} />
      <UpdateDialog updater={updater} />
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
            <UpdateProvider>
              <UIProvider>
                <EditorSettingsProvider>
                  <CalendarSettingsProvider>
                    <ListSettingsProvider>
                      <UndoDeleteProvider>
                        <TooltipProvider delayDuration={400}>
                          <WorkspaceGate />
                        </TooltipProvider>
                      </UndoDeleteProvider>
                    </ListSettingsProvider>
                  </CalendarSettingsProvider>
                </EditorSettingsProvider>
              </UIProvider>
            </UpdateProvider>
          </WorkspaceProvider>
        </AppSettingsProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
