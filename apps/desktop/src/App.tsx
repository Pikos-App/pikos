import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkspaceProvider } from "@/shared/context/WorkspaceContext";
import { UIProvider } from "@/shared/context/UIContext";
import { useKeyboardListener } from "@/shared/keyboard/useKeyboard";
import { ErrorBoundary } from "@/shared/ErrorBoundary";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { WelcomeScreen } from "@/features/workspace/WelcomeScreen";
import { ThreePanelLayout } from "@/features/layout/ThreePanelLayout";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { QuickAddDialog } from "@/features/pages/components/QuickAddDialog";

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
  const { workspace, isLoading } = useWorkspace();

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
