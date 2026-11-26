import type {
  PageRecurrenceRule,
  PageSchedule,
  PageSummary,
  RawOccurrence,
  RawRuleExpansion,
  VirtualOccurrence,
} from "@pikos/core";
import { dateKey, formatDateOnly, warmBlockInstants } from "@pikos/core";
import { addDays } from "date-fns";
import { useEffect, useState, useSyncExternalStore } from "react";

type ExpandRange = (
  rules: PageRecurrenceRule[],
  rangeStart: string,
  rangeEnd: string
) => Promise<RawRuleExpansion[]>;

type ListOverrides = (ruleIds: string[]) => Promise<PageSchedule[]>;

interface ExpansionLoadParams {
  recurrenceRules: PageRecurrenceRule[];
  days: Date[];
  /** Keyed by rule, not range, so an override moved out of the visible week still excludes its original slot. */
  listOverridesForRules: ListOverrides;
  /** Batched raw expansion via the Rust engine: rule EXDATEs applied, completed/skip union not. */
  expandRecurrenceRange: ExpandRange;
  /** Refetch trigger for an override row that moved in place, which leaves the range and rule set identical. */
  overridesVersion?: number;
  margin?: number;
  /** Outlives the component, so a remount draws the occurrences it last showed in its first frame. */
  hold?: ExpansionHold | null;
}

interface UseRecurrenceExpansionParams extends ExpansionLoadParams {
  pages: PageSummary[];
}

interface HeldExpansion {
  byRule: Map<string, RawOccurrence[]>;
  end: string;
  rulesKey: string;
  start: string;
}

const holds = (held: HeldExpansion | null, rulesKey: string, start: string, end: string) =>
  held !== null && held.rulesKey === rulesKey && held.start <= start && held.end >= end;

/** The engine places an occurrence in a range by its start; local ISO strings order as their instants do. */
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

const scheduleIdentity = (s: PageSchedule): string =>
  `${s.id}:${s.ruleId ?? ""}:${s.originalDate ?? ""}:${s.scheduledStart}:${s.scheduledEnd ?? ""}`;

const NO_SCHEDULES: PageSchedule[] = [];

class LatestRequest {
  private inFlight: string | null = null;
  private token = 0;

  run<T>(key: string, start: () => Promise<T>, land: (result: T) => void): void {
    if (this.inFlight === key) return;

    this.inFlight = key;
    const token = ++this.token;
    void start()
      .then((result) => {
        if (token === this.token) land(result);
      })
      .finally(() => {
        if (token === this.token) this.inFlight = null;
      });
  }
}

/**
 * The expansion and override rows a surface holds, kept outside React state: a refill of the
 * margin re-renders nothing unless the occurrences on screen changed, where a state update would
 * re-render a whole week to show the same blocks.
 *
 * Each fetch is skipped while the same one is in flight and dropped when a newer one supersedes
 * it, across every caller.
 */
export class ExpansionHold {
  private held: HeldExpansion | null = null;
  private last: Map<string, RawOccurrence[]> | null = null;
  private listeners = new Set<() => void>();
  private schedules = NO_SCHEDULES;
  private expanding = new LatestRequest();
  private listing = new LatestRequest();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  holds(rulesKey: string, start: string, end: string): boolean {
    return holds(this.held, rulesKey, start, end);
  }

  window = (): Map<string, RawOccurrence[]> | null => this.held?.byRule ?? null;

  overrides = (): PageSchedule[] => this.schedules;

  set(held: HeldExpansion): void {
    this.held = held;
    this.notify();
  }

  setOverrides(schedules: PageSchedule[]): void {
    const prev = this.schedules;
    const unchanged =
      prev.length === schedules.length &&
      prev.every((p, i) => scheduleIdentity(p) === scheduleIdentity(schedules[i]!));
    if (unchanged) return;

    this.schedules = schedules;
    this.notify();
  }

  expand(
    run: ExpandRange,
    rules: PageRecurrenceRule[],
    rulesKey: string,
    start: string,
    end: string
  ): void {
    this.expanding.run(
      `${rulesKey}|${start}|${end}`,
      () => run(rules, start, end),
      (result) =>
        this.set({
          byRule: new Map(result.map((r) => [r.ruleId, r.occurrences])),
          end,
          rulesKey,
          start,
        })
    );
  }

