import { TooltipProvider } from "@/components/ui/tooltip";
import { ThreePanelLayout } from "@/features/layout/ThreePanelLayout";
import { QuickAddDialog } from "@/features/pages/components/QuickAddDialog";
import { UNDO_TOAST_DURATION_MS } from "@/features/pages/hooks/usePageList";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { WelcomeScreen } from "@/features/workspace/WelcomeScreen";
import { UndoToast } from "@/shared/components/UndoToast";
import { UIProvider } from "@/shared/context/UIContext";
import { UndoDeleteProvider, useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { WorkspaceProvider } from "@/shared/context/WorkspaceContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { ErrorBoundary } from "@/shared/ErrorBoundary";
import { useKeyboardListener } from "@/shared/keyboard/useKeyboard";

function AppShell() {
  useKeyboardListener();
  const { handleUndoDelete, handleUndoDismiss, undoItems } = useUndoDelete();
  return (
    <>
      <ThreePanelLayout />
      <SettingsPage />
      <QuickAddDialog />
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
            <TooltipProvider>
              <WorkspaceGate />
            </TooltipProvider>
          </UndoDeleteProvider>
        </UIProvider>
      </WorkspaceProvider>
    </ErrorBoundary>
  );
}
