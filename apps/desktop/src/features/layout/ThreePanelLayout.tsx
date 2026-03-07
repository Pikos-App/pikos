import { DndContext, DragOverlay, closestCenter } from "@dnd-kit/core";
import { Sidebar } from "./Sidebar";
import { PageListPanel } from "./PageListPanel";
import { EditorPanel } from "./EditorPanel";
import { usePanelResize } from "./usePanelResize";
import { useThreePanelDnD } from "./useThreePanelDnD";

export function ThreePanelLayout() {
  const left = usePanelResize({
    storageKey: "pikos:leftPanelWidth",
    defaultWidth: 180,
    min: 120,
    max: 320,
  });
  const mid = usePanelResize({
    storageKey: "pikos:midPanelWidth",
    defaultWidth: 280,
    min: 180,
    max: 480,
  });
  const {
    sensors,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
    activePageData,
    activeFolderData,
  } = useThreePanelDnD();

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex h-screen bg-background text-foreground">
        <Sidebar width={left.width} onResizeStart={left.onResizeStart} />
        <PageListPanel width={mid.width} onResizeStart={mid.onResizeStart} />
        <EditorPanel />
      </div>

      <DragOverlay dropAnimation={null}>
        {activePageData ? (
          <div className="cursor-grabbing rounded bg-accent px-2 py-1.5 text-sm font-medium text-accent-foreground opacity-50 shadow-lg ring-1 ring-border">
            {activePageData.title || "Untitled"}
          </div>
        ) : activeFolderData ? (
          <div className="flex cursor-grabbing items-center gap-2 rounded bg-accent px-2 py-1.5 text-sm text-accent-foreground opacity-50 shadow-lg ring-1 ring-border">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{
                backgroundColor: activeFolderData.color ?? "hsl(var(--muted-foreground) / 0.4)",
              }}
            />
            {activeFolderData.name}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
