import { TooltipProvider } from "@/components/ui/tooltip";
import { ThreePanelLayout } from "@/features/layout/ThreePanelLayout";
import { QuickAddDialog } from "@/features/pages/components/QuickAddDialog";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { WelcomeScreen } from "@/features/workspace/WelcomeScreen";
import { UIProvider } from "@/shared/context/UIContext";
import { WorkspaceProvider } from "@/shared/context/WorkspaceContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { ErrorBoundary } from "@/shared/ErrorBoundary";
import { useKeyboardListener } from "@/shared/keyboard/useKeyboard";

function AppShell() {
  useKeyboardListener();
  return (
    <>
      <ThreePanelLayout />
      <SettingsPage />
      <QuickAddDialog />
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
          <TooltipProvider>
            <WorkspaceGate />
          </TooltipProvider>
        </UIProvider>
      </WorkspaceProvider>
    </ErrorBoundary>
  );
}
