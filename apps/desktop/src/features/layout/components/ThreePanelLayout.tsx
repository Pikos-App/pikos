import {
  closestCenter,
  type CollisionDetection,
  DndContext,
  DragOverlay,
  pointerWithin,
} from "@dnd-kit/core";
import { shouldHideSidebar, shouldOverlayPageList } from "@pikos/core";
import { AnimatePresence, motion } from "framer-motion";

import { cn } from "@/lib/utils";
import { STORAGE_KEYS } from "@/shared/constants/storage";
import { useCalendarDnD } from "@/shared/context/CalendarDnDContext";
import { useInterfaceSettings } from "@/shared/context/InterfaceSettingsContext";
import { useSelection } from "@/shared/context/SelectionContext";
import { useUI } from "@/shared/context/UIContext";
import { useIsFullscreen } from "@/shared/hooks/useIsFullscreen";
import { useWindowWidth } from "@/shared/hooks/useWindowWidth";

import { useLayoutMode } from "../breakpoints";
import { usePanelResize } from "../hooks/usePanelResize";
import { useThreePanelDnD } from "../hooks/useThreePanelDnD";
import { EditorPanel } from "./EditorPanel";
import { MiddlePanel } from "./MiddlePanel";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";

const PANEL_SPRING = { damping: 35, stiffness: 350, type: "spring" as const };

const LEFT_PANEL = { defaultWidth: 180, max: 320, min: 180 };
const MID_PANEL = { defaultWidth: 280, max: 480, min: 240 };

/**
 * What the calendar keeps whatever the two panels do, in screen px.
 *
 * Unscaled, unlike the panels: an hour column stays readable narrow, where a
 * panel's text does not. Scaling this too would leave nothing to drag into at
 * the largest text size, which is what capping each panel at a share of the
 * window used to do — at 200% the two panels' minimums are wider than the half
 * window that rule allowed them, so both dividers were inert.
 */
const CALENDAR_MIN_WIDTH = 320;

export function ThreePanelLayout() {
  const { focusZen, pageListDrawerOpen, setPageListDrawerOpen, sidebarCollapsed } = useUI();
  const leftHidden = sidebarCollapsed || focusZen;
  const { clearSelection, selectedPageIds } = useSelection();
  const { isDraggingOverCalendar } = useCalendarDnD();
  const isFullscreen = useIsFullscreen();
  const layoutMode = useLayoutMode();
  const windowWidth = useWindowWidth();
  const { textScale } = useInterfaceSettings();
  const hideSidebar = shouldHideSidebar(layoutMode);
  const pageListOverlay = shouldOverlayPageList(layoutMode);

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

  // The sidebar is measured first, so it leaves the page list a minimum rather
  // than the page list's actual width; the page list then takes what is left.
  const left = usePanelResize({
    ...LEFT_PANEL,
    ceiling: windowWidth - CALENDAR_MIN_WIDTH - MID_PANEL.min * textScale,
    storageKey: STORAGE_KEYS.leftPanelWidth,
  });
  const leftOccupies = leftHidden || hideSidebar ? 0 : left.width;
  const mid = usePanelResize({
    ...MID_PANEL,
    ceiling: windowWidth - CALENDAR_MIN_WIDTH - leftOccupies,
    storageKey: STORAGE_KEYS.midPanelWidth,
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
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- outside-click dismiss of multi-selection; the equivalent keyboard path is Escape */}
      <div
        aria-label="Workspace"
        className={cn(
          "flex h-screen flex-col bg-background text-foreground",
          (activePageData ?? activeFolderData) && "select-none"
        )}
        onMouseDown={(e) => {
          // React bubbles a press in a portaled menu up to here, so a page's own
          // context menu read as an outside click and dropped the selection it acts on.
          const target = e.target as HTMLElement;
          if (!e.currentTarget.contains(target)) return;
          if (selectedPageIds.size > 0 && !target.closest("[data-page-item]")) {
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
              opacity: leftHidden || hideSidebar ? 0 : 1,
              width: leftHidden || hideSidebar ? 0 : left.width,
            }}
            className={cn(
              "h-full shrink-0 overflow-hidden",
              leftHidden || hideSidebar ? "pointer-events-none" : "pointer-events-auto"
            )}
            // A collapsed panel is zero-width, not unmounted, and its contents
            // overflow rather than clip away — so without this the sidebar keeps
            // taking Tab focus and stays in the accessibility tree while nothing
            // is on screen. `pointer-events-none` only stops the mouse.
            inert={leftHidden || hideSidebar}
            transition={PANEL_SPRING}
          >
            <Sidebar onResizeStart={left.onResizeStart} width={left.width} />
          </motion.div>

          {/* Middle page list — inline at xl/lg/md, hidden at sm (rendered as overlay below). */}
          {!pageListOverlay && (
            <motion.div
              animate={{
                opacity: leftHidden ? 0 : 1,
                width: leftHidden ? 0 : mid.width,
              }}
              className={cn(
                "h-full shrink-0 overflow-hidden",
                leftHidden ? "pointer-events-none" : "pointer-events-auto"
              )}
              inert={leftHidden}
              transition={PANEL_SPRING}
            >
              <MiddlePanel onResizeStart={mid.onResizeStart} width={mid.width} />
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
                  <MiddlePanel onResizeStart={mid.onResizeStart} width={280} />
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
              className="color-dot h-2 w-2 shrink-0 rounded-full"
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
