// Sidebar — left panel (folders, smart views). Default 180px, resizable.

interface SidebarProps {
  width: number;
  onResizeStart: (e: React.MouseEvent) => void;
}

export function Sidebar({ width, onResizeStart }: SidebarProps) {
  return (
    <div
      className="relative flex shrink-0 flex-col border-r border-border bg-background"
      style={{ width }}
    >
      <div className="p-4 text-xs text-muted-foreground">Sidebar</div>

      {/* Drag handle — right edge */}
      <div
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize transition-colors hover:bg-primary/30"
        onMouseDown={onResizeStart}
      />
    </div>
  );
}
