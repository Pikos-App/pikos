// "Recent notifications" — the notification log, read back.
//
// Until now the log was write-only bookkeeping: the scheduler wrote a row to
// stop a reminder re-firing and nobody ever looked at it, so "did Pikos remind
// me?" had no answer inside the app. This renders the same 30-day window the
// dedup ledger keeps: what fired, when, for which page, whether the user clicked
// it through — and, for the first time, the reminders quiet hours silenced,
// which used to vanish without a trace.
//
// Presentational on purpose: it takes the rows and hands clicks back out, so the
// list is testable without a workspace, a scheduler or a clock.

import type { NotificationHistoryEntry } from "@pikos/core";
import { Bell, BellOff, CalendarClock } from "lucide-react";

import { cn } from "@/lib/utils";

import { describeEntry, formatFiredAt } from "./notificationHistoryFormat";

function entryIcon(kind: string) {
  if (kind === "suppressed") return BellOff;
  if (kind === "overdue") return CalendarClock;
  return Bell;
}

/** The page a row is about. A row outlives its page, so a missing title is a
 *  real state and says so rather than rendering an empty line. */
function entryTitle(entry: NotificationHistoryEntry): string {
  if (entry.kind === "overdue") return "Today's schedule";
  if (entry.pageTitle != null && entry.pageTitle !== "") return entry.pageTitle;
  return entry.pageId != null ? "Deleted page" : "Pikos";
}

export interface NotificationHistoryProps {
  entries: NotificationHistoryEntry[];
  /** Open a page from a row. Rows with no page (the daily summary, a deleted
   *  page) render as plain text instead of a button. */
  onOpenPage: (pageId: string) => void;
}

export function NotificationHistory({ entries, onOpenPage }: NotificationHistoryProps) {
  if (entries.length === 0) {
    return (
      <p className="py-3 text-xs text-muted-foreground">
        Nothing yet. Reminders you receive — and any quiet hours silences — show up here for 30
        days.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {entries.map((entry) => {
        const Icon = entryIcon(entry.kind);
        const openable = entry.pageId != null && entry.pageTitle != null;
        const title = entryTitle(entry);
        return (
          <li className="flex items-center gap-3 py-2" key={entry.id}>
            <Icon
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                entry.kind === "suppressed" ? "text-muted-foreground/60" : "text-muted-foreground"
              )}
            />
            <div className="min-w-0 flex-1">
              {openable ? (
                <button
                  className="block max-w-full truncate text-left text-sm font-medium hover:underline"
                  onClick={() => onOpenPage(entry.pageId!)}
                >
                  {title}
                </button>
              ) : (
                <span className="block truncate text-sm font-medium text-muted-foreground">
                  {title}
                </span>
              )}
              <span className="text-xs text-muted-foreground">{describeEntry(entry)}</span>
            </div>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {formatFiredAt(entry.firedAt)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
