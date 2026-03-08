import { DndContext, DragOverlay, closestCenter } from "@dnd-kit/core";
import { motion } from "framer-motion";
import { Sidebar } from "./Sidebar";
import { PageListPanel } from "./PageListPanel";
import { EditorPanel } from "./EditorPanel";
import { usePanelResize } from "./usePanelResize";
import { useThreePanelDnD } from "./useThreePanelDnD";
import { useUI } from "@/shared/context/UIContext";
import { cn } from "@/lib/utils";

const PANEL_SPRING = { type: "spring" as const, stiffness: 350, damping: 35 };

export function ThreePanelLayout() {
  const { sidebarCollapsed } = useUI();

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
        <motion.div
          animate={{
            width: sidebarCollapsed ? 0 : left.width,
            opacity: sidebarCollapsed ? 0 : 1,
          }}
          transition={PANEL_SPRING}
          className={cn(
            "h-full shrink-0 overflow-hidden",
            sidebarCollapsed ? "pointer-events-none" : "pointer-events-auto"
          )}
        >
          <Sidebar width={left.width} onResizeStart={left.onResizeStart} />
        </motion.div>

        <motion.div
          animate={{
            width: sidebarCollapsed ? 0 : mid.width,
            opacity: sidebarCollapsed ? 0 : 1,
          }}
          transition={PANEL_SPRING}
          className={cn(
            "h-full shrink-0 overflow-hidden",
            sidebarCollapsed ? "pointer-events-none" : "pointer-events-auto"
          )}
        >
          <PageListPanel width={mid.width} onResizeStart={mid.onResizeStart} />
        </motion.div>

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
