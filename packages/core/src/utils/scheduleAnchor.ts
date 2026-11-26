// Moving a recurring head is not a plain schedule write: the rule's own anchor has to follow, and
// the drop point has to land on a day the rule can yield. Both corrections are pure string math,
// so the write only persists what this module resolved.

import type { RecurrenceRuleUpdate } from "../storage";
import type { PageRecurrenceRule } from "../types";
import { alignWeeklyRuleToAnchor, rruleEditWouldDegrade, snapScheduleToRule } from "./recurrence";

/** Where a moved anchor lands, plus the rrule that follows it. */
export interface AnchorMove {
  /** Undefined when the rule is unchanged: non-weekly, multi-day BYDAY, locked, or absent. */
  rrule: string | undefined;
  start: string;
  end: string | undefined;
}

/**
 * Where an anchor move lands for `rule` (undefined for a non-recurring page, where the drop point
 * passes through). Two corrections, in order:
 *
 * 1. Realign a single-BYDAY weekly rule's weekday to the moved anchor. A head dragged Mon to Wed
 *    must make the series "every Wednesday", or completion's advance snaps back to the BYDAY
 *    weekday. Skipped for a rule the editor is locked out of: the realign rebuilds through the
 *    same round-trip and would drop the terms the lock protects.
 * 2. Snap an off-pattern drop (M/W/F dropped on Tue) onto the nearest day the rule yields, so a
 *    later recompute can't revert it. Dates excluded by sets still resolve wrong here; only the
 *    backend recompute converges those.
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

/** The rule once the move is applied, clearing the end when the move drops it: an end left behind
 * the new start gives every derived occurrence a negative span. `scheduledEnd` is optional, not
 * nullable, so this deletes rather than assigns null. */
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

/** The persisted form of the same move: `scheduledEnd` as `end ?? null`, and the rrule only when
 *  the realign changed it, so an unchanged weekly rule isn't rewritten. */
export function anchorMoveUpdate(rule: PageRecurrenceRule, move: AnchorMove): RecurrenceRuleUpdate {
  return {
    scheduledEnd: move.end ?? null,
    scheduledStart: move.start,
    ...(move.rrule && move.rrule !== rule.rrule ? { rrule: move.rrule } : {}),
  };
}
