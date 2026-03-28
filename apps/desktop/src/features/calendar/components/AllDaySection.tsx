// AllDaySection — sits between the day-name row and the time grid.
// Each column shows all-day event chips filling the column width.
// Height is user-adjustable via a drag handle on the bottom edge.
// Clicking an empty column area creates a new all-day page for that day.

import type { PageSummary } from "@pikos/core";

import { useWorkspace } from "@/shared/context/WorkspaceContext";

import { buildAllDayItems } from "../utils/calendarUtils";
import { AllDayColumn } from "./AllDayColumn";

interface AllDaySectionProps {
  allDayDragHoverIndex: number | null;
  days: Date[];
  draggingPageId: string | null;
  editingPageId: string | null;
  height: number;
  onCancelCreate: (pageId: string) => void;
  onChipDragStart: (info: { folderColor: string | undefined; pageId: string }) => void;
  onCommitTitle: (pageId: string, title: string) => void;
  onCreateAllDay: (day: Date) => Promise<void> | void;
  onPageDoubleClick: (pageId: string) => void;
  onResizeStart: (e: React.MouseEvent) => void;
  pages: PageSummary[];
  timedDragTarget: { dayIndex: number; folderColor: string | undefined } | null;
}

export function AllDaySection({
  allDayDragHoverIndex,
  days,
  draggingPageId,
  editingPageId,
  height,
  onCancelCreate,
  onChipDragStart,
  onCommitTitle,
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

  return (
    <div className="relative shrink-0 border-b border-border/50">
      <div className="flex overflow-hidden" style={{ height }}>
        {/* Gutter spacer — aligns with TimeGutter's w-14 */}
        <div className="w-14 shrink-0" />

        {days.map((day, dayIndex) => {
          const items = buildAllDayItems(pages, day);
          return (
            <AllDayColumn
              day={day}
              draggingPageId={draggingPageId}
              editingPageId={editingPageId}
              folderColorMap={folderColorMap}
              isAllDayDragTarget={allDayDragHoverIndex === dayIndex}
              isTimedDragTarget={timedDragTarget?.dayIndex === dayIndex}
              items={items}
              key={day.toISOString()}
              onCancelCreate={onCancelCreate}
              onChipDragStart={onChipDragStart}
              onCommitTitle={onCommitTitle}
              onCreateAllDay={onCreateAllDay}
              onPageDoubleClick={onPageDoubleClick}
            />
          );
        })}
      </div>

      {/* Drag handle — bottom edge */}
      <div
        aria-label="Resize all-day section"
        className="absolute inset-x-0 bottom-0 h-1.5 cursor-row-resize hover:bg-border/40 active:bg-border/60"
        onMouseDown={onResizeStart}
        role="separator"
      />
    </div>
  );
}
