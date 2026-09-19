// RecurringGapDialogContext — the scope prompt every recurring gesture funnels
// through. The gesture already carries the intent (tick = complete, delete =
// dismiss); the dialog only asks how far it reaches: just this occurrence, or
// everything still open before today. No backlog → no dialog, and the gesture
// commits immediately.
//
// Both origins route here. What differs is which occurrence a gesture names: a
// native series funnels every tick to its head (the oldest open occurrence),
// while a synced-origin series ticks the instance the user pointed at — its
// virtuals and moved blocks carry their own `originalDate`.

import type { PageRecurrenceRule, PageSchedule, PageSummary } from "@pikos/core";
import {
  dateKey,
  formatDateOnly,
  missedOccurrencesBetween,
  occurrenceDateOf,
  parseLocalISO,
} from "@pikos/core";
import { startOfDay, subMilliseconds } from "date-fns";
import { createContext, type ReactNode, useContext, useState } from "react";

import { usePages } from "@/shared/context/PagesContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";

/** Which gesture opened the dialog — it decides the copy and the write, never
 *  the scope question itself. */
export type GapKind = "complete" | "delete";
/** The gestured occurrence alone, or it plus everything open before today. */
export type GapScope = "one" | "all";

interface PendingGap {
  kind: GapKind;
  /** The occurrence the gesture named — the series head, or a rendered occurrence. */
  target: PageSummary;
  pageTitle: string;
  occurrenceDate: string;
  /** Open occurrence dates before today, excluding the gestured one. */
  missedDates: string[];
  /** An active mirror is read-first: a delete here removes the local copy only. */
  syncedActive: boolean;
}

export interface RecurringGapDialogContextValue {
  /** Tick on any recurring entry point — head, synced virtual, or moved block. */
  requestComplete: (page: PageSummary) => void;
  /** Delete on a rendered occurrence. Whole-series delete does not come here. */
  requestDelete: (page: PageSummary) => void;
  /** Internal dialog state — read by the mounted RecurringGapDialog. */
  pending: PendingGap | null;
  confirm: (scope: GapScope) => void;
  cancel: () => void;
}

const RecurringGapDialogContext = createContext<RecurringGapDialogContextValue | null>(null);

export function useRecurringGapDialog(): RecurringGapDialogContextValue {
  const ctx = useContext(RecurringGapDialogContext);
  if (!ctx) {
    throw new Error("useRecurringGapDialog must be used inside a RecurringGapDialogProvider");
  }
  return ctx;
}

/**
 * Dates already taken out of the series: rule EXDATEs ∪ completed ∪ skipped.
 * Day-keyed, because a synced timed exdate is stored as full wall-clock while
 * occurrences match on the day alone (see `dateKey`).
 */
function occurrenceExclusions(rule: PageRecurrenceRule, head: PageSummary | undefined): string[] {
  return [
    ...rule.rruleExdates,
    ...Object.keys(head?.completedOccurrences ?? {}),
    ...(head?.skippedOccurrences ?? []),
  ].map(dateKey);
}

/**
 * Open occurrences from the head up to (not including) today, minus the one the
 * gesture named. The head is the oldest open occurrence, so it bounds the search
 * — and it is itself part of the backlog whenever the gesture pointed elsewhere,
 * which is why the window opens a millisecond before its day rather than at the
 * head's own instant.
 */
function missedBefore(
  rule: PageRecurrenceRule,
  head: PageSummary | undefined,
  gesturedDate: string
): string[] {
  const headStart = head?.scheduledStart;
  if (!headStart) return [];
  const todayStart = startOfDay(new Date());
  const from = subMilliseconds(startOfDay(parseLocalISO(headStart)), 1);
  if (todayStart <= from) return [];
  const dates = missedOccurrencesBetween(
    rule.rrule,
    rule.scheduledStart,
    from,
    todayStart,
    occurrenceExclusions(rule, head)
  );
  const floor = head.syncedSince;
  return dates.filter((d) => d !== gesturedDate && (!floor || d >= floor));
}

