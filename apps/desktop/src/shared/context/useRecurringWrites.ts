// None of these writes owns the head: the backend derivation does. Each hands the command over
// and adopts what the recompute produced (patchRecomputedHead), since a locally guessed head is
// wrong. Clone-minting paths are fire-and-forget from controls with no disabled state, so each
// is re-entrancy guarded.

import type {
  CompleteRecurringResult,
  NewRecurrenceRule,
  PageRecurrenceRule,
  PageSchedule,
  PageStatus,
  PageSummary,
  PageUpdate,
  RawRuleExpansion,
  RecurrenceRuleUpdate,
  StorageAdapter,
} from "@pikos/core";
import {
  dateKey,
  findRecurringOccurrenceClone,
  formatDateOnly,
  getLocalTimezone,
  toStorageError,
  viewerWallClock,
} from "@pikos/core";
import { type Dispatch, type RefObject, type SetStateAction, useRef, useState } from "react";

/** Chaining + bound for a "complete everything to today" run. `fromHead` carries the recomputed
 * head returned by the gesture that opened the run: `pages` state lags a sequential loop, so a
 * state read would re-complete the same occurrence. `maxSteps` is the runaway backstop. */
export interface GapRunOptions {
  fromHead?: PageSummary;
  maxSteps?: number;
}

export interface RecurringWrites {
  completeRecurringPage: (
    pageId: string,
    head?: PageSummary
  ) => Promise<CompleteRecurringResult | null>;
  completeRecurringToToday: (pageId: string, opts?: GapRunOptions) => Promise<void>;
  completeSyncedOccurrence: (input: {
    pageId: string;
    occurrenceDate: string;
    scheduledStart: string;
    scheduledEnd?: string;
  }) => Promise<CompleteRecurringResult | null>;
  createRecurrence: (data: NewRecurrenceRule) => Promise<PageRecurrenceRule>;
  deleteRecurrence: (ruleId: string) => Promise<void>;
  expandRecurrenceRange: (
    rules: PageRecurrenceRule[],
    rangeStart: string,
    rangeEnd: string
  ) => Promise<RawRuleExpansion[]>;
  listOverridesForRules: (ruleIds: string[]) => Promise<PageSchedule[]>;
  maybeUncompleteRecurringClone: (page: PageSummary, nextStatus: PageStatus) => boolean;
  overridesVersion: number;
  /** Adopt the head the backend derivation produced. Also reached from the one-off schedule write. */
  patchRecomputedHead: (pageId: string, dropCloneId?: string) => Promise<void>;
  rescheduleVirtualOccurrence: (
    ruleId: string,
    originalDate: string,
    start: string,
    end?: string
  ) => Promise<void>;
  skipOccurrences: (pageId: string, dates: string[]) => Promise<() => void>;
  uncompleteRecurringHead: (pageId: string) => Promise<boolean>;
  uncompleteRecurringOrFlip: (pageId: string) => Promise<void>;
  updateRecurrence: (ruleId: string, updates: RecurrenceRuleUpdate) => Promise<PageRecurrenceRule>;
}

/** Replaces any copy already listed: an idempotent repeat returns the same clone, and a fetch
 *  that ran during the write can land it first. Appending blind listed the page twice. */
function upsertPage(pages: PageSummary[], page: PageSummary): PageSummary[] {
  return pages.some((p) => p.id === page.id)
    ? // Stryker disable next-line ConditionalExpression: the copy already listed is the same page
      pages.map((p) => (p.id === page.id ? page : p))
    : [...pages, page];
}

