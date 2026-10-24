import type { PageSummary } from "../types";

/** The actions a page's menu can offer, in the order a menu lists them. */
export type PageActionId =
  | "complete"
  | "send-today"
  | "send-tomorrow"
  | "priority"
  | "next-week"
  | "clear-date"
  | "move-to-folder"
  | "stop-repeating"
  | "rename"
  | "delete";

/**
 * Why an action is withheld. `calendar-owned`: a calendar owns the title, date and
 * placement of its mirror, and the writer refuses all three. `no-date`: there is
 * nothing to clear. `repeats`: a series' date is its rule's, and clearing a page's
 * dates leaves the rule's, so No date would undate the row until the next read;
 * sending it to a day would move the rule's anchor the same way. `not-repeating`:
 * there is no rule to stop. `several-pages`: the menu acts on a selection, and the
 * action names one page.
 *
 * The phone's menu answers the same way; `pageActions.cases.json` holds the answers
 * both are tested against for the actions the Rust core also answers.
 */
export type PageActionRefusal =
  | "calendar-owned"
  | "no-date"
  | "repeats"
  | "not-repeating"
  | "several-pages";

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
 * Delete, completion and priority are offered on every origin: a mirror can be
 * removed locally, and its status and priority are the user's, not the calendar's.
 * Completion names one page because a selection's checkbox and Space flip each page
 * its own way, which one menu label can't say.
 */
export function pageActions(page: PageActionFacts, actsOn = 1): PageAction[] {
  const owned = page.scheduleLocked ? "calendar-owned" : null;
  const several = actsOn > 1 ? "several-pages" : null;
  const sendToDay = owned ?? (page.isRecurring ? "repeats" : null);
  return [
    answer("complete", several),
    answer("send-today", sendToDay),
    answer("send-tomorrow", sendToDay),
    answer("priority", null),
    answer("next-week", sendToDay),
    answer(
      "clear-date",
      owned ?? (page.isRecurring ? "repeats" : page.scheduledStart ? null : "no-date")
    ),
    answer("move-to-folder", owned),
    answer("stop-repeating", owned ?? (page.isRecurring ? several : "not-repeating")),
    answer("rename", owned ?? several),
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
