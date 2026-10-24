import type { PageSummary } from "@pikos/core";
import { getLocalTimezone, localToday, snapAnchorToRule } from "@pikos/core";

import { usePages } from "@/shared/context/PagesContext";

/** A page's tag and repeat writes, made the same way from its byline and from a list row. */
export function usePageMetadataWrites() {
  const {
    createRecurrence,
    deleteRecurrence,
    recurrenceRules,
    scheduleOnce,
    updatePage,
    updateRecurrence,
  } = usePages();

  function toggleTag(page: PageSummary, name: string) {
    const next = page.tags.includes(name)
      ? page.tags.filter((t) => t !== name)
      : [...page.tags, name];
    updatePage(page.id, { tags: next });
  }

  async function changeRecurrence(page: PageSummary, rrule: string | null) {
    const existing = recurrenceRules.find((r) => r.pageId === page.id);
    if (!rrule) {
      if (existing) await deleteRecurrence(existing.id);
      return;
    }
    if (existing) {
      await updateRecurrence(existing.id, { rrule });
      // A new BYDAY can exclude the head's weekday; snapping it (and the rule's anchor, through
      // scheduleOnce) keeps a stray first run off the old day.
      const snapped = snapAnchorToRule(rrule, existing.scheduledStart);
      if (snapped !== existing.scheduledStart) {
        await scheduleOnce(page.id, snapped, page.scheduledEnd ?? undefined);
      }
      return;
    }
    // Undated pages anchor to today. Awaited before the rule is made, so a failed scheduleOnce
    // can't leave a rule anchored on a date the head doesn't carry.
    const anchorStart = snapAnchorToRule(rrule, page.scheduledStart ?? localToday());
    if (anchorStart !== page.scheduledStart) {
      await scheduleOnce(page.id, anchorStart, page.scheduledEnd ?? undefined);
    }
    const tz = getLocalTimezone();
    await createRecurrence({
      pageId: page.id,
      rrule,
      scheduledStart: anchorStart,
      ...(page.scheduledEnd ? { scheduledEnd: page.scheduledEnd } : {}),
      timezone: tz,
    });
  }

  return { changeRecurrence, toggleTag };
}
