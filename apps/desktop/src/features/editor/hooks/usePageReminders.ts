// Extracted from ReminderPopover for testability. Contains all the business
// logic; the popover component is a thin UI shell.

import type { PageReminder, StorageAdapter } from "@pikos/core";
import { useState } from "react";

import type { ReminderLeadTime } from "@/shared/context/AppSettingsContext";

/** Sentinel value: minutes_before = -1 means "no reminders for this page." */
const NONE_SENTINEL = -1;

/** Sentinel value: minutes_before = -2 means "the day before, at 09:00 local"
 *  (`pikos_db::DAY_BEFORE_MINUTES`). An all-day page has no start time to count
 *  minutes back from, so its reminder is an anchor rather than a lead — stored
 *  in the same column so an all-day reminder is still one ordinary reminder row. */
export const DAY_BEFORE_SENTINEL = -2;

/** What a per-page reminder can be set to: a lead time, or the all-day anchor. */
export type PageReminderChoice = ReminderLeadTime | typeof DAY_BEFORE_SENTINEL;

export function usePageReminders(storage: StorageAdapter | null, pageId: string) {
  const [reminders, setReminders] = useState<PageReminder[]>([]);

  const isNone = reminders.length === 1 && reminders[0]?.minutesBefore === NONE_SENTINEL;
  // The day-before anchor is a real, active reminder — only the "none" sentinel
  // means the page has none.
  const activeReminders = reminders.filter((r) => r.minutesBefore !== NONE_SENTINEL);
  const hasCustomReminders = activeReminders.length > 0;

  async function load() {
    if (!storage) return;
    const list = await storage.listPageReminders(pageId);
    setReminders(list);
  }

  async function add(minutes: PageReminderChoice) {
    if (!storage) return;
    if (activeReminders.some((r) => r.minutesBefore === minutes)) return;
    if (isNone) {
      await storage.deletePageReminders(pageId);
    }
    const created = await storage.createPageReminder({ minutesBefore: minutes, pageId });
    setReminders((prev) =>
      [...prev.filter((r) => r.minutesBefore !== NONE_SENTINEL), created].sort(
        (a, b) => a.minutesBefore - b.minutesBefore
      )
    );
  }

  async function remove(id: string) {
    if (!storage) return;
    await storage.deletePageReminder(id);
    setReminders((prev) => prev.filter((r) => r.id !== id));
  }

  async function setNone() {
    if (!storage) return;
    await storage.deletePageReminders(pageId);
    const sentinel = await storage.createPageReminder({
      minutesBefore: NONE_SENTINEL,
      pageId,
    });
    setReminders([sentinel]);
  }

  async function resetToDefault() {
    if (!storage) return;
    await storage.deletePageReminders(pageId);
    setReminders([]);
  }

  return {
    activeReminders,
    add,
    hasCustomReminders,
    isNone,
    load,
    reminders,
    remove,
    resetToDefault,
    setNone,
  };
}
