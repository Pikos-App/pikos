import type { PageSummary } from "@pikos/core";
import { pageActions, scheduleOnDay } from "@pikos/core";
import { addDays, nextMonday, startOfDay } from "date-fns";

import { usePages } from "@/shared/context/PagesContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { createLogger } from "@/shared/logger";

const log = createLogger("pageRowActions");

export type SendDay = "send-today" | "send-tomorrow" | "next-week";

const DAY_NAMES: Record<SendDay, string> = {
  "next-week": "next week",
  "send-today": "today",
  "send-tomorrow": "tomorrow",
};

function resolveDay(day: SendDay, today: Date): Date {
  if (day === "send-today") return today;
  return day === "send-tomorrow" ? addDays(today, 1) : nextMonday(today);
}

interface ScheduleEntry {
  pageId: string;
  start: string | null;
  end: string | undefined;
}

/** The list row menu's writes that no other list control already makes. */
export function usePageRowActions() {
  const { clearSchedule, createRecurrence, deleteRecurrence, recurrenceRules, scheduleOnce } =
    usePages();
  const { requestUndoableAction } = useUndoDelete();

  // One page at a time, as `useMoveOverdueToToday` does and for the same reason.
  async function apply(entries: ScheduleEntry[]): Promise<void> {
    for (const entry of entries) {
      try {
        if (entry.start === null) await clearSchedule(entry.pageId);
        else await scheduleOnce(entry.pageId, entry.start, entry.end);
      } catch (err) {
        log.error(`rescheduling ${entry.pageId} from the row menu failed`, err);
      }
    }
  }

  /** Moves each page that may be sent to a day onto it, keeping its time and length. */
  function sendToDay(pages: PageSummary[], day: SendDay): void {
    const target = resolveDay(day, startOfDay(new Date()));
    const movable = pages.filter((p) => pageActions(p).some((a) => a.id === day && a.offered));
    if (movable.length === 0) return;

    const moves = movable.map((p) => ({
      ...scheduleOnDay({ end: p.scheduledEnd, start: p.scheduledStart }, target),
      pageId: p.id,
    }));
    const previous = movable.map((p) => ({
      end: p.scheduledEnd ?? undefined,
      pageId: p.id,
      start: p.scheduledStart ?? null,
    }));
    void apply(moves);

    const count = movable.length === 1 ? "" : ` ${movable.length}`;
    requestUndoableAction(
      `send-to-day:${crypto.randomUUID()}`,
      `Moved${count} to ${DAY_NAMES[day]}`,
      () => void apply(previous)
    );
  }

  /** Ends a page's repeat; the undo puts the same rule back, skipped dates included. */
  async function stopRepeating(page: PageSummary): Promise<void> {
    const rule = recurrenceRules.find((r) => r.pageId === page.id);
    if (!rule) return;

    await deleteRecurrence(rule.id);
    const name = page.title ? `“${page.title}”` : "Page";
    requestUndoableAction(
      `stop-repeating:${crypto.randomUUID()}`,
      `${name} no longer repeats`,
      () =>
        void createRecurrence({
          pageId: rule.pageId,
          rrule: rule.rrule,
          rruleExdates: rule.rruleExdates,
          scheduledStart: rule.scheduledStart,
          ...(rule.scheduledEnd ? { scheduledEnd: rule.scheduledEnd } : {}),
          timezone: rule.timezone,
        })
    );
  }

  return { sendToDay, stopRepeating };
}
