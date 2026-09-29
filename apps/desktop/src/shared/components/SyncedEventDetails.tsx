import { MapPin, Users } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface SyncedEventDetailsProps {
  location?: string | null | undefined;
  attendees?: string[] | null | undefined;
  className?: string;
}

/**
 * Read-only mirror metadata for a synced (locked) event — the calendar-owned
 * location and attendee list. These are never editable (only the reconciler
 * writes them). Renders nothing when both are empty, so callers can drop it in
 * unconditionally for any page. Attendees collapse to a count with the full list
 * in a tooltip to keep the byline/popover compact.
 */
export function SyncedEventDetails({ attendees, className, location }: SyncedEventDetailsProps) {
  const hasLocation = !!location;
  const hasAttendees = !!attendees && attendees.length > 0;
  if (!hasLocation && !hasAttendees) return null;

  return (
    <div className={`type-ui-sm flex flex-col gap-1.5 text-subtle ${className ?? ""}`}>
      {hasLocation && (
        <div className="flex items-center gap-1.5">
          <MapPin aria-hidden="true" className="shrink-0" size={13} />
          <span className="truncate">{location}</span>
        </div>
      )}
      {hasAttendees && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex w-fit items-center gap-1.5">
              <Users aria-hidden="true" className="shrink-0" size={13} />
              <span className="truncate">
                {attendees.length === 1 ? attendees[0] : `${attendees.length} guests`}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px]" side="bottom">
            <div className="flex flex-col gap-0.5">
              {attendees.map((a) => (
                <span key={a}>{a}</span>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
