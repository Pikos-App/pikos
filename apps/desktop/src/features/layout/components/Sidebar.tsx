// Sidebar — left panel (smart views + folders). Default 180px, resizable.

import { Settings } from "lucide-react";

import { FolderList } from "@/features/folders";
import { useUI } from "@/shared/context/UIContext";

interface SidebarProps {
  width: number;
  onResizeStart: (e: React.MouseEvent) => void;
}

export function Sidebar({ onResizeStart, width }: SidebarProps) {
  const { setSettingsOpen } = useUI();

  return (
    <div
      className="group relative flex h-full shrink-0 flex-col overflow-hidden border-r border-border-secondary bg-surface-tertiary"
      style={{ width }}
    >
      <div className="min-h-0 flex-1">
        <FolderList />
      </div>

      {/* Footer — settings button */}
      <div className="shrink-0 border-t border-border-subtle px-2 py-1.5">
        <button
          aria-label="Open settings"
          className="type-ui flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground transition-[background-color,color] duration-[120ms] ease-out hover:bg-surface-hover hover:text-foreground"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings className="h-3.5 w-3.5 shrink-0" />
          <span>Settings</span>
        </button>
      </div>

      {/* Drag handle — right edge */}
      <div
        className="absolute top-0 right-0 h-full w-px cursor-col-resize border-r border-border-secondary transition-[width,background-color,border-color] duration-[var(--transition-fast)] hover:w-[3px] hover:border-r-0 hover:bg-border/40 data-[dragging]:w-[3px] data-[dragging]:border-r-0 data-[dragging]:bg-border/60"
        onMouseDown={onResizeStart}
      />
    </div>
  );
}
