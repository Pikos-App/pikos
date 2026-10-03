import type {
  PageRecurrenceRule,
  PageSchedule,
  PageSummary,
  RawOccurrence,
  RawRuleExpansion,
  VirtualOccurrence,
} from "@pikos/core";
import { dateKey, formatDateOnly } from "@pikos/core";
import { addDays } from "date-fns";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

interface UseRecurrenceExpansionParams {
  pages: PageSummary[];
  recurrenceRules: PageRecurrenceRule[];
  /** The days currently visible in the week grid. */
  days: Date[];
  /** Fetch the given rules' materialised override rows, regardless of where each
   *  was moved. Keyed by rule (not range) so an override moved out of the visible
   *  week still excludes its original slot — a range fetch misses it entirely. */
  listOverridesForRules: (ruleIds: string[]) => Promise<PageSchedule[]>;
  /** Batched raw rrule expansion via the Rust engine (rule EXDATEs applied;
   * completed/skip union NOT applied — that stays here, client-side). */
  expandRecurrenceRange: (
    rules: PageRecurrenceRule[],
    rangeStart: string,
    rangeEnd: string
  ) => Promise<RawRuleExpansion[]>;
  /** Refetch trigger for an override row that moved in place. Such a move leaves
   *  the range and the rule set identical, so nothing else below would refire. */
  overridesVersion?: number;
  /** Days expanded beyond each side of `days`, so a step to the next or previous range
   *  shows its occurrences at once instead of fetching them after the first paint. */
  margin?: number;
}

/** Raw occurrences by rule for `start` to `end`, expanded for `rulesKey`. */
interface HeldExpansion {
  byRule: Map<string, RawOccurrence[]>;
  end: string;
  rulesKey: string;
  start: string;
}

const holds = (held: HeldExpansion | null, rulesKey: string, start: string, end: string) =>
  held !== null && held.rulesKey === rulesKey && held.start <= start && held.end >= end;

/** The part of a held expansion from `start` to `end`. The engine places an occurrence in a
 *  range by its start, and local ISO strings order as their instants do. */
function slice(held: HeldExpansion, start: string, end: string): Map<string, RawOccurrence[]> {
  if (held.start === start && held.end === end) return held.byRule;
  const out = new Map<string, RawOccurrence[]>();
  for (const [ruleId, occurrences] of held.byRule) {
    out.set(
      ruleId,
      occurrences.filter((o) => o.scheduledStart >= start && o.scheduledStart < end)
    );
  }
  return out;
}

const sameOccurrences = (a: RawOccurrence[], b: RawOccurrence[]) =>
  a.length === b.length &&
  a.every(
    (o, i) =>
      o.scheduledStart === b[i]!.scheduledStart &&
      o.scheduledEnd === b[i]!.scheduledEnd &&
      o.originalDate === b[i]!.originalDate
  );

/**
 * The expansion a surface holds, kept outside React state: a refill of the margin re-renders
 * nothing unless the occurrences on screen changed, where a state update re-rendered a whole
 * week to show the same blocks.
 */
class ExpansionHold {
  private held: HeldExpansion | null = null;
  private last: Map<string, RawOccurrence[]> | null = null;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  holds(rulesKey: string, start: string, end: string): boolean {
    return holds(this.held, rulesKey, start, end);
  }

  set(held: HeldExpansion): void {
    this.held = held;
    for (const listener of this.listeners) listener();
  }

  /** Occurrences from `start` to `end`, or the last held while that range loads; the same map
   *  while its contents are. */
  read(rulesKey: string, start: string, end: string): Map<string, RawOccurrence[]> | null {
    if (!this.held) return null;
    const next = this.holds(rulesKey, start, end) ? slice(this.held, start, end) : this.held.byRule;
    const last = this.last;
    if (
      last &&
      last.size === next.size &&
      [...next].every(([id, o]) => {
        const before = last.get(id);
        return before !== undefined && sameOccurrences(before, o);
      })
    )
      return last;
    this.last = next;
    return next;
  }
}

/** Day-keyed union of a series' completed and skipped occurrence dates. A synced
 * timed entry is stored as full wall-clock, so it must be day-keyed to match the
 * day-only occurrence key (see dateKey). */
function completedOrSkippedKeys(page: PageSummary): Set<string> {
  return new Set(
    [...Object.keys(page.completedOccurrences ?? {}), ...(page.skippedOccurrences ?? [])].map(
      dateKey
    )
  );
}

/** The first page with each id, the one `pages.find` would return. */
function indexById(pages: PageSummary[]): Map<string, PageSummary> {
  const byId = new Map<string, PageSummary>();
  for (const p of pages) {
    if (!byId.has(p.id)) byId.set(p.id, p);
  }
  return byId;
}

function overridesByRule(overrideSchedules: PageSchedule[]): Map<string, PageSchedule[]> {
  const byRule = new Map<string, PageSchedule[]>();
  for (const s of overrideSchedules) {
    if (!s.ruleId) continue;
    const list = byRule.get(s.ruleId);
    if (list) list.push(s);
    else byRule.set(s.ruleId, [s]);
  }
  return byRule;
}

