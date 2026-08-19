// useRecurringWrites — every write that touches a recurring series: the rules
// themselves, completion (native head and synced occurrence alike), the
// uncomplete rewinds, skips, and materialising a virtual occurrence.
//
// What holds this cluster together is that none of these writes owns the head.
// The backend derivation does: each one hands the command over and then adopts
// what the recompute produced (patchRecomputedHead), because a locally guessed
// head is the bug this whole area kept reproducing. The re-entrancy guards are
// the other half — every clone-minting path is fire-and-forget from a control
// with no disabled state, so an unguarded second call mints a duplicate.

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
  cloneWallClock,
  dateKey,
  findRecurringOccurrenceClone,
  formatDateOnly,
  getLocalTimezone,
} from "@pikos/core";
import { type Dispatch, type RefObject, type SetStateAction, useRef, useState } from "react";

/** Chaining + bound for a "complete everything to today" run. `fromHead` carries
 * the recomputed head returned by the gesture that opened the run — `pages` state
 * lags a sequential loop, so a state read would re-complete the same occurrence.
 * `maxSteps` is the runaway backstop: the dialog counted the backlog it promised. */
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
  /** Adopt the head the backend derivation produced. Also reached from the
   *  one-off schedule write, which moves a recurring anchor. */
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

export function useRecurringWrites({
  adapter,
  enqueue,
  flushPage,
  pagesRef,
  recurrenceRulesRef,
  setPages,
  setRecurrenceRules,
  updatePage,
}: {
  adapter: StorageAdapter;
  enqueue: <T>(pageId: string, fn: () => Promise<T>) => Promise<T>;
  flushPage: (id: string) => Promise<void>;
  pagesRef: RefObject<PageSummary[]>;
  recurrenceRulesRef: RefObject<PageRecurrenceRule[]>;
  setPages: Dispatch<SetStateAction<PageSummary[]>>;
  setRecurrenceRules: Dispatch<SetStateAction<PageRecurrenceRule[]>>;
  updatePage: (id: string, patch: PageUpdate) => void;
}): RecurringWrites {
  // In-flight recurring writes that mint a clone (completion by page id,
  // virtual reschedule by ruleId|originalDate). The backend creates one clone
  // per call and both UI paths are fire-and-forget with no disabled state, so a
  // re-entrant call would mint a duplicate. Checked + added synchronously
  // before the first await; cleared on settle so a later genuine call runs.
  const completingRecurringRef = useRef<Set<string>>(new Set());
  // Same guard for synced occurrences: the toggle path fires completeSyncedOccurrence
  // fire-and-forget with no disabled state, so a double-click would append the
  // (idempotent) clone twice into `pages`.
  const completingSyncedRef = useRef<Set<string>>(new Set());
  const reschedulingVirtualRef = useRef<Set<string>>(new Set());
  const [overridesVersion, setOverridesVersion] = useState(0);

  async function createRecurrence(data: NewRecurrenceRule): Promise<PageRecurrenceRule> {
    const rule = await adapter.createRecurrenceRule(data);
    setRecurrenceRules((prev) => [...prev, rule]);
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
    await adapter.deleteRecurrenceRule(ruleId);
    setRecurrenceRules((prev) => prev.filter((r) => r.id !== ruleId));
  }

  /** Re-fetch a recurring head after a backend recompute (which returns void) and
   * patch its derived fields into state, so the FE reflects the head the derivation
   * produced rather than an optimistic guess. `dropCloneId` removes the deleted done
   * clone in the same update (the uncomplete path); the drop applies even if the head
   * fetch comes back empty. */
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

  /** Uncompletes the NEWEST completed occurrence, then adopts the recomputed head.
   * Contract + false-return cases are on the interface type. */
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
   * Drag-to-reschedule (or popover Date pick) on a virtual rrule occurrence.
   * Materialises the occurrence as an independent real page: clones the head's
   * content + metadata, schedules the clone at the new time, and adds the
   * original date to the head's rruleExdates so the virtual disappears.
   *
   * The clone is a normal page — own id, status, movable, completable. The
   * head and rule are untouched, so the next virtual still appears at the
   * next non-excluded rrule occurrence.
   *
   * The previous "page_schedules override row" approach was discarded
   * because synthetic override blocks couldn't seamlessly inherit page
   * functionality (drag would duplicate, checkbox would advance the head).
   */
  async function rescheduleVirtualOccurrence(
    ruleId: string,
    originalDate: string,
    start: string,
    end?: string
  ): Promise<void> {
    // Re-entrancy guard, keyed per occurrence: callers are fire-and-forget
    // (calendar drag, popover date pick) with nothing disabled in flight, so a
    // double-invoke would materialize the same occurrence twice.
    const guardKey = `${ruleId}|${originalDate}`;
    if (reschedulingVirtualRef.current.has(guardKey)) return;
    reschedulingVirtualRef.current.add(guardKey);
    try {
      // Clone + schedule + exdate happen in ONE backend transaction — a
      // mid-sequence failure can no longer leave both the clone and the
      // still-unexcluded virtual on the calendar.
      const result = await adapter.rescheduleVirtualOccurrence({
        originalDate,
        ruleId,
        scheduledStart: start,
        timezone: getLocalTimezone(),
        ...(end !== undefined && { scheduledEnd: end }),
      });
      // No clone means the occurrence already had an override row and that row
      // moved in place. Nothing entered the page list, and no dep the calendar's
      // override fetch watches has changed — hence the explicit version bump.
      const { clone } = result;
      if (clone) {
        setPages((prev) => [...prev, clone]);
      } else {
        setOverridesVersion((v) => v + 1);
      }
      // Rule state syncs from the post-merge exdates the backend returns, not
      // a locally computed array — see addExdates in CompleteRecurringInput.
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
    // Re-entrancy guard: the checkbox path is fire-and-forget and not disabled
    // in flight, and the backend mints one clone + one head-advance per call —
    // a re-entrant call (or, now that completion is queued, a SERIALIZED
    // second call) would complete two occurrences for one gesture. Keyed per
    // occurrence (`pageId:date`, unified with the synced path) so completing two
    // different virtuals of one series in quick succession isn't dropped.
    const occKey = `${pageId}:${page?.scheduledStart?.slice(0, 10) ?? ""}`;
    if (completingRecurringRef.current.has(occKey)) return null;
    completingRecurringRef.current.add(occKey);
    try {
      // Drain any pending debounced patch for this page before advancing the
      // head. The head's denorm scheduledStart is written through the 800ms
      // debounce (e.g. when a recurring page is quick-added). If that write is
      // still pending when completion advances the head, it flushes *afterward*
      // and reverts scheduledStart to the original date — the advanced head
      // snaps back into Today alongside the done clone (two rows).
      await flushPage(pageId);
      // The completion itself runs ON the per-page mutation queue: a drag's
      // scheduleOnce writes (including its trailing denorm updatePage) may
      // still be in flight, and a completion racing past them lets the stale
      // schedule write commit AFTER the advance — rewinding the head to the
      // just-completed occurrence. Reading the refs inside the queued fn also
      // means the advance is computed from fully settled state.
      return await enqueue(pageId, () => completeRecurringPageQueued(pageId, page));
    } finally {
      completingRecurringRef.current.delete(occKey);
    }
  }

  async function completeRecurringPageQueued(
    pageId: string,
    head: PageSummary | undefined
  ): Promise<CompleteRecurringResult> {
    // An active synced head must name the occurrence it's completing: the reconciler
    // pins `pages.scheduled_start` at the series base, so the backend can't derive it
    // the way it does for a native head. The wall-clocks convert out of the source
    // zone, matching the clone a virtual completion writes.
    const syncedHead =
      head?.scheduleLocked && head.scheduledStart
        ? {
            occurrenceDate: head.scheduledStart.slice(0, 10),
            scheduledStart: cloneWallClock(head.scheduledStart, head.timezone),
            ...(head.scheduledEnd
              ? { scheduledEnd: cloneWallClock(head.scheduledEnd, head.timezone) }
              : {}),
          }
        : {};

    const result = await adapter.completeRecurringPage({ pageId, ...syncedHead });

    setPages((prev) => {
      const updated = prev.map((p) => (p.id === pageId ? result.head : p));
      return [...updated, result.clone];
    });
    return result;
  }

  /** Each step is the ordinary single completion, so the backend picks the next
   * open occurrence off truth and the client never computes a date. Stops when the
   * recomputed head reaches today, stops advancing (an out-of-envelope rule the
   * recompute can't move), or the caller's step budget runs out. */
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
    // Skips are per-occurrence state in the skip-set, not rule EXDATEs. Expansion
    // excludes each date via page.skippedOccurrences; the head is adopted from the
    // backend's recompute because a bulk dismissal can cover the head's own date.
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

  // ─── Synced recurring occurrence completion ────────────────────────────────
  // Thin routing to the unified command with the client-rendered virtual; the model
  // (why a synced series supplies its occurrence, and how the recompute converges) is
  // documented on `complete_recurring_page` in the backend.

  /** `scheduledStart`/`scheduledEnd` are the occurrence as the engine emits it —
   *  source-zone wall-clock — and convert to the viewer's zone here. */
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
        scheduledStart: cloneWallClock(input.scheduledStart, timezone),
        ...(input.scheduledEnd
          ? { scheduledEnd: cloneWallClock(input.scheduledEnd, timezone) }
          : {}),
      });
    } finally {
      completingSyncedRef.current.delete(key);
    }
    // Surface the done clone alongside the advanced head, deduped since an idempotent
    // repeat re-returns the same clone already in state.
    setPages((prev) => {
      const withHead = prev.map((p) => (p.id === input.pageId ? result.head : p));
      return prev.some((p) => p.id === result.clone.id)
        ? withHead.map((p) => (p.id === result.clone.id ? result.clone : p))
        : [...withHead, result.clone];
    });
    return result;
  }

  // The unified backend uncomplete recomputes the head (native or synced), so
  // re-fetch it rather than guess.
  async function uncompleteRecurringClone(seriesId: string, occurrenceDate: string): Promise<void> {
    const series = pagesRef.current.find((p) => p.id === seriesId);
    const cloneId = series?.completedOccurrences?.[occurrenceDate];
    await adapter.uncompleteRecurringOccurrence({ occurrenceDate, pageId: seriesId });
    await patchRecomputedHead(seriesId, cloneId);
  }

  /**
   * Intercepts the un-check of a recurring done clone (native or synced) and
   * returns true ONLY when it handled it (caller must then NOT fall through) — a
   * plain status flip would be reverted by the next recompute. Completion routes
   * the other way, through the gap dialog, which owns the scope choice.
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
