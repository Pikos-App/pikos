import type { Page } from "@pikos/core";
import { CalendarOff, CalendarSync } from "lucide-react";

import { cn } from "@/lib/utils";

interface SyncSourceIconProps {
  syncState: Page["syncState"];
  className?: string;
}

/** The provenance glyph for a synced page; nothing for a native page. */
export function SyncSourceIcon({ className, syncState }: SyncSourceIconProps) {
  if (syncState == null) return null;
  const detached = syncState === "detached";
  const Icon = detached ? CalendarOff : CalendarSync;
  return (
    <Icon
      // "Disconnected" is what the app says when an *account* disconnects, a different event that hits
      // every page on it at once.
      aria-label={detached ? "Not synced with a calendar" : "Synced from external calendar"}
      className={cn("shrink-0 text-subtle", className)}
      strokeWidth={2}
    />
  );
}
