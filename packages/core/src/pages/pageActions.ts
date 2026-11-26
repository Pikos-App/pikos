import type { PageSummary } from "../types";

/** The actions a page's menu can offer, in the order a menu lists them. */
export type PageActionId = "rename" | "move-to-folder" | "clear-date" | "delete";

/**
 * Why an action is withheld. `calendar-owned`: a calendar owns its mirror's title, date and
 * placement, and the writer refuses all three. `no-date`: nothing to clear. `repeats`: a series'
 * date is its rule's, so clearing the page's dates would undate the row only until the next read.
 * `several-pages`: the menu acts on a selection and the action names one page.
 *
 * The phone's menu answers the same way; `pageActions.cases.json` is what both are tested against.
 */
export type PageActionRefusal = "calendar-owned" | "no-date" | "repeats" | "several-pages";

/** A refused action stays listed, so a surface can explain the gap. */
export type PageAction =
  | { id: PageActionId; offered: true }
  | { id: PageActionId; offered: false; reason: PageActionRefusal };

type PageActionFacts = Pick<PageSummary, "isRecurring" | "scheduleLocked" | "scheduledStart">;

function answer(id: PageActionId, reason: PageActionRefusal | null): PageAction {
  return reason === null ? { id, offered: true } : { id, offered: false, reason };
}

/** Every action, whether it is offered, and why not. What the UI offers, not what the writer
 * permits. Delete is offered on every origin, since a mirror can be removed locally. */
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

/** Whether Delete first asks "this date or all of them". A series asks, since it goes with every
 * date it has left. A calendar's series doesn't (its dates are upstream's), nor does a selection
 * (one question can't name several pages). */
export function deleteAsksWhichDates(page: PageActionFacts, actsOn = 1): boolean {
  return actsOn === 1 && page.isRecurring && !page.scheduleLocked && Boolean(page.scheduledStart);
}
