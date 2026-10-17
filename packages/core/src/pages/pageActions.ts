import type { PageSummary } from "../types";

/** The actions a page's menu can offer, in the order a menu lists them. */
export type PageActionId = "rename" | "move-to-folder" | "clear-date" | "delete";

/**
 * Why an action is withheld. `calendar-owned`: a calendar owns the title, date and
 * placement of its mirror, and the writer refuses all three. `no-date`: there is
 * nothing to clear. `repeats`: a series' date is its rule's, and clearing a page's
 * dates leaves the rule's, so No date would undate the row until the next read.
 * `several-pages`: the menu acts on a selection, and the action names one page.
 *
 * The phone's menu answers the same way; `pageActions.cases.json` holds the answers
 * both are tested against.
 */
export type PageActionRefusal = "calendar-owned" | "no-date" | "repeats" | "several-pages";

/** A refused action stays in the list, so a surface can explain a gap instead of dropping it. */
export type PageAction =
  | { id: PageActionId; offered: true }
  | { id: PageActionId; offered: false; reason: PageActionRefusal };

type PageActionFacts = Pick<PageSummary, "isRecurring" | "scheduleLocked" | "scheduledStart">;

function answer(id: PageActionId, reason: PageActionRefusal | null): PageAction {
  return reason === null ? { id, offered: true } : { id, offered: false, reason };
}

/**
 * Every page action, whether it is offered and, where it is not, why. What the UI
 * offers, not what the writer permits: the writer stays the enforcement point.
 * Delete is offered on every origin, since a mirror can be removed locally.
 */
export function pageActions(page: PageActionFacts, actsOn = 1): PageAction[] {
  const owned = page.scheduleLocked ? "calendar-owned" : null;
  return [
    answer("rename", owned ?? (actsOn > 1 ? "several-pages" : null)),
    answer("move-to-folder", owned),
    answer(
      "clear-date",
      owned ?? (page.isRecurring ? "repeats" : page.scheduledStart ? null : "no-date")
    ),
    answer("delete", null),
  ];
}

/**
 * Whether Delete asks "this date or all of them" first. A series goes with every
 * date it has left, so it asks. A calendar's series doesn't: its dates are
 * upstream's. A selection doesn't either: one question can't name several pages.
 */
export function deleteAsksWhichDates(page: PageActionFacts, actsOn = 1): boolean {
  return actsOn === 1 && page.isRecurring && !page.scheduleLocked && Boolean(page.scheduledStart);
}
