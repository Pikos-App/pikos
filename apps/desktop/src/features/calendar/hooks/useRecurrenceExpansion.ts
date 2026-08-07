import type {
  PageRecurrenceRule,
  PageSchedule,
  PageSummary,
  RawOccurrence,
  RawRuleExpansion,
  VirtualOccurrence,
} from "@pikos/core";
import { dateKey, formatDateOnly, rawExpandRule } from "@pikos/core";
import { addDays } from "date-fns";
import { useEffect, useRef, useState } from "react";

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
  /** Kill-switch. When false, expand in-process via rrule.js instead of the Rust
   * engine over IPC — the fallback if the IPC path misbehaves on the live grid. */
  useRustEngine?: boolean;
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
  overrideSchedules: PageSchedule[]
): VirtualOccurrence[] {
  const excluded = completedOrSkippedKeys(page);
  for (const s of overrideSchedules) {
    if (s.ruleId === rule.id && s.originalDate) excluded.add(dateKey(s.originalDate));
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
 * zoned schedule. Deliberately not a `VirtualOccurrence` (no `isVirtual`), so it
 * renders the page's synced treatment — checkbox, sync icon, schedule-locked
 * popover — instead of the recurring glyph; it reads as a real, completable
 * event. `originalDate` (day-key) is the *original* occurrence for the
 * completion key and reminder derivation, not the day it moved to. */
type OverrideBlock = PageSummary & { originalDate: string };

/** Shapes each synced override row into a locked, completable block at its moved
 * time. Excludes an override whose original occurrence is already completed or
 * skipped (the done clone renders instead — a rendered override beside it would
 * double the slot). Synced-only: a native reschedule re-homes via a clone +
 * exdate, never an override row (`ruleId` is only set for synced series); the
 * `scheduleLocked` check also skips a detached series that has since unlocked. */
function toOverrideBlocks(
  rules: PageRecurrenceRule[],
  pages: PageSummary[],
  overrideSchedules: PageSchedule[]
): OverrideBlock[] {
  const rulePage = new Map<string, PageSummary>();
  for (const rule of rules) {
    const page = pages.find((p) => p.id === rule.pageId);
    if (page) rulePage.set(rule.id, page);
  }

  const out: OverrideBlock[] = [];
  for (const s of overrideSchedules) {
    if (!s.ruleId || !s.originalDate) continue;
    const page = rulePage.get(s.ruleId);
    if (!page || !page.scheduleLocked) continue;
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
 * the calendar renders both identically. Expansion runs in the Rust engine over
 * IPC (stale-while-revalidate); the completed/skip exclusion union and the head
 * suppression stay synchronous and client-side, so a completion reflects on the
 * next render without waiting for a round-trip. Virtual occurrences carry
 * `isVirtual: true` for downstream identification.
 */
export function useRecurrenceExpansion({
  days,
  expandRecurrenceRange,
  listOverridesForRules,
  pages,
  recurrenceRules,
  useRustEngine = true,
}: UseRecurrenceExpansionParams): (PageSummary | VirtualOccurrence)[] {
  const [overrideSchedules, setOverrideSchedules] = useState<PageSchedule[]>([]);
  const schedulesAbortRef = useRef(0);

  // null until the first IPC batch resolves; a Map (rule id → raw occurrences)
  // after. Kept across a range change (stale-while-revalidate) so an overlapping
  // or day-step nav keeps showing virtuals while the next batch is in flight — a
  // non-overlapping week jump still renders empty for a frame (accepted).
  const [rawExpansion, setRawExpansion] = useState<Map<string, RawOccurrence[]> | null>(null);
  const expandAbortRef = useRef(0);

  const rangeStartDate = days[0];
  const lastDay = days[days.length - 1];
  const rangeEndDate = lastDay ? addDays(lastDay, 1) : null;
  const startStr = rangeStartDate ? formatDateOnly(rangeStartDate) : null;
  const endStr = rangeEndDate ? formatDateOnly(rangeEndDate) : null;
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
        if (prev.length === schedules.length && prev.every((p, i) => p.id === schedules[i]?.id)) {
          return prev;
        }
        return schedules;
      });
    });
  }, [startStr, endStr, rulesKey]);

  useEffect(() => {
    if (!useRustEngine || !startStr || !endStr || ruleCount === 0) return;

    const token = ++expandAbortRef.current;
    void expandRecurrenceRange(recurrenceRules, startStr, endStr).then((result) => {
      if (token !== expandAbortRef.current) return;
      setRawExpansion(new Map(result.map((r) => [r.ruleId, r.occurrences])));
    });
  }, [useRustEngine, startStr, endStr, rulesKey]);

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

  const rangeStart = days[0];
  const lastVisible = days[days.length - 1];
  if (!rangeStart || !lastVisible) return visiblePages;
  const rangeEnd = addDays(lastVisible, 1);

  // IPC mode before the first batch resolves: render pages only for this frame;
  // virtuals appear once the batch lands (a one-frame cold-mount cost vs the old
  // synchronous expansion). The kill-switch computes synchronously below.
  if (useRustEngine && rawExpansion === null) return visiblePages;

  const allVirtual: VirtualOccurrence[] = [];
  for (const rule of recurrenceRules) {
    const page = pages.find((p) => p.id === rule.pageId);
    if (!page) continue;
    // IPC omits a rule the stricter Rust engine can't parse → fall back to
    // rrule.js so an out-of-envelope provider rule still renders. Kill-switch:
    // rrule.js for every rule.
    const ipcRaw = useRustEngine ? rawExpansion?.get(rule.id) : undefined;
    const raw = ipcRaw ?? rawExpandRule(rule, page, rangeStart, rangeEnd);
    allVirtual.push(...toVirtuals(raw, page, rule, overrideSchedules));
  }

  // A synced override's original slot is already excluded from the virtuals
  // above; render the moved instance at its new slot beside them.
  const overrideBlocks = toOverrideBlocks(recurrenceRules, pages, overrideSchedules);

  if (allVirtual.length === 0 && overrideBlocks.length === 0) return visiblePages;
  return [...visiblePages, ...allVirtual, ...overrideBlocks];
}
