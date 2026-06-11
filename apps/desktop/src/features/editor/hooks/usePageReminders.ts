// Extracted from ReminderPopover for testability. Contains all the business
// logic; the popover component is a thin UI shell.

import type { PageReminder, StorageAdapter } from "@pikos/core";
import { useState } from "react";

import type { ReminderLeadTime } from "@/shared/context/AppSettingsContext";

/** Sentinel value: minutes_before = -1 means "no reminders for this page." */
const NONE_SENTINEL = -1;

export function usePageReminders(storage: StorageAdapter | null, pageId: string) {
  const [reminders, setReminders] = useState<PageReminder[]>([]);

  const isNone = reminders.length === 1 && reminders[0]?.minutesBefore === NONE_SENTINEL;
  const activeReminders = reminders.filter((r) => r.minutesBefore !== NONE_SENTINEL);
  const hasCustomReminders = activeReminders.length > 0;

  async function load() {
    if (!storage) return;
    const list = await storage.listPageReminders(pageId);
    setReminders(list);
  }

  async function add(minutes: ReminderLeadTime) {
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
