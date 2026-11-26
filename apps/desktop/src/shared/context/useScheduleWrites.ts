// The one-off schedule block on a page. Writes run on the page's mutation queue, because a drop
// and a debounced field write for the same page must not interleave.
//
// The same gesture also moves a RECURRING series' anchor, so scheduleOnce resolves the move
// through the rule first (core: resolveAnchorMove), patches page and rule together, then adopts
// the head the backend recompute derives: the local snap cannot see set-excluded dates.

import type { PageRecurrenceRule, PageSummary, StorageAdapter } from "@pikos/core";
import {
  anchorMoveUpdate,
  applyAnchorMove,
  getLocalTimezone,
  resolveAnchorMove,
} from "@pikos/core";
import type { Dispatch, RefObject, SetStateAction } from "react";

import type { OptimisticWrite } from "./usePageWriteQueue";

export interface ScheduleWrites {
  clearSchedule: (pageId: string) => Promise<void>;
  scheduleOnce: (pageId: string, start: string, end?: string) => Promise<void>;
}

export function useScheduleWrites({
  adapter,
  optimistic,
  pagesRef,
  patchRecomputedHead,
  recurrenceRulesRef,
  setPages,
  setRecurrenceRules,
}: {
  adapter: StorageAdapter;
  optimistic: <T>(spec: OptimisticWrite<T>) => Promise<T | undefined>;
  pagesRef: RefObject<PageSummary[]>;
  patchRecomputedHead: (pageId: string, dropCloneId?: string) => Promise<void>;
  recurrenceRulesRef: RefObject<PageRecurrenceRule[]>;
  setPages: Dispatch<SetStateAction<PageSummary[]>>;
  setRecurrenceRules: Dispatch<SetStateAction<PageRecurrenceRule[]>>;
}): ScheduleWrites {
  async function scheduleOnce(pageId: string, start: string, end?: string): Promise<void> {
    const snapshot = pagesRef.current.find((p) => p.id === pageId);
    // Recurring head: capture the rule snapshot so the rule's anchor shifts in lockstep with the
    // head's denorm. Otherwise dragging the head from Mon to Wed leaves rule.scheduledStart at
    // Mon, and the calendar keeps emitting Mon-based virtuals.
    const ruleSnapshot = recurrenceRulesRef.current.find((r) => r.pageId === pageId);
    // Where the drop lands once the rule has had its say (weekly BYDAY realigned, an off-pattern date
    // snapped onto a day the rule yields). Both must settle BEFORE the optimistic update, or the next
    // recompute silently reverts the dragged position.
    const move = resolveAnchorMove(ruleSnapshot, start, end);
    const { end: snappedEnd, start: snappedStart } = move;

    await optimistic({
      apply: () => {
        setPages((prev) =>
          prev.map((p) =>
            p.id === pageId
              ? { ...p, scheduledEnd: snappedEnd ?? null, scheduledStart: snappedStart }
              : p
          )
        );
        if (ruleSnapshot) {
          setRecurrenceRules((prev) =>
            prev.map((r) => (r.id === ruleSnapshot.id ? applyAnchorMove(r, move) : r))
          );
        }
      },
      errorIds: [pageId],
      label: `scheduleOnce(${pageId})`,
      notice: "scheduling this page",
      queueOn: pageId,
      rethrow: true,
      rollback: () => {
        if (snapshot) {
          setPages((prev) => prev.map((p) => (p.id === pageId ? snapshot : p)));
        }
        if (ruleSnapshot) {
          setRecurrenceRules((prev) =>
            prev.map((r) => (r.id === ruleSnapshot.id ? ruleSnapshot : r))
          );
        }
      },
      write: async () => {
        const schedules = await adapter.listPageSchedules(pageId);
        const existing = schedules.find((s) => !s.ruleId);
        if (existing) {
          await adapter.updatePageSchedule(existing.id, {
            scheduledEnd: snappedEnd ?? null,
            scheduledStart: snappedStart,
          });
        } else {
          await adapter.createPageSchedule({
            pageId,
            scheduledStart: snappedStart,
            ...(snappedEnd !== undefined && { scheduledEnd: snappedEnd }),
            timezone: getLocalTimezone(),
          });
        }
        if (ruleSnapshot) {
          await adapter.updateRecurrenceRule(ruleSnapshot.id, anchorMoveUpdate(ruleSnapshot, move));
          // The backend owns the recurring head: adopt its recompute so a drop onto a set-excluded date,
          // which the local snap can't detect, converges to the derived head.
          await patchRecomputedHead(pageId);
        }
      },
    });
  }

  async function clearSchedule(pageId: string): Promise<void> {
    const snapshot = pagesRef.current.find((p) => p.id === pageId);
    await optimistic({
      apply: () =>
        setPages((prev) =>
          prev.map((p) =>
            p.id === pageId ? { ...p, scheduledEnd: null, scheduledStart: null } : p
          )
        ),
      errorIds: [pageId],
      label: `clearSchedule(${pageId})`,
      notice: "clearing this page's date",
      queueOn: pageId,
      rethrow: true,
      rollback: () => {
        if (snapshot) {
          setPages((prev) => prev.map((p) => (p.id === pageId ? snapshot : p)));
        }
      },
      write: async () => {
        const schedules = await adapter.listPageSchedules(pageId);
        const oneOffs = schedules.filter((s) => !s.ruleId);
        await Promise.all(oneOffs.map((s) => adapter.deletePageSchedule(s.id)));
      },
    });
  }

  return { clearSchedule, scheduleOnce };
}
