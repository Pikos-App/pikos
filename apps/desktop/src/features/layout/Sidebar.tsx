// Sidebar — left panel (smart views + folders). Default 180px, resizable.

import { FolderList } from "@/features/folders/FolderList";

interface SidebarProps {
  width: number;
  onResizeStart: (e: React.MouseEvent) => void;
}

export function Sidebar({ width, onResizeStart }: SidebarProps) {
  return (
    <div
      className="group relative flex shrink-0 flex-col overflow-hidden border-r border-border bg-background"
      style={{ width }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <FolderList />
      </div>

      {/* Drag handle — right edge */}
      <div
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize transition-colors hover:bg-primary/30"
        onMouseDown={onResizeStart}
      />
    </div>
  );
}
