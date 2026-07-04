import type {
  PageRecurrenceRule,
  PageSchedule,
  PageSummary,
  RawOccurrence,
  RawRuleExpansion,
  VirtualOccurrence,
} from "@pikos/core";
import { formatDateOnly, rawExpandRule } from "@pikos/core";
import { addDays } from "date-fns";
import { useEffect, useRef, useState } from "react";

interface UseRecurrenceExpansionParams {
  pages: PageSummary[];
  recurrenceRules: PageRecurrenceRule[];
  /** The days currently visible in the week grid. */
  days: Date[];
  /** Fetch materialised schedule rows for a date range. */
  listSchedulesRange: (start: string, end: string) => Promise<PageSchedule[]>;
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

/** Applies the client-side exclusion union (completed ∪ skip ∪ materialised
 * overrides) and the own-date head suppression to a rule's raw occurrences,
 * shaping each survivor into a VirtualOccurrence. */
function toVirtuals(
  raw: RawOccurrence[],
  page: PageSummary,
  rule: PageRecurrenceRule,
  rangeSchedules: PageSchedule[]
): VirtualOccurrence[] {
  const excluded = new Set<string>([
    ...Object.keys(page.completedOccurrences ?? {}),
    ...(page.skippedOccurrences ?? []),
    ...rangeSchedules
      .filter((s) => s.ruleId === rule.id && s.originalDate)
      .map((s) => s.originalDate!),
  ]);
  // Only the head's own-date virtual is suppressed (the real head block renders
  // it). Vacated dates need no filter: a head move shifts the rule anchor in
  // lockstep so pre-head dates stop being emitted, and a completion/skip advance
  // lands them in the exclusion union above. A pre-head date that's neither — an
  // open gap after an "advance" — renders, which is correct: the gap stays visible.
  const headDate = page.scheduledStart?.slice(0, 10);
  const out: VirtualOccurrence[] = [];
  for (const occ of raw) {
    if (excluded.has(occ.originalDate)) continue;
    if (headDate && occ.originalDate === headDate) continue;
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
  listSchedulesRange,
  pages,
  recurrenceRules,
  useRustEngine = true,
}: UseRecurrenceExpansionParams): (PageSummary | VirtualOccurrence)[] {
  const [rangeSchedules, setRangeSchedules] = useState<PageSchedule[]>([]);
  const schedulesAbortRef = useRef(0);

  // null until the first IPC batch resolves; a Map (rule id → raw occurrences)
  // after. Kept across a range change (stale-while-revalidate) so an overlapping
  // or day-step nav keeps its virtuals while the next batch is in flight. (A
  // non-overlapping week jump still renders empty for a frame — those dates
  // aren't in the retained map — the accepted cold-mount-class regression.)
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

  useEffect(() => {
    if (!startStr || !endStr || ruleCount === 0) return;

    const token = ++schedulesAbortRef.current;
    void listSchedulesRange(startStr, endStr).then((schedules) => {
      if (token !== schedulesAbortRef.current) return;
      setRangeSchedules((prev) => {
        if (prev.length === schedules.length && prev.every((p, i) => p.id === schedules[i]?.id)) {
          return prev;
        }
        return schedules;
      });
    });
  }, [startStr, endStr, ruleCount]);

  useEffect(() => {
    if (!useRustEngine || !startStr || !endStr || ruleCount === 0) return;

    const token = ++expandAbortRef.current;
    void expandRecurrenceRange(recurrenceRules, startStr, endStr).then((result) => {
      if (token !== expandAbortRef.current) return;
      setRawExpansion(new Map(result.map((r) => [r.ruleId, r.occurrences])));
    });
  }, [useRustEngine, startStr, endStr, rulesKey]);

  // Suppress a recurring head block when its own current date is completed.
  // Normally a no-op: the head advances past a completed occurrence. Load-bearing
  // and permanent for an out-of-envelope provider rule the engine rejects — the
  // recompute skips it, so the head never advances and completing the base can't
  // move it; without this the base renders next to its done clone. Un-gated: such
  // a rule can be native or synced. Computed BEFORE the empty-rules early return
  // so a completed base is hidden even before the rules load.
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
    allVirtual.push(...toVirtuals(raw, page, rule, rangeSchedules));
  }

  if (allVirtual.length === 0) return visiblePages;
  return [...visiblePages, ...allVirtual];
}