  loadOverrides(run: ListOverrides, ruleIds: string[], key: string): void {
    this.listing.run(
      key,
      () => run(ruleIds),
      (schedules) => this.setOverrides(schedules)
    );
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

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

/** Each series' occurrences as built, by head object: an occurrence keeps its object while its head
 *  and times do, so a re-render reuses the layout already parsed for it. */
const builtOccurrences = new WeakMap<PageSummary, Map<string, VirtualOccurrence>>();
const KEPT_PER_HEAD = 400;
/** Delay before neighbours are prepared where idle callbacks don't exist: past the frame being
 *  waited on, well inside the time it takes to reach for the next step. */
const IDLE_FALLBACK_MS = 100;

function whenIdle(work: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(work, { timeout: 1000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(work, IDLE_FALLBACK_MS);
  return () => clearTimeout(id);
}

/** A synced timed entry is stored as full wall-clock, so it must be day-keyed to match the
 * day-only occurrence key (see dateKey). */
function completedOrSkippedKeys(page: PageSummary): Set<string> {
  return new Set(
    [...Object.keys(page.completedOccurrences ?? {}), ...(page.skippedOccurrences ?? [])].map(
      dateKey
    )
  );
}

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

/** Applies the exclusion union (completed, skip, materialised overrides), the own-date head
 * suppression, and a synced series' render floor to a rule's raw occurrences.
 *
 * The floor is the only bound on how far back expansion reaches: the range alone would paint a
 * synced series into any past week. See `PageSummary.syncedSince`. */
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
  // Only the head's own date is suppressed. A head move shifts the rule anchor so vacated dates stop
  // being emitted, and completion/skip lands in the exclusion union, so any other date is a
  // genuine open gap and stays visible.
  const headDate = page.scheduledStart?.slice(0, 10);
  let built = builtOccurrences.get(page);
  if (!built || built.size > KEPT_PER_HEAD) {
    built = new Map();
    builtOccurrences.set(page, built);
  }
  const out: VirtualOccurrence[] = [];
  for (const occ of raw) {
    if (excluded.has(occ.originalDate)) continue;
    if (headDate && occ.originalDate === headDate) continue;
    if (page.syncedSince && occ.originalDate < page.syncedSince) continue;
    const key = `${rule.id}|${occ.originalDate}|${occ.scheduledStart}|${occ.scheduledEnd ?? ""}`;
    let virtual = built.get(key);
    if (!virtual) {
      virtual = {
        ...page,
        isVirtual: true,
        originalDate: occ.originalDate,
        ruleId: rule.id,
        scheduledEnd: occ.scheduledEnd,
        scheduledStart: occ.scheduledStart,
      };
      built.set(key, virtual);
    }
    out.push(virtual);
  }
  return out;
}

/** Deliberately not a `VirtualOccurrence` (no `isVirtual`), so it renders the page's own
 * treatment instead of the recurring glyph. `originalDate` (day-key) is the *original*
 * occurrence for the completion key and reminder derivation, not the day it moved to. */
type OverrideBlock = PageSummary & { originalDate: string };

/** Locked while actively synced, unlocked once detached, since a detached series is the user's.
 *
 * Gated on sync *origin*, not lock state: only a synced series has override rows (a native
 * reschedule re-homes via a clone + exdate), and `scheduleLocked` is `sync_state = 'active'`
 * alone, so gating on it would drop a detached series' moved instance entirely while `toVirtuals`
 * still suppresses its original slot.
 *
 * Excludes an override whose original occurrence is completed or skipped: the done clone renders
 * instead, and an override beside it would double the slot. */
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

function useExpansionLoads(
  {
    days,
    expandRecurrenceRange,
    listOverridesForRules,
    margin = 0,
    overridesVersion = 0,
    recurrenceRules,
  }: ExpansionLoadParams,
  expansion: ExpansionHold | null
) {
  const rangeStartDate = days[0];
  const lastDay = days[days.length - 1];
  const rangeEndDate = lastDay ? addDays(lastDay, 1) : null;
  const startStr = rangeStartDate ? formatDateOnly(rangeStartDate) : null;
  const endStr = rangeEndDate ? formatDateOnly(rangeEndDate) : null;
  const fetchStart = rangeStartDate ? formatDateOnly(addDays(rangeStartDate, -margin)) : null;
  const fetchEnd = rangeEndDate ? formatDateOnly(addDays(rangeEndDate, margin)) : null;
  const ruleCount = recurrenceRules.length;
  // Stable key over the fields that change a rule's raw expansion, so a rule edit refires the IPC
  // effect but unrelated page changes don't.
  const rulesKey = recurrenceRules
    .map(
      (r) =>
        `${r.id}:${r.rrule}:${r.scheduledStart}:${r.scheduledEnd ?? ""}:${r.rruleExdates.join(",")}`
    )
    .join("|");

  // Fetch depends only on the rule set; range stays in the deps as a cheap refetch-on-nav safety
  // net for an override changed out-of-band.
  useEffect(() => {
    if (!expansion || !startStr || !endStr || ruleCount === 0) return;

    expansion.loadOverrides(
      listOverridesForRules,
      recurrenceRules.map((r) => r.id),
      `${rulesKey}|${overridesVersion}`
    );
  }, [startStr, endStr, rulesKey, overridesVersion]);

  useEffect(() => {
    if (!expansion || !fetchStart || !fetchEnd || ruleCount === 0) return;
    if (margin > 0 && expansion.holds(rulesKey, fetchStart, fetchEnd)) return;

    expansion.expand(expandRecurrenceRange, recurrenceRules, rulesKey, fetchStart, fetchEnd);
  }, [startStr, endStr, rulesKey]);

  return { endStr, rulesKey, startStr };
}

export function usePreloadRecurrenceExpansion(params: ExpansionLoadParams): void {
  useExpansionLoads(params, params.hold ?? null);
}

/**
 * Returns pages merged with virtual rrule occurrences for the visible range. The exclusion union
 * and head suppression stay synchronous and client-side, so a completion shows on the next
 * render without a round-trip. Virtual occurrences carry `isVirtual: true`.
 */
export function useRecurrenceExpansion(
  params: UseRecurrenceExpansionParams
): (PageSummary | VirtualOccurrence)[] {
  const { days, hold, margin = 0, pages, recurrenceRules } = params;

  // Kept across a range change so a day-step nav keeps showing virtuals while the next batch is in
  // flight; a jump past the margin renders without them for a frame.
  const [ownHold] = useState(() => new ExpansionHold());
  const expansion = hold ?? ownHold;
  const { endStr, rulesKey, startStr } = useExpansionLoads(params, expansion);

  const rawExpansion = useSyncExternalStore(expansion.subscribe, () =>
    startStr && endStr ? expansion.read(rulesKey, startStr, endStr) : null
  );
  const heldWindow = useSyncExternalStore(expansion.subscribe, expansion.window);
  const overrideSchedules = useSyncExternalStore(expansion.subscribe, expansion.overrides);

  useEffect(() => {
    if (margin === 0 || !heldWindow) return;
    return whenIdle(() => {
      const byId = indexById(pages);
      const overrides = overridesByRule(overrideSchedules);
      for (const rule of recurrenceRules) {
        const page = byId.get(rule.pageId);
        const raw = heldWindow.get(rule.id);
        if (page && raw)
          warmBlockInstants(toVirtuals(raw, page, rule, overrides.get(rule.id) ?? []));
      }
    });
  }, [heldWindow, pages]);

  // The head only stays on a completed or skipped date when nothing after it is open (a series
  // ticked to its end, or a rule the recompute can't advance); drawn, it would sit beside its done
  // clone. Computed before the empty-rules early return so it's hidden before rules load.
  const headSpent = (p: PageSummary): boolean => {
    const baseDate = p.scheduledStart?.slice(0, 10);
    return !!(baseDate && completedOrSkippedKeys(p).has(baseDate));
  };
  const visiblePages = pages.some(headSpent) ? pages.filter((p) => !headSpent(p)) : pages;

  if (recurrenceRules.length === 0) return visiblePages;

  if (!days[0] || !days[days.length - 1]) return visiblePages;

  if (rawExpansion === null) return visiblePages;

  const pageById = indexById(pages);
  const ruleOverrides = overridesByRule(overrideSchedules);
  const allVirtual: VirtualOccurrence[] = [];
  for (const rule of recurrenceRules) {
    const page = pageById.get(rule.pageId);
    if (!page) continue;
    // The batch omits a rule the engine rejects: that series renders no virtuals, and there is no
    // second engine to fall back to.
    const raw = rawExpansion.get(rule.id);
    if (!raw) continue;
    allVirtual.push(...toVirtuals(raw, page, rule, ruleOverrides.get(rule.id) ?? []));
  }

  const overrideBlocks = toOverrideBlocks(recurrenceRules, pageById, overrideSchedules);

  if (allVirtual.length === 0 && overrideBlocks.length === 0) return visiblePages;
  return [...visiblePages, ...allVirtual, ...overrideBlocks];
}