/** Applies the client-side exclusion union (completed ∪ skip ∪ materialised
 * overrides), the own-date head suppression, and a synced series' render floor
 * to a rule's raw occurrences, shaping each survivor into a VirtualOccurrence.
 *
 * The floor is the only bound on how far back expansion reaches — the range
 * alone would paint a synced series into any past week the user navigates to.
 * See `PageSummary.syncedSince`. */
function toVirtuals(
  raw: RawOccurrence[],
  page: PageSummary,
  rule: PageRecurrenceRule,
  ruleOverrides: PageSchedule[]
): VirtualOccurrence[] {
  const excluded = completedOrSkippedKeys(page);
  for (const s of ruleOverrides) {
    if (s.originalDate) excluded.add(dateKey(s.originalDate));
  }
  // Only the head's own date is suppressed (the head block already renders it).
  // Other pre-head dates need no filter: a head move shifts the rule anchor so
  // vacated dates stop being emitted, and completion/skip lands them in the
  // exclusion union above. A date that's neither is a genuine open gap and stays visible.
  const headDate = page.scheduledStart?.slice(0, 10);
  const out: VirtualOccurrence[] = [];
  for (const occ of raw) {
    if (excluded.has(occ.originalDate)) continue;
    if (headDate && occ.originalDate === headDate) continue;
    if (page.syncedSince && occ.originalDate < page.syncedSince) continue;
    out.push({
      ...page,
      isVirtual: true,
      originalDate: occ.originalDate,
      ruleId: rule.id,
      scheduledEnd: occ.scheduledEnd,
      scheduledStart: occ.scheduledStart,
    });
  }
  return out;
}

/** A moved synced occurrence, shaped from its series page + the override row's
 * schedule. Deliberately not a `VirtualOccurrence` (no `isVirtual`), so it
 * renders the page's own treatment — checkbox, sync icon, popover — instead of
 * the recurring glyph; it reads as a real, completable event. `originalDate`
 * (day-key) is the *original* occurrence for the completion key and reminder
 * derivation, not the day it moved to. */
type OverrideBlock = PageSummary & { originalDate: string };

/** Shapes each synced override row into a completable block at its moved time,
 * carrying the page's own lock state — locked while actively synced, unlocked
 * once detached, since a detached series is the user's.
 *
 * Gated on sync *origin*, not lock state: only a synced series has override rows
 * at all (a native reschedule re-homes via a clone + exdate and never writes
 * one), so `syncState` is the predicate that matches the invariant. Gating on
 * `scheduleLocked` — which is `sync_state = 'active'` alone — dropped a detached
 * series' moved instance from the calendar entirely, because `toVirtuals` goes on
 * suppressing its original slot regardless of lock state.
 *
 * Excludes an override whose original occurrence is already completed or skipped
 * (the done clone renders instead — a rendered override beside it would double
 * the slot). */
function toOverrideBlocks(
  rules: PageRecurrenceRule[],
  pageById: Map<string, PageSummary>,
  overrideSchedules: PageSchedule[]
): OverrideBlock[] {
  const rulePage = new Map<string, PageSummary>();
  for (const rule of rules) {
    const page = pageById.get(rule.pageId);
    if (page) rulePage.set(rule.id, page);
  }

  const out: OverrideBlock[] = [];
  for (const s of overrideSchedules) {
    if (!s.ruleId || !s.originalDate) continue;
    const page = rulePage.get(s.ruleId);
    if (!page || !page.syncState) continue;
    const originalKey = dateKey(s.originalDate);
    if (completedOrSkippedKeys(page).has(originalKey)) continue;
    out.push({
      ...page,
      originalDate: originalKey,
      scheduledEnd: s.scheduledEnd ?? null,
      scheduledStart: s.scheduledStart,
    });
  }
  return out;
}

/**
 * Returns pages merged with virtual rrule occurrences for the visible range, so
 * a surface renders both identically — the calendar grid over its week, the
 * Today list over the one day it shows. Expansion runs in the Rust engine over
 * IPC (stale-while-revalidate); the completed/skip exclusion union and the head
 * suppression stay synchronous and client-side, so a completion reflects on the
 * next render without waiting for a round-trip. Virtual occurrences carry
 * `isVirtual: true` for downstream identification.
 */
