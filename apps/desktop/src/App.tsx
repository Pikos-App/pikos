import { TooltipProvider } from "@/components/ui/tooltip";
import { VaultProvider } from "@/shared/context/VaultContext";
import { UIProvider } from "@/shared/context/UIContext";

export default function App() {
  return (
    <VaultProvider>
      <UIProvider>
        <TooltipProvider>
          <div className="flex h-screen bg-background text-foreground">
            {/* Left panel — sidebar (180px) */}
            <div className="w-[180px] shrink-0 border-r border-border" />
            {/* Middle panel — page list (280px) */}
            <div className="w-[280px] shrink-0 border-r border-border" />
            {/* Right panel — editor / calendar */}
            <div className="flex-1" />
          </div>
        </TooltipProvider>
      </UIProvider>
    </VaultProvider>
  );
}
