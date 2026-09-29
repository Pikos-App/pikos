// ─── Moving a recurring series' anchor ───────────────────────────────────────
//
// Dragging (or date-picking) a recurring head is not a plain schedule write: the
// rule's own anchor has to follow, and the drop point has to land on a day the
// rule can actually yield. Both corrections are pure string math over the rule,
// so they live here rather than inside the write that applies them — the write
// then only has to persist what this module resolved.

import type { RecurrenceRuleUpdate } from "../storage";
import type { PageRecurrenceRule } from "../types";
import { alignWeeklyRuleToAnchor, rruleEditWouldDegrade, snapScheduleToRule } from "./recurrence";

/** Where a moved anchor actually lands, plus the rrule that follows it. */
export interface AnchorMove {
  /** The realigned rrule, or undefined when nothing about the rule changed
   *  (non-weekly, multi-day BYDAY, locked rule, or no rule at all). */
  rrule: string | undefined;
  start: string;
  end: string | undefined;
}

/**
 * Resolve where an anchor move lands for `rule` (undefined = non-recurring page,
 * in which case the drop point passes through untouched).
 *
 * Two corrections, in order:
 *
 * 1. Realign a single-BYDAY weekly rule's weekday to the moved anchor — a head
 *    dragged Mon→Wed must make the series "every Wednesday", else completion's
 *    advance snaps back to the BYDAY weekday (the "reverts to its original day"
 *    bug). No-op for daily/monthly/multi-day rules. Skipped for a rule the
 *    editor is locked out of: the realign rebuilds through the same round-trip,
 *    so it would silently drop the terms the lock exists to protect.
 *
 * 2. Snap an off-pattern drop (M/W/F dropped on Tue, monthly-by-day onto the
 *    wrong date) onto the nearest day the rule yields, so a later recompute
 *    can't silently revert it. No-op for single-BYDAY weekly (step 1 already
 *    fixed the day) and for non-recurring pages. Set-excluded dates still
 *    resolve wrong here; only the backend recompute converges those.
 */
export function resolveAnchorMove(
  rule: PageRecurrenceRule | undefined,
  start: string,
  end?: string
): AnchorMove {
  if (!rule) return { end, rrule: undefined, start };
  const aligned = rruleEditWouldDegrade(rule.rrule)
    ? undefined
    : alignWeeklyRuleToAnchor(rule.rrule, start);
  const snapped = snapScheduleToRule(aligned ?? rule.rrule, start, end);
  return { end: snapped.end, rrule: aligned, start: snapped.start };
}

/**
 * The rule as it looks once the anchor move is applied — the optimistic mirror
 * of the head's denorm, including CLEARING the end when the move drops it. An
 * end left behind the new start gives the rule a negative span, which every
 * occurrence derived from it then carries. (`scheduledEnd` is optional, not
 * nullable, so this deletes rather than assigns null.)
 */
export function applyAnchorMove(rule: PageRecurrenceRule, move: AnchorMove): PageRecurrenceRule {
  const next: PageRecurrenceRule = {
    ...rule,
    rrule: move.rrule ?? rule.rrule,
    scheduledStart: move.start,
  };
  if (move.end !== undefined) next.scheduledEnd = move.end;
  else delete next.scheduledEnd;
  return next;
}

/** The persisted form of the same move. `scheduledEnd` goes out as `end ?? null`
 *  — lockstep with the head denorm, clearing included — and the rrule only when
 *  the realign actually changed it, so an unchanged weekly rule isn't rewritten. */
export function anchorMoveUpdate(rule: PageRecurrenceRule, move: AnchorMove): RecurrenceRuleUpdate {
  return {
    scheduledEnd: move.end ?? null,
    scheduledStart: move.start,
    ...(move.rrule && move.rrule !== rule.rrule ? { rrule: move.rrule } : {}),
  };
}
