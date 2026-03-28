import { closestCenter, type CollisionDetection, DndContext, DragOverlay } from "@dnd-kit/core";
import { motion } from "framer-motion";

import { cn } from "@/lib/utils";
import { useUI } from "@/shared/context/UIContext";
import { useIsFullscreen } from "@/shared/hooks/useIsFullscreen";

import { usePanelResize } from "../hooks/usePanelResize";
import { useThreePanelDnD } from "../hooks/useThreePanelDnD";
import { EditorPanel } from "./EditorPanel";
import { PageListPanel } from "./PageListPanel";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";

const PANEL_SPRING = { damping: 35, stiffness: 350, type: "spring" as const };

export function ThreePanelLayout() {
  const { isDraggingOverCalendar, sidebarCollapsed } = useUI();
  const isFullscreen = useIsFullscreen();

  // Suppress all dnd-kit collision detection while the cursor is over the
  // calendar — prevents page items from shifting position during a calendar drop.
  const collisionDetection: CollisionDetection = isDraggingOverCalendar ? () => [] : closestCenter;

  const left = usePanelResize({
    defaultWidth: 180,
    max: 320,
    min: 120,
    storageKey: "pikos:leftPanelWidth",
  });
  const mid = usePanelResize({
    defaultWidth: 280,
    max: 480,
    min: 180,
    storageKey: "pikos:midPanelWidth",
  });
  const {
    activeFolderData,
    activePageData,
    handleDragCancel,
    handleDragEnd,
    handleDragStart,
    sensors,
  } = useThreePanelDnD();

  return (
    <DndContext
      collisionDetection={collisionDetection}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
      onDragStart={handleDragStart}
      sensors={sensors}
    >
      <div
        aria-label="Workspace"
        className={cn(
          "flex h-screen flex-col bg-background text-foreground",
          (activePageData ?? activeFolderData) && "select-none"
        )}
        role="main"
      >
        {!isFullscreen && <TitleBar />}
        <div className="flex min-h-0 flex-1">
          <motion.div
            animate={{
              opacity: sidebarCollapsed ? 0 : 1,
              width: sidebarCollapsed ? 0 : left.width,
            }}
            className={cn(
              "h-full shrink-0 overflow-hidden",
              sidebarCollapsed ? "pointer-events-none" : "pointer-events-auto"
            )}
            transition={PANEL_SPRING}
          >
            <Sidebar onResizeStart={left.onResizeStart} width={left.width} />
          </motion.div>

          <motion.div
            animate={{
              opacity: sidebarCollapsed ? 0 : 1,
              width: sidebarCollapsed ? 0 : mid.width,
            }}
            className={cn(
              "h-full shrink-0 overflow-hidden",
              sidebarCollapsed ? "pointer-events-none" : "pointer-events-auto"
            )}
            transition={PANEL_SPRING}
          >
            <PageListPanel onResizeStart={mid.onResizeStart} width={mid.width} />
          </motion.div>

          <EditorPanel />
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {activePageData && !isDraggingOverCalendar ? (
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
