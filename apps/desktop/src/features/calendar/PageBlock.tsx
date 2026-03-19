import { cn } from "@/lib/utils";

import { CHIP_BASE_CLASSES, CHIP_DEFAULT_COLOR_CLASSES, chipFolderStyle } from "./calendarUtils";
import type { CalendarBlock } from "./calendarUtils";
import { formatTimeRange } from "./calendarUtils";

interface PageBlockProps {
  block: CalendarBlock;
  folderColor: string | undefined;
  onClick: (pageId: string) => void;
}

export function PageBlock({ block, folderColor, onClick }: PageBlockProps) {
  const { column, endDate, height, isCompact, page, startDate, top, totalColumns } = block;

  const widthPct = 100 / totalColumns;
  const leftPct = column * widthPct;

  const timeLabel = formatTimeRange(startDate, endDate);
  const showTimeLabel = !isCompact && height >= 36;

  return (
    <button
      aria-label={`${page.title || "Untitled"}, ${timeLabel}`}
      className={cn(
        "absolute",
        isCompact
          ? [CHIP_BASE_CLASSES, "flex items-center", !folderColor && CHIP_DEFAULT_COLOR_CLASSES]
          : [
              "flex flex-col items-start overflow-hidden rounded-sm border-l-2 px-1.5 py-0.5 transition-opacity hover:opacity-75 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
              !folderColor && "border-blue-500 bg-blue-500/15 hover:bg-blue-500/25",
            ]
      )}
      onClick={() => onClick(page.id)}
      style={{
        ...(folderColor ? chipFolderStyle(folderColor) : undefined),
        height: isCompact ? undefined : height,
        left: `${leftPct}%`,
        top,
        width: `calc(${widthPct}% - 2px)`,
      }}
    >
      <p
        className={cn(
          "truncate font-medium text-foreground",
          isCompact ? "text-sm leading-none" : "text-sm leading-tight"
        )}
      >
        {page.title || "Untitled"}
      </p>
      {showTimeLabel && (
        <p className="mt-0.5 truncate text-[10px] leading-tight text-muted-foreground">
          {timeLabel}
        </p>
      )}
    </button>
  );
}
