import type { PageSummary } from "@pikos/core";
import { isSameDay } from "date-fns";

import { cn } from "@/lib/utils";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import {
  buildDayBlocks,
  GRID_END_HOUR,
  GRID_HEIGHT,
  GRID_START_HOUR,
  HOUR_HEIGHT,
} from "./calendarUtils";
import { NowIndicator } from "./NowIndicator";
import { PageBlock } from "./PageBlock";

interface DayColumnProps {
  day: Date;
  isCurrentWeek: boolean;
  now: Date;
  onPageClick: (pageId: string) => void;
  pages: PageSummary[];
}

export function DayColumn({ day, isCurrentWeek, now, onPageClick, pages }: DayColumnProps) {
  const { folders } = useWorkspace();
  const folderColorMap = new Map(
    folders.flatMap((f) => (f.color ? [[f.id, f.color] as [string, string]] : []))
  );

  const blocks = buildDayBlocks(pages, day);
  const showNowIndicator = isCurrentWeek && isSameDay(now, day);
  const weekend = day.getDay() === 0 || day.getDay() === 6;

  // Hour and half-hour grid lines
  const hours = Array.from(
    { length: GRID_END_HOUR - GRID_START_HOUR },
    (_, i) => GRID_START_HOUR + i
  );

  return (
    <div
      className={cn(
        "relative min-w-0 flex-1 border-l border-border/50 first:border-l-0",
        weekend ? "bg-white/[0.012]" : ""
      )}
    >
      {/* Hour + half-hour grid lines */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {hours.map((hour) => (
          <div
            className="absolute inset-x-0"
            key={hour}
            style={{ height: HOUR_HEIGHT, top: (hour - GRID_START_HOUR) * HOUR_HEIGHT }}
          >
            {/* Hour line */}
            <div className="absolute inset-x-0 top-0 border-t border-border/40" />
            {/* Half-hour line */}
            <div
              className="absolute inset-x-0 border-t border-border/20"
              style={{ top: HOUR_HEIGHT / 2 }}
            />
          </div>
        ))}
      </div>

      {/* Relative container for absolutely-positioned blocks */}
      <div className="relative" style={{ height: GRID_HEIGHT }}>
        {/* Now indicator */}
        {showNowIndicator && <NowIndicator />}

        {/* Page blocks */}
        {blocks.map((block) => {
          const folderColor = block.page.folderId
            ? folderColorMap.get(block.page.folderId)
            : undefined;
          return (
            <PageBlock
              block={block}
              folderColor={folderColor}
              key={block.page.id}
              onClick={onPageClick}
            />
          );
        })}
      </div>
    </div>
  );
}
