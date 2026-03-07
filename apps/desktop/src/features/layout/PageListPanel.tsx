// PageListPanel — middle panel (page list for active view). Default 280px, resizable.

interface PageListPanelProps {
  width: number;
  onResizeStart: (e: React.MouseEvent) => void;
}

export function PageListPanel({ width, onResizeStart }: PageListPanelProps) {
  return (
    <div
      className="relative flex shrink-0 flex-col border-r border-border bg-background"
      style={{ width }}
    >
      <div className="p-4 text-xs text-muted-foreground">Page List</div>

      {/* Drag handle — right edge */}
      <div
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize transition-colors hover:bg-primary/30"
        onMouseDown={onResizeStart}
      />
    </div>
  );
}