export function useRecurringWrites({
  adapter,
  enqueue,
  pagesRef,
  recurrenceRulesRef,
  setPages,
  setRecurrenceRules,
  updatePage,
}: {
  adapter: StorageAdapter;
  enqueue: <T>(pageId: string, fn: () => Promise<T>) => Promise<T>;
  pagesRef: RefObject<PageSummary[]>;
  recurrenceRulesRef: RefObject<PageRecurrenceRule[]>;
  setPages: Dispatch<SetStateAction<PageSummary[]>>;
  setRecurrenceRules: Dispatch<SetStateAction<PageRecurrenceRule[]>>;
  updatePage: (id: string, patch: PageUpdate) => void;
}): RecurringWrites {
  // Clone-minting writes in flight (completion by page id, virtual reschedule by
  // ruleId|originalDate). Callers are fire-and-forget, so a re-entrant call would mint a
  // duplicate. Checked and added before the first await; cleared on settle.
  const completingRecurringRef = useRef<Set<string>>(new Set());
  // Same guard for synced occurrences, whose idempotent clone would otherwise append twice.
  const completingSyncedRef = useRef<Set<string>>(new Set());
  const reschedulingVirtualRef = useRef<Set<string>>(new Set());
  const [overridesVersion, setOverridesVersion] = useState(0);

  /** `isRecurring` is the backend's projection, read with the page, so a rule added or removed here
   *  leaves it stale unless patched too. Stale, "Move to today" moved a new series as a plain page. */
  function markRecurring(pageId: string, isRecurring: boolean): void {
    setPages((prev) => prev.map((p) => (p.id === pageId ? { ...p, isRecurring } : p)));
  }

  async function createRecurrence(data: NewRecurrenceRule): Promise<PageRecurrenceRule> {
    const rule = await adapter.createRecurrenceRule(data);
    setRecurrenceRules((prev) => [...prev, rule]);
    markRecurring(data.pageId, true);
    return rule;
  }

  async function updateRecurrence(
    ruleId: string,
    updates: RecurrenceRuleUpdate
  ): Promise<PageRecurrenceRule> {
    const updated = await adapter.updateRecurrenceRule(ruleId, updates);
    setRecurrenceRules((prev) => prev.map((r) => (r.id === ruleId ? updated : r)));
    return updated;
  }

  async function deleteRecurrence(ruleId: string): Promise<void> {
    // Stryker disable next-line OptionalChaining: a rule is only deleted from the state that lists it
    const pageId = recurrenceRulesRef.current.find((r) => r.id === ruleId)?.pageId;
    await adapter.deleteRecurrenceRule(ruleId);
    setRecurrenceRules((prev) => prev.filter((r) => r.id !== ruleId));
    // Stryker disable next-line ConditionalExpression: marking no page is a no-op
    if (pageId) markRecurring(pageId, false);
  }

  /** Re-fetch a recurring head after a backend recompute (which returns void) and patch its
   * derived fields into state. `dropCloneId` removes the deleted done clone in the same update. */
  async function patchRecomputedHead(pageId: string, dropCloneId?: string): Promise<void> {
    const fresh = await adapter.getPage(pageId);
    setPages((prev) => {
      const base = dropCloneId ? prev.filter((p) => p.id !== dropCloneId) : prev;
      if (!fresh) return base;
      return base.map((p) =>
        p.id === pageId
          ? {
              ...p,
              completedAt: fresh.completedAt ?? null,
              completedOccurrences: fresh.completedOccurrences ?? null,
              scheduledEnd: fresh.scheduledEnd ?? null,
              scheduledStart: fresh.scheduledStart ?? null,
              status: fresh.status,
            }
          : p
      );
    });
  }

  /** Uncompletes the NEWEST completed occurrence, then adopts the recomputed head. */
  async function uncompleteRecurringHead(pageId: string): Promise<boolean> {
    const head = pagesRef.current.find((p) => p.id === pageId);
    if (!head || head.scheduleLocked) return false;
    if (!recurrenceRulesRef.current.some((r) => r.pageId === pageId)) return false;
    const map = head.completedOccurrences;
    const keys = map ? Object.keys(map) : [];
    if (keys.length === 0) return false;
    const newestDate = keys.reduce((a, b) => (a > b ? a : b));
    const cloneId = map![newestDate];
    await enqueue(pageId, async () => {
      await adapter.uncompleteRecurringOccurrence({ occurrenceDate: newestDate, pageId });
      await patchRecomputedHead(pageId, cloneId);
    });
    return true;
  }

  async function uncompleteRecurringOrFlip(pageId: string): Promise<void> {
    if (await uncompleteRecurringHead(pageId)) return;
    updatePage(pageId, { completedAt: null, status: "not_started" });
  }

  /**
   * Drag-to-reschedule or popover date pick on a virtual rrule occurrence: materialises it as an
   * independent page (clone of the head, scheduled at the new time) and adds the original date to
   * the head's rruleExdates. An override row instead would not inherit page behaviour: drag would
   * duplicate, and the checkbox would advance the head.
   */
  async function rescheduleVirtualOccurrence(
    ruleId: string,
    originalDate: string,
    start: string,
    end?: string
  ): Promise<void> {
    const guardKey = `${ruleId}|${originalDate}`;
    if (reschedulingVirtualRef.current.has(guardKey)) return;
    reschedulingVirtualRef.current.add(guardKey);
    try {
      // One backend transaction, so a mid-sequence failure can't leave both the clone and the
      // unexcluded virtual on the calendar.
      const result = await adapter.rescheduleVirtualOccurrence({
        originalDate,
        ruleId,
        scheduledStart: start,
        timezone: getLocalTimezone(),
        ...(end !== undefined && { scheduledEnd: end }),
      });
      // No clone means the occurrence already had an override row that moved in place: no dep the
      // calendar's override fetch watches changed, hence the explicit version bump.
      const { clone } = result;
      if (clone) {
        setPages((prev) => upsertPage(prev, clone));
      } else {
        setOverridesVersion((v) => v + 1);
      }
      // Rule state syncs from the post-merge exdates the backend returns, not a locally computed array.
      setRecurrenceRules((prev) =>
        prev.map((r) => (r.id === ruleId ? { ...r, rruleExdates: result.ruleExdates } : r))
      );
    } finally {
      reschedulingVirtualRef.current.delete(guardKey);
    }
  }

  function listOverridesForRules(ruleIds: string[]) {
    return adapter.listPageSchedulesForRules(ruleIds);
  }

  function expandRecurrenceRange(
    rules: PageRecurrenceRule[],
    rangeStart: string,
    rangeEnd: string
  ) {
    return adapter.expandRecurrenceRange(rules, rangeStart, rangeEnd);
  }

  async function completeRecurringPage(
    pageId: string,
    head?: PageSummary
  ): Promise<CompleteRecurringResult | null> {
    const page = head ?? pagesRef.current.find((p) => p.id === pageId);
    // The backend mints one clone and one head-advance per call, so a re-entrant or queued second
    // call would complete two occurrences. Keyed per occurrence (`pageId:date`) so two virtuals of
    // one series aren't dropped.
    const occKey = `${pageId}:${page?.scheduledStart?.slice(0, 10) ?? ""}`;
    if (completingRecurringRef.current.has(occKey)) return null;
    completingRecurringRef.current.add(occKey);
    try {
      // Runs on the per-page mutation queue: a drag's scheduleOnce writes may still be in flight, and
      // a completion racing past them lets the stale schedule write commit AFTER the advance,
      // rewinding the head. Refs are read inside the queued fn so the advance sees settled state.
      return await enqueue(pageId, () => completeRecurringPageQueued(pageId, page));
    } finally {
      completingRecurringRef.current.delete(occKey);
    }
  }

  async function completeRecurringPageQueued(
    pageId: string,
    head: PageSummary | undefined
  ): Promise<CompleteRecurringResult | null> {
    // An active synced head must name its occurrence: the reconciler pins `pages.scheduled_start` at
    // the series base, so the backend can't derive it. The wall-clocks convert out of the source
    // zone, matching the clone a virtual completion writes.
    const syncedHead =
      head?.scheduleLocked && head.scheduledStart
        ? {
            occurrenceDate: head.scheduledStart.slice(0, 10),
            scheduledStart: viewerWallClock(head.scheduledStart, head.timezone),
            ...(head.scheduledEnd
              ? { scheduledEnd: viewerWallClock(head.scheduledEnd, head.timezone) }
              : {}),
          }
        : {};

    // A native head names no occurrence, so the backend derives it from the head at write time.
    // Naming the one aimed at keeps a CLI `done` that landed first from becoming a second advance.
    const expected =
      !head?.scheduleLocked && head?.scheduledStart
        ? { expectedOccurrenceDate: head.scheduledStart.slice(0, 10) }
        : {};

    // The series moved under this gesture, so the tick applies to nothing and the watcher's refetch
    // carries the truth. Only a call that sent an expectation absorbs its refusal.
    let result: CompleteRecurringResult;
    try {
      result = await adapter.completeRecurringPage({ pageId, ...syncedHead, ...expected });
    } catch (err: unknown) {
      if (expected.expectedOccurrenceDate && toStorageError(err).kind === "Conflict") return null;
      throw err;
    }

    setPages((prev) =>
      upsertPage(
        prev.map((p) => (p.id === pageId ? result.head : p)),
        result.clone
      )
    );
    return result;
  }

  /** Each step is the ordinary single completion, so the client never computes a date. Stops when
   * the recomputed head reaches today, stops advancing, or the step budget runs out. */
  async function completeRecurringToToday(pageId: string, opts: GapRunOptions = {}): Promise<void> {
    const todayKey = formatDateOnly(new Date());
    const budget = opts.maxSteps ?? Number.MAX_SAFE_INTEGER;
    let head = opts.fromHead ?? pagesRef.current.find((p) => p.id === pageId);
    for (let step = 0; step < budget; step++) {
      const start = head?.scheduledStart;
      if (!head || !start || head.status === "done") return;
      if (dateKey(start) >= todayKey) return;
      const result = await completeRecurringPage(pageId, head);
      if (!result || result.head.scheduledStart === start) return;
      head = result.head;
    }
  }

  async function skipOccurrences(pageId: string, dates: string[]): Promise<() => void> {
    // Skips are per-occurrence state in the skip-set, not rule EXDATEs. The head is adopted from the
    // recompute because a bulk dismissal can cover the head's own date.
    for (const date of dates) {
      await adapter.skipOccurrence({ occurrenceDate: date, pageId });
    }
    setPages((prev) =>
      prev.map((p) =>
        p.id === pageId
          ? { ...p, skippedOccurrences: [...(p.skippedOccurrences ?? []), ...dates] }
          : p
      )
    );
    await patchRecomputedHead(pageId);

    return () => {
      void (async () => {
        for (const date of dates) {
          await adapter.undoSkipOccurrence({ occurrenceDate: date, pageId });
        }
        setPages((prev) =>
          prev.map((p) =>
            p.id === pageId
              ? {
                  ...p,
                  skippedOccurrences: (p.skippedOccurrences ?? []).filter(
                    (d) => !dates.includes(d)
                  ),
                }
              : p
          )
        );
        await patchRecomputedHead(pageId);
      })();
    };
  }

  // Routing to the unified command; the model is documented on `complete_recurring_page` in the
  // backend.

  /** The occurrence as the engine emits it, in source-zone wall-clock, converted to the viewer's zone here. */
  async function completeSyncedOccurrence(input: {
    pageId: string;
    occurrenceDate: string;
    scheduledStart: string;
    scheduledEnd?: string;
  }): Promise<CompleteRecurringResult | null> {
    const key = `${input.pageId}:${input.occurrenceDate}`;
    if (completingSyncedRef.current.has(key)) return null;
    completingSyncedRef.current.add(key);
    const timezone = pagesRef.current.find((p) => p.id === input.pageId)?.timezone;
    let result: CompleteRecurringResult;
    try {
      result = await adapter.completeRecurringPage({
        ...input,
        scheduledStart: viewerWallClock(input.scheduledStart, timezone),
        ...(input.scheduledEnd
          ? { scheduledEnd: viewerWallClock(input.scheduledEnd, timezone) }
          : {}),
      });
    } finally {
      completingSyncedRef.current.delete(key);
    }
    setPages((prev) =>
      upsertPage(
        prev.map((p) => (p.id === input.pageId ? result.head : p)),
        result.clone
      )
    );
    return result;
  }

  async function uncompleteRecurringClone(seriesId: string, occurrenceDate: string): Promise<void> {
    const series = pagesRef.current.find((p) => p.id === seriesId);
    const cloneId = series?.completedOccurrences?.[occurrenceDate];
    await adapter.uncompleteRecurringOccurrence({ occurrenceDate, pageId: seriesId });
    await patchRecomputedHead(seriesId, cloneId);
  }

  /**
   * Intercepts the un-check of a recurring done clone (native or synced). Returns true ONLY when it
   * handled it, so the caller must not fall through: a plain status flip would be reverted by the
   * next recompute. Completion routes through the gap dialog instead.
   */
  function maybeUncompleteRecurringClone(page: PageSummary, nextStatus: PageStatus): boolean {
    if (nextStatus !== "not_started") return false;
    const found = findRecurringOccurrenceClone(pagesRef.current, page.id);
    if (!found) return false;
    void uncompleteRecurringClone(found.seriesId, found.occurrenceDate);
    return true;
  }

  return {
    completeRecurringPage,
    completeRecurringToToday,
    completeSyncedOccurrence,
    createRecurrence,
    deleteRecurrence,
    expandRecurrenceRange,
    listOverridesForRules,
    maybeUncompleteRecurringClone,
    overridesVersion,
    patchRecomputedHead,
    rescheduleVirtualOccurrence,
    skipOccurrences,
    uncompleteRecurringHead,
    uncompleteRecurringOrFlip,
    updateRecurrence,
  };
}
