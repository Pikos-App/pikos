import { Lock } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface SyncedLockHintProps {
  size?: number;
  className?: string;
}

/** Names no calendar: both surfaces that render this show the owning calendar
 * immediately below it, in the byline chip and the popover's Folder row. */
const HINT = "Title, date, and schedule are read-only for synced pages";

/**
 * The one place a synced page explains why its mirror fields can't be edited.
 * Deliberately a small icon rather than a tooltip on the fields themselves: a
 * field-sized trigger fires whenever the cursor merely rests on the title or
 * the byline, and the tooltip then parks over whatever sits below it.
 */
export function SyncedLockHint({ className, size = 12 }: SyncedLockHintProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={HINT}
          className={cn("inline-flex shrink-0 cursor-default text-faint", className)}
          role="img"
        >
          <Lock aria-hidden="true" size={size} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{HINT}</TooltipContent>
    </Tooltip>
  );
}
