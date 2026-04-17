// AllDaySection — sits between the day-name row and the time grid.
// Each column shows all-day event chips filling the column width.
// Height is user-adjustable via a drag handle on the bottom edge.
// Clicking an empty column area creates a new all-day page for that day.

import type { PageSummary } from "@pikos/core";

import { useWorkspace } from "@/shared/context/WorkspaceContext";

import { assignAllDayRows } from "../utils/calendarUtils";
import { AllDayColumn } from "./AllDayColumn";

interface AllDaySectionProps {
  allDayDragHoverIndex: number | null;
  autoOpenPageId: string | null;
  days: Date[];
  draggingPageId: string | null;
  height: number;
  onAutoOpenConsumed: () => void;
  onChipDragStart: (info: { folderColor: string | undefined; pageId: string }) => void;
  onCreateAllDay: (day: Date) => Promise<void> | void;
  onPageDoubleClick: (pageId: string) => void;
  onResizeStart: (e: React.MouseEvent) => void;
  pages: PageSummary[];
  timedDragTarget: { dayIndex: number; folderColor: string | undefined } | null;
}

export function AllDaySection({
  allDayDragHoverIndex,
  autoOpenPageId,
  days,
  draggingPageId,
  height,
  onAutoOpenConsumed,
  onChipDragStart,
  onCreateAllDay,
  onPageDoubleClick,
  onResizeStart,
  pages,
  timedDragTarget,
}: AllDaySectionProps) {
  const { folders } = useWorkspace();
  const folderColorMap = new Map(
    folders.flatMap((f) => (f.color ? [[f.id, f.color] as [string, string]] : []))
  );
  const slotsByDay = assignAllDayRows(pages, days);

  return (
    <div className="relative shrink-0 border-b border-border/50">
      <div className="flex overflow-hidden" style={{ height }}>
        {/* Gutter spacer — aligns with TimeGutter's w-14 */}
        <div className="w-14 shrink-0" />

        {days.map((day, dayIndex) => {
          const slots = slotsByDay[dayIndex] ?? [];
          return (
            <AllDayColumn
              autoOpenPageId={autoOpenPageId}
              day={day}
              draggingPageId={draggingPageId}
              folderColorMap={folderColorMap}
              isAllDayDragTarget={allDayDragHoverIndex === dayIndex}
              isTimedDragTarget={timedDragTarget?.dayIndex === dayIndex}
              key={day.toISOString()}
              onAutoOpenConsumed={onAutoOpenConsumed}
              onChipDragStart={onChipDragStart}
              onCreateAllDay={onCreateAllDay}
              onPageDoubleClick={onPageDoubleClick}
              slots={slots}
            />
          );
        })}
      </div>

      {/* Drag handle — bottom edge */}
      <div
        aria-label="Resize all-day section"
        className="absolute inset-x-0 bottom-0 h-px cursor-row-resize border-b border-border-secondary transition-[height,background-color,border-color] duration-[var(--transition-fast)] hover:h-[3px] hover:border-b-0 hover:bg-border/40 active:h-[3px] active:border-b-0 active:bg-border/60"
        onMouseDown={onResizeStart}
        role="separator"
      />
    </div>
  );
}
