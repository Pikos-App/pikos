// Everything with a time on it: the week ramp and the layout fixtures after it,
// repeating pages in every rule shape with a history, and reminders anchored to
// the moment you plant, which fire over the following minutes.

import type { StorageAdapter } from "@pikos/core";

import { plantCalendarEdges } from "./calendarEdges";
import { plantCalendarWeek } from "./calendarWeek";
import { plantOnce } from "./plant";
import { plantReminders } from "./reminders";
import { plantRoutines } from "./routines";

export async function seedCalendar(adapter: StorageAdapter): Promise<void> {
  await plantOnce(adapter, "Calendar seed marker", async () => {
    await plantCalendarWeek(adapter);
    await plantCalendarEdges(adapter);
    await plantRoutines(adapter);
    await plantReminders(adapter);
  });
}
