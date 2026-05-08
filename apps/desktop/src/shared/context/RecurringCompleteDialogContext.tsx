"use client";

// RecurringCompleteDialogContext — the gap-resolution dialog shown when the
// user completes a recurring page that's overdue. If today > head's
// scheduledStart, there are intermediate rrule occurrences that have neither
// been done nor explicitly addressed; the dialog lets the user pick between
// `skip` (advance to today, drop the missed days) and `advance` (advance to
// next page, leave missed days on the calendar). When there's no gap, the
// completion fires immediately with policy=advance and no dialog.
//
// All four call sites (calendar block toggle, calendar popover toggle,
// editor byline toggle, page-list toggle) route through `request(pageId)`
// rather than calling `completeRecurringPage` directly. Centralising the
// gap-detection here keeps callers ignorant of the policy concept.

import type { PageRecurrenceRule, PageSummary } from "@pikos/core";
import { missedOccurrencesBetween, parseLocalISO } from "@pikos/core";
import { startOfDay } from "date-fns";
import { createContext, type ReactNode, useContext, useState } from "react";

import { type MissedOccurrencePolicy, useWorkspace } from "@/shared/context/WorkspaceContext";

interface PendingCompletion {
  pageId: string;
  pageTitle: string;
  /** rrule occurrence dates (YYYY-MM-DD) strictly between head and today, not in exdates. */
  missedDates: string[];
  /** Used by the dialog copy — the next rrule occurrence after the head, regardless of exdates. */
  nextDateLabel: string | null;
}

export interface RecurringCompleteDialogContextValue {
  /**
   * Entry point used by every "mark recurring page complete" caller.
   * Computes the gap; if 0 missed days, completes immediately with
   * policy=advance. Otherwise opens the dialog.
   */
  request: (pageId: string) => void;
  /** Internal dialog state — read by the mounted RecurringCompleteDialog. */
  pending: PendingCompletion | null;
  /** Confirm the dialog with one of the three policies. */
  confirm: (policy: MissedOccurrencePolicy) => void;
  /** Dismiss the dialog without acting. */
  cancel: () => void;
}

const RecurringCompleteDialogContext = createContext<RecurringCompleteDialogContextValue | null>(
  null
);

export function useRecurringCompleteDialog(): RecurringCompleteDialogContextValue {
  const ctx = useContext(RecurringCompleteDialogContext);
  if (!ctx) {
    throw new Error(
      "useRecurringCompleteDialog must be used inside a RecurringCompleteDialogProvider"
    );
  }
  return ctx;
}

function computeMissedDates(rule: PageRecurrenceRule, head: PageSummary | undefined): string[] {
  if (!head?.scheduledStart) return [];
  const headDate = parseLocalISO(head.scheduledStart);
  const todayStart = startOfDay(new Date());
  if (todayStart <= headDate) return [];
  return missedOccurrencesBetween(
    rule.rrule,
    rule.scheduledStart,
    headDate,
    todayStart,
    rule.rruleExdates
  );
}

export function RecurringCompleteDialogProvider({ children }: { children: ReactNode }) {
  const { completeRecurringPage, pages, recurrenceRules } = useWorkspace();
  const [pending, setPending] = useState<PendingCompletion | null>(null);

  function request(pageId: string): void {
    const rule = recurrenceRules.find((r) => r.pageId === pageId);
    if (!rule) {
      // No rule — caller is wrong to use this entry point, but fall through
      // gracefully so we don't drop the user's intent.
      void completeRecurringPage(pageId, "advance");
      return;
    }
    const head = pages.find((p) => p.id === pageId);
    const missedDates = computeMissedDates(rule, head);

    if (missedDates.length === 0) {
      // No gap — dialog isn't useful. Complete immediately with advance.
      void completeRecurringPage(pageId, "advance");
      return;
    }

    // Compute the "next" occurrence label for dialog copy ("Tuesday becomes
    // the next one"). nextDate is the first rrule occurrence strictly after
    // the head, regardless of exdates — that's the date "advance" lands on.
    const nextDateLabel = missedDates[0] ?? null;

    setPending({
      missedDates,
      nextDateLabel,
      pageId,
      pageTitle: head?.title || "Untitled",
    });
  }

  function confirm(policy: MissedOccurrencePolicy): void {
    const target = pending;
    setPending(null);
    if (!target) return;
    void completeRecurringPage(target.pageId, policy);
  }

  function cancel(): void {
    setPending(null);
  }

  const value: RecurringCompleteDialogContextValue = { cancel, confirm, pending, request };

  return (
    <RecurringCompleteDialogContext.Provider value={value}>
      {children}
    </RecurringCompleteDialogContext.Provider>
  );
}
