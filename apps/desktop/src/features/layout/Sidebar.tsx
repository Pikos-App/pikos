// Sidebar — left panel (smart views + folders). Default 180px, resizable.

import { Settings } from "lucide-react";
import { FolderList } from "@/features/folders/FolderList";
import { useUI } from "@/shared/context/UIContext";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface SidebarProps {
  width: number;
  onResizeStart: (e: React.MouseEvent) => void;
}

export function Sidebar({ width, onResizeStart }: SidebarProps) {
  const { setSettingsOpen } = useUI();

  return (
    <div
      className="group relative flex h-full shrink-0 flex-col overflow-hidden border-r border-border bg-background"
      style={{ width }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <FolderList />
      </div>

      {/* Footer — settings button */}
      <div className="shrink-0 border-t border-border px-2 py-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setSettingsOpen(true)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Open settings"
            >
              <Settings className="h-3.5 w-3.5 shrink-0" />
              <span>Settings</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Settings</TooltipContent>
        </Tooltip>
      </div>

      {/* Drag handle — right edge */}
      <div
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize transition-colors hover:bg-primary/30"
        onMouseDown={onResizeStart}
      />
    </div>
  );
}
