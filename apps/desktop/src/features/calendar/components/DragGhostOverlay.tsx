import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

import type { GhostContent } from "../hooks/useDragGhost";
import { chipFolderStyle } from "../utils/calendarColors";

export interface DragGhostOverlayProps {
  content: GhostContent;
  /** Ref callback from useDragGhost — positions the ghost the moment it mounts. */
  ghostRefCallback: (el: HTMLDivElement | null) => void;
  /** Ref callback for the inline time label (only rendered for tall blocks). */
  ghostTimeLabelRefCallback: (el: HTMLParagraphElement | null) => void;
}

/**
 * DOM for the shared ghost overlay used by timed-block drag and all-day chip
 * drag. Mounted only while a drag gesture is active; content updates 2× per
 * gesture (start, end), position updates every frame via ref-bound style
 * writes (see useDragGhost).
 */
export function DragGhostOverlay({
  content,
  ghostRefCallback,
  ghostTimeLabelRefCallback,
}: DragGhostOverlayProps) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-30 overflow-hidden rounded-sm border-l-2 opacity-80",
        content.isCompact
          ? "flex items-center gap-1 px-1.5"
          : "flex flex-col items-start px-1.5 py-0.5"
      )}
      ref={ghostRefCallback}
      style={chipFolderStyle(content.folderColor)}
    >
      {content.isCompact ? (
        <>
          <span
            className={cn(
              "flex shrink-0 items-center justify-center rounded-[2px] border",
              content.height < 16 ? "h-2.5 w-2.5" : "h-3.5 w-3.5",
              content.isDone ? "border-foreground/40 bg-foreground/10" : "border-current/30"
            )}
          >
            {content.isDone && <Check size={8} strokeWidth={2.5} />}
          </span>
          <span
            className={cn(
              "min-w-0 truncate font-medium text-foreground",
              content.height < 16 ? "-mt-px text-[10px] leading-none" : "type-body-sm"
            )}
          >
            {content.title || "Untitled"}
          </span>
        </>
      ) : (
        <>
          <div className="flex w-full min-w-0 items-center gap-1">
            <span
              className={cn(
                "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[2px] border",
                content.isDone ? "border-foreground/40 bg-foreground/10" : "border-current/30"
              )}
            >
              {content.isDone && <Check size={8} strokeWidth={2.5} />}
            </span>
            <p className="type-body-sm min-w-0 truncate font-medium text-foreground">
              {content.title || "Untitled"}
            </p>
          </div>
          {content.height >= 40 && (
            <p className="type-ui-sm mt-0.5 truncate text-subtle" ref={ghostTimeLabelRefCallback} />
          )}
        </>
      )}
    </div>
  );
}