export function useRecurrenceExpansion({
  days,
  expandRecurrenceRange,
  listOverridesForRules,
  margin = 0,
  overridesVersion = 0,
  pages,
  recurrenceRules,
}: UseRecurrenceExpansionParams): (PageSummary | VirtualOccurrence)[] {
  const [overrideSchedules, setOverrideSchedules] = useState<PageSchedule[]>([]);
  const schedulesAbortRef = useRef(0);

  // Empty until the first IPC batch resolves. Kept across a range change
  // (stale-while-revalidate) so an overlapping or day-step nav keeps showing
  // virtuals while the next batch is in flight; a jump past the margin still
  // renders without them for a frame (accepted).
  const [expansion] = useState(() => new ExpansionHold());
  const expandAbortRef = useRef(0);

  const rangeStartDate = days[0];
  const lastDay = days[days.length - 1];
  const rangeEndDate = lastDay ? addDays(lastDay, 1) : null;
  const startStr = rangeStartDate ? formatDateOnly(rangeStartDate) : null;
  const endStr = rangeEndDate ? formatDateOnly(rangeEndDate) : null;
  const fetchStart = rangeStartDate ? formatDateOnly(addDays(rangeStartDate, -margin)) : null;
  const fetchEnd = rangeEndDate ? formatDateOnly(addDays(rangeEndDate, margin)) : null;
  const ruleCount = recurrenceRules.length;
  // Stable key over the fields that change a rule's raw expansion, so the IPC
  // effect refires on a rule edit/add/remove but not on unrelated page changes.
  const rulesKey = recurrenceRules
    .map(
      (r) =>
        `${r.id}:${r.rrule}:${r.scheduledStart}:${r.scheduledEnd ?? ""}:${r.rruleExdates.join(",")}`
    )
    .join("|");

  // Fetch depends only on the rule set (position-independent), so `rulesKey`
  // drives it. Range stays in the deps as a cheap refetch-on-nav safety net for
  // an override changed out-of-band since the last rule edit — one batched call.
  useEffect(() => {
    if (!startStr || !endStr || ruleCount === 0) return;

    const ruleIds = recurrenceRules.map((r) => r.id);
    const token = ++schedulesAbortRef.current;
    void listOverridesForRules(ruleIds).then((schedules) => {
      if (token !== schedulesAbortRef.current) return;
      setOverrideSchedules((prev) => {
        // Identity spans every consumed field, not just the id — an in-place
        // move keeps the row id, so an id-only compare kept the stale slot.
        const identity = (s: PageSchedule): string =>
          `${s.id}:${s.ruleId ?? ""}:${s.originalDate ?? ""}:${s.scheduledStart}:${s.scheduledEnd ?? ""}`;
        if (
          prev.length === schedules.length &&
          prev.every((p, i) => identity(p) === identity(schedules[i]!))
        ) {
          return prev;
        }
        return schedules;
      });
    });
  }, [startStr, endStr, rulesKey, overridesVersion]);

  const rawExpansion = useSyncExternalStore(expansion.subscribe, () =>
    startStr && endStr ? expansion.read(rulesKey, startStr, endStr) : null
  );

  useEffect(() => {
    if (!fetchStart || !fetchEnd || ruleCount === 0) return;
    if (margin > 0 && expansion.holds(rulesKey, fetchStart, fetchEnd)) return;

    const token = ++expandAbortRef.current;
    void expandRecurrenceRange(recurrenceRules, fetchStart, fetchEnd).then((result) => {
      if (token !== expandAbortRef.current) return;
      expansion.set({
        byRule: new Map(result.map((r) => [r.ruleId, r.occurrences])),
        end: fetchEnd,
        rulesKey,
        start: fetchStart,
      });
    });
  }, [startStr, endStr, rulesKey]);

  // Suppress a recurring head block when its own date is completed. Usually a
  // no-op (the head already advances past a completed occurrence), but load-
  // bearing for an out-of-envelope rule the engine rejects: recompute never
  // advances such a head, so without this it'd render next to its done clone.
  // Applies to native or synced rules alike. Computed before the empty-rules
  // early return so a completed base is hidden even before the rules load.
  const headCompleted = (p: PageSummary): boolean => {
    const baseDate = p.scheduledStart?.slice(0, 10);
    return !!(baseDate && p.completedOccurrences?.[baseDate]);
  };
  const visiblePages = pages.some(headCompleted) ? pages.filter((p) => !headCompleted(p)) : pages;

  if (recurrenceRules.length === 0) return visiblePages;

  if (!days[0] || !days[days.length - 1]) return visiblePages;

  // Before the first batch resolves: render pages only for this frame; virtuals
  // appear once the batch lands (a one-frame cold-mount cost vs the old
  // synchronous expansion).
  if (rawExpansion === null) return visiblePages;

  const pageById = indexById(pages);
  const ruleOverrides = overridesByRule(overrideSchedules);
  const allVirtual: VirtualOccurrence[] = [];
  for (const rule of recurrenceRules) {
    const page = pageById.get(rule.pageId);
    if (!page) continue;
    // The batch omits a rule the engine rejects (out-of-envelope) — such a
    // series renders no virtuals; there is no second engine to fall back to.
    const raw = rawExpansion.get(rule.id);
    if (!raw) continue;
    allVirtual.push(...toVirtuals(raw, page, rule, ruleOverrides.get(rule.id) ?? []));
  }

  // A synced override's original slot is already excluded from the virtuals
  // above; render the moved instance at its new slot beside them.
  const overrideBlocks = toOverrideBlocks(recurrenceRules, pageById, overrideSchedules);

  if (allVirtual.length === 0 && overrideBlocks.length === 0) return visiblePages;
  return [...visiblePages, ...allVirtual, ...overrideBlocks];
}
