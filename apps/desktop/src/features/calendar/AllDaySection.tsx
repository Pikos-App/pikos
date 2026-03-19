// AllDaySection — sits between the day-name row and the time grid.
// Each column shows all-day event chips filling the column width.
// Height is user-adjustable via a drag handle on the bottom edge.

import type { PageSummary } from "@pikos/core";

import { cn } from "@/lib/utils";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import {
  buildAllDayItems,
  CHIP_BASE_CLASSES,
  CHIP_DEFAULT_COLOR_CLASSES,
  chipFolderStyle,
} from "./calendarUtils";

interface AllDaySectionProps {
  days: Date[];
  height: number;
  onPageClick: (pageId: string) => void;
  onResizeStart: (e: React.MouseEvent) => void;
  pages: PageSummary[];
}

export function AllDaySection({
  days,
  height,
  onPageClick,
  onResizeStart,
  pages,
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

        {/* Day columns */}
        {days.map((day) => {
          const items = buildAllDayItems(pages, day);

          return (
            <div
              className={cn(
                "flex min-w-0 flex-1 flex-col overflow-hidden border-l border-border/50 px-1 py-1 first:border-l-0",
                (day.getDay() === 0 || day.getDay() === 6) ? "bg-white/[0.012]" : ""
              )}
              key={day.toISOString()}
            >
              {/* Event chips — full column width minus px-1 margin */}
              <div className="flex flex-1 flex-col gap-0.5 overflow-hidden">
                {items.map((item) => {
                  const folderColor = item.folderId ? folderColorMap.get(item.folderId) : undefined;
                  return (
                    <button
                      aria-label={item.title || "Untitled"}
                      className={cn(
                        "flex w-full items-center",
                        CHIP_BASE_CLASSES,
                        !folderColor && CHIP_DEFAULT_COLOR_CLASSES
                      )}
                      key={item.id}
                      onClick={() => onPageClick(item.id)}
                      style={folderColor ? chipFolderStyle(folderColor) : undefined}
                    >
                      <span className="min-w-0 truncate">{item.title || "Untitled"}</span>
                    </button>
                  );
                })}
              </div>
            </div>
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
