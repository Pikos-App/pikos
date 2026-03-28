import { useEffect, useRef } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ThreePanelLayout } from "@/features/layout";
import { QuickAddDialog, UNDO_TOAST_DURATION_MS } from "@/features/pages";
import { SearchPalette } from "@/features/search";
import { SettingsPage } from "@/features/settings";
import { WelcomeScreen } from "@/features/workspace";
import { UndoToast } from "@/shared/components/UndoToast";
import { UIProvider, useUI } from "@/shared/context/UIContext";
import { UndoDeleteProvider, useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { WorkspaceProvider } from "@/shared/context/WorkspaceContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { ErrorBoundary } from "@/shared/ErrorBoundary";
import { useKeyboardListener } from "@/shared/keyboard/useKeyboard";

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

function AppShell() {
  useKeyboardListener();
  useTrackPageOpened();
  const { handleUndoDelete, handleUndoDismiss, undoItems } = useUndoDelete();
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

  if (isLoading) {
    // Blank while initialising — avoids flash of welcome screen on auto-reopen
    return null;
  }

  if (!workspace) {
    return <WelcomeScreen />;
  }

  return <AppShell />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <WorkspaceProvider>
        <UIProvider>
          <UndoDeleteProvider>
            <TooltipProvider delayDuration={400}>
              <WorkspaceGate />
            </TooltipProvider>
          </UndoDeleteProvider>
        </UIProvider>
      </WorkspaceProvider>
    </ErrorBoundary>
  );
}
