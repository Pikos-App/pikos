import { Lock } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface SyncedLockHintProps {
  size?: number;
  className?: string;
}

const HINT = "Title, date, and schedule are read-only for synced pages";

/** An icon rather than a tooltip on the locked fields: a field-sized trigger fires whenever the
 *  cursor merely rests there, parking the tooltip over whatever sits below. */
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
