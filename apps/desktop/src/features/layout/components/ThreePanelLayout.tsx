import {
  closestCenter,
  type CollisionDetection,
  DndContext,
  DragOverlay,
  pointerWithin,
} from "@dnd-kit/core";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";
import { useUI } from "@/shared/context/UIContext";
import { useIsFullscreen } from "@/shared/hooks/useIsFullscreen";

import { shouldHideSidebar, shouldOverlayPageList, useLayoutMode } from "../breakpoints";
import { usePanelResize } from "../hooks/usePanelResize";
import { useThreePanelDnD } from "../hooks/useThreePanelDnD";
import { EditorPanel } from "./EditorPanel";
import { PageListPanel } from "./PageListPanel";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";

const PANEL_SPRING = { damping: 35, stiffness: 350, type: "spring" as const };

export function ThreePanelLayout() {
  const {
    activePageId,
    clearSelection,
    isDraggingOverCalendar,
    pageListDrawerOpen,
    selectedPageIds,
    setPageListDrawerOpen,
    sidebarCollapsed,
  } = useUI();
  const isFullscreen = useIsFullscreen();
  const layoutMode = useLayoutMode();
  const hideSidebar = shouldHideSidebar(layoutMode);
  const pageListOverlay = shouldOverlayPageList(layoutMode);

  // Auto-close the overlay drawer when the user picks a page. External state
  // change → side effect, so an effect is appropriate here.
  const prevActivePageRef = useRef(activePageId);
  useEffect(() => {
    if (prevActivePageRef.current !== activePageId && pageListDrawerOpen) {
      setPageListDrawerOpen(false);
    }
    prevActivePageRef.current = activePageId;
  }, [activePageId, pageListDrawerOpen, setPageListDrawerOpen]);

  // The drawer is only rendered at the sm breakpoint — gating here lets us
  // avoid resetting the underlying state when the viewport grows.
  const drawerVisible = pageListOverlay && pageListDrawerOpen;

  // Custom collision: first check what's under the pointer, then pick the
  // closest center among those candidates. Prevents folder droppables from
  // activating when the cursor is still in the page list panel.
  // Over the calendar, suppress all collisions so page items don't shift.
  const collisionDetection: CollisionDetection = isDraggingOverCalendar
    ? () => []
    : (args) => {
        const pointerHits = pointerWithin(args);
        if (pointerHits.length === 0) return [];
        return closestCenter({
          ...args,
          droppableContainers: args.droppableContainers.filter((c) =>
            pointerHits.some((h) => h.id === c.id)
          ),
        });
      };

  const left = usePanelResize({
    defaultWidth: 180,
    max: 320,
    min: 180,
    storageKey: "pikos:leftPanelWidth",
  });
  const mid = usePanelResize({
    defaultWidth: 280,
    max: 480,
    min: 240,
    storageKey: "pikos:midPanelWidth",
  });
  const {
    activeFolderData,
    activePageData,
    draggedPageCount,
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
        onMouseDown={(e) => {
          if (selectedPageIds.size > 0 && !(e.target as HTMLElement).closest("[data-page-item]")) {
            clearSelection();
          }
        }}
        role="main"
      >
        {!isFullscreen && <TitleBar />}
        <div className="relative flex min-h-0 flex-1">
          {/* Left folder sidebar — hidden at md/sm or when manually collapsed. */}
          <motion.div
            animate={{
              opacity: sidebarCollapsed || hideSidebar ? 0 : 1,
              width: sidebarCollapsed || hideSidebar ? 0 : left.width,
            }}
            className={cn(
              "h-full shrink-0 overflow-hidden",
              sidebarCollapsed || hideSidebar ? "pointer-events-none" : "pointer-events-auto"
            )}
            transition={PANEL_SPRING}
          >
            <Sidebar onResizeStart={left.onResizeStart} width={left.width} />
          </motion.div>

          {/* Middle page list — inline at xl/lg/md, hidden at sm (rendered as overlay below). */}
          {!pageListOverlay && (
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
          )}

          <EditorPanel />

          {/* sm overlay drawer — absolute, slides in from the left with a backdrop. */}
          <AnimatePresence>
            {drawerVisible && (
              <>
                <motion.div
                  animate={{ opacity: 1 }}
                  aria-hidden
                  className="absolute inset-0 z-40 bg-background/60"
                  exit={{ opacity: 0 }}
                  initial={{ opacity: 0 }}
                  onClick={() => setPageListDrawerOpen(false)}
                  transition={{ duration: 0.15 }}
                />
                <motion.div
                  animate={{ x: 0 }}
                  className="absolute inset-y-0 left-0 z-50 w-[280px] shadow-xl"
                  exit={{ x: "-100%" }}
                  initial={{ x: "-100%" }}
                  transition={PANEL_SPRING}
                >
                  <PageListPanel onResizeStart={mid.onResizeStart} width={280} />
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {activePageData && !isDraggingOverCalendar ? (
          <div className="flex cursor-grabbing items-center gap-2 rounded bg-accent px-2 py-1.5 text-sm font-medium text-accent-foreground opacity-50 shadow-lg ring-1 ring-border">
            {activePageData.title || "Untitled"}
            {draggedPageCount > 1 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-xs font-semibold text-primary-foreground">
                {draggedPageCount}
              </span>
            )}
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
