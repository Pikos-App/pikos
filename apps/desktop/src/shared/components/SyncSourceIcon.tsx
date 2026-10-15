import type { Page } from "@pikos/core";
import { CalendarOff, CalendarSync } from "lucide-react";

import { cn } from "@/lib/utils";

interface SyncSourceIconProps {
  /** A page's derived `syncState`; `null`/undefined → native page, renders nothing. */
  syncState: Page["syncState"];
  /** Size + position utilities (e.g. "h-3 w-3 ml-auto"). */
  className?: string;
}

/**
 * The provenance glyph for a synced page: a sync icon for an active mirror, a
 * broken-calendar icon for a detached one; nothing for a native page. Shared by
 * the calendar blocks (timed + all-day) and the page list so the icon, copy, and
 * a11y label stay in one place.
 */
export function SyncSourceIcon({ className, syncState }: SyncSourceIconProps) {
  if (syncState == null) return null;
  const detached = syncState === "detached";
  const Icon = detached ? CalendarOff : CalendarSync;
  return (
    <Icon
      // "Disconnected" is what the app says when an *account* disconnects, which is a
      // different thing that happens to every page on it at once.
      aria-label={detached ? "Not synced with a calendar" : "Synced from external calendar"}
      className={cn("shrink-0 text-subtle", className)}
      strokeWidth={2}
    />
  );
}
