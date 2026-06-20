import { AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";

import type { SyncDotMeta } from "./syncStatus";

// ● active · ○ off · ◐ stale · ⚠ error. Health, not the calendar's colour —
// kept on its own semantic scale so a pastel calendar colour can't read as
// "healthy" or "broken".
export function SyncStatusDot({ label, state }: SyncDotMeta) {
  if (state === "error") {
    return <AlertTriangle aria-label={label} className="size-3 text-destructive" role="img" />;
  }
  return (
    <span
      aria-label={label}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        state === "active" && "bg-emerald-500",
        state === "stale" && "bg-amber-500",
        state === "off" && "border border-muted-foreground/60 bg-transparent"
      )}
      role="img"
    />
  );
}