export function RecurringGapDialogProvider({ children }: { children: ReactNode }) {
  const {
    completeRecurringPage,
    completeRecurringToToday,
    completeSyncedOccurrence,
    listOverridesForRules,
    pages,
    recurrenceRules,
    skipOccurrences,
  } = usePages();
  const { requestUndoableAction } = useUndoDelete();
  const [pending, setPending] = useState<PendingGap | null>(null);

  /** A moved occurrence is an override row, not a gap: its original date is
   *  excluded from the head's derivation, so it is neither open nor missed.
   *  Synced-origin series only — a native move re-homes via a clone + EXDATE. */
  async function withoutMovedOccurrences(ruleId: string, dates: string[]): Promise<string[]> {
    const overrides: PageSchedule[] = await listOverridesForRules([ruleId]);
    const moved = new Set(
      overrides.filter((s) => s.originalDate).map((s) => dateKey(s.originalDate!))
    );
    return dates.filter((d) => !moved.has(d));
  }

  async function open(kind: GapKind, page: PageSummary): Promise<void> {
    const head = pages.find((p) => p.id === page.id);
    const rule = recurrenceRules.find((r) => r.pageId === page.id);
    // Not a recurring series — the caller is wrong to route here. A tick still
    // reaches the writer (which rejects it loudly); a dismissal has no series to
    // write against and there is nothing to salvage.
    if (!rule) {
      if (kind === "complete") void completeRecurringPage(page.id);
      return;
    }
    const gesturedDate = occurrenceDateOf(page) ?? dateKey(head?.scheduledStart ?? "");

    // The dialog resolves a backlog, so only a gesture inside the backlog opens
    // it: ticking next week's occurrence has nothing to do with last week's.
    if (!gesturedDate || gesturedDate >= formatDateOnly(new Date())) return run(kind, page, "one");

    const candidates = missedBefore(rule, head, gesturedDate);
    if (candidates.length === 0) return run(kind, page, "one");
    const missedDates = head?.syncState
      ? await withoutMovedOccurrences(rule.id, candidates)
      : candidates;
    if (missedDates.length === 0) return run(kind, page, "one");

    setPending({
      kind,
      missedDates,
      occurrenceDate: gesturedDate,
      pageTitle: head?.title || page.title || "Untitled",
      syncedActive: head?.syncState === "active",
      target: page,
    });
  }

  async function run(
    kind: GapKind,
    page: PageSummary,
    scope: GapScope,
    missedDates: string[] = []
  ): Promise<void> {
    if (kind === "delete") return dismiss(page, scope, missedDates);

    // A synced-origin occurrence names itself; a head lets the backend derive it.
    const occurrence = occurrenceDateOf(page);
    const result =
      occurrence && page.scheduledStart
        ? await completeSyncedOccurrence({
            occurrenceDate: occurrence,
            pageId: page.id,
            scheduledStart: page.scheduledStart,
            ...(page.scheduledEnd ? { scheduledEnd: page.scheduledEnd } : {}),
          })
        : await completeRecurringPage(page.id);
    if (scope === "one") return;
    await completeRecurringToToday(page.id, {
      maxSteps: missedDates.length,
      ...(result?.head ? { fromHead: result.head } : {}),
    });
  }

  async function dismiss(page: PageSummary, scope: GapScope, missedDates: string[]): Promise<void> {
    const gesturedDate = occurrenceDateOf(page) ?? dateKey(page.scheduledStart ?? "");
    const dates = scope === "all" ? [gesturedDate, ...missedDates] : [gesturedDate];
    const undo = await skipOccurrences(page.id, dates);
    const label =
      dates.length === 1
        ? `Deleted one occurrence of “${page.title || "Untitled"}”`
        : `Deleted ${dates.length} occurrences of “${page.title || "Untitled"}”`;
    requestUndoableAction(`skip:${page.id}:${gesturedDate}`, label, undo);
  }

  function requestComplete(page: PageSummary): void {
    void open("complete", page);
  }

  function requestDelete(page: PageSummary): void {
    void open("delete", page);
  }

  function confirm(scope: GapScope): void {
    const target = pending;
    setPending(null);
    if (!target) return;
    void run(target.kind, target.target, scope, target.missedDates);
  }

  function cancel(): void {
    setPending(null);
  }

  const value: RecurringGapDialogContextValue = {
    cancel,
    confirm,
    pending,
    requestComplete,
    requestDelete,
  };

  return (
    <RecurringGapDialogContext.Provider value={value}>
      {children}
    </RecurringGapDialogContext.Provider>
  );
}
