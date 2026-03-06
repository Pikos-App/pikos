import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkspaceProvider } from "@/shared/context/WorkspaceContext";
import { UIProvider } from "@/shared/context/UIContext";
import { useKeyboardListener } from "@/shared/keyboard/useKeyboard";
import { ErrorBoundary } from "@/shared/ErrorBoundary";

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

export default function App() {
  return (
    <ErrorBoundary>
      <WorkspaceProvider>
        <UIProvider>
          <TooltipProvider>
            <AppShell />
          </TooltipProvider>
        </UIProvider>
      </WorkspaceProvider>
    </ErrorBoundary>
  );
}
