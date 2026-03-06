import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkspaceProvider } from "@/shared/context/WorkspaceContext";
import { UIProvider } from "@/shared/context/UIContext";
import { useKeyboardListener } from "@/shared/keyboard/useKeyboard";
import { ErrorBoundary } from "@/shared/ErrorBoundary";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { WelcomeScreen } from "@/features/workspace/WelcomeScreen";

function AppShell() {
  useKeyboardListener();

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Left panel — sidebar (180px) */}
      <div className="w-[180px] shrink-0 border-r border-border" />
      {/* Middle panel — page list (280px) */}
      <div className="w-[280px] shrink-0 border-r border-border" />
      {/* Right panel — editor / calendar */}
      <div className="flex-1" />
    </div>
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
