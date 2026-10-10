// The calendar-sync recording's workspace (e2e/record-calendar-sync.spec.ts): the
// marketing week with no calendar connected, and a CalDAV server whose "Team"
// calendar brings its meetings in when the recording switches it on.

import type { MockStorageAdapter, StorageAdapter } from "@pikos/core";

import { marketingWeek, seedMarketingNative } from "./marketing";

// Each slot is clear of the native week's blocks between 8 AM and 5 PM, the part
// the recording frames — see the schedule map in marketing.ts.
export async function seedMarketingSync(adapter: StorageAdapter): Promise<void> {
  await seedMarketingNative(adapter);
  const { fri, mon, thu, tue, wed } = marketingWeek();
  const zone = "America/Los_Angeles";

  (adapter as MockStorageAdapter).stageCaldavCalendars([
    { displayName: "Personal" },
    {
      // Rose: the pastel setup maps a red or pink server colour to, and no folder here uses it.
      color: "#E8A6A1",
      displayName: "Team",
      events: [
        {
          location: "Room 3",
          scheduledEnd: `${mon}T15:00:00`,
          scheduledStart: `${mon}T14:00:00`,
          timezone: zone,
          title: "Sprint planning",
        },
        {
          location: "Zoom",
          scheduledEnd: `${tue}T12:00:00`,
          scheduledStart: `${tue}T11:00:00`,
          timezone: zone,
          title: "Customer call",
        },
        {
          location: "Zoom",
          scheduledEnd: `${wed}T11:00:00`,
          scheduledStart: `${wed}T10:00:00`,
          timezone: zone,
          title: "Product sync",
        },
        {
          location: "Room 2A",
          scheduledEnd: `${thu}T15:00:00`,
          scheduledStart: `${thu}T14:00:00`,
          timezone: zone,
          title: "Hiring panel",
        },
        {
          scheduledEnd: `${fri}T16:00:00`,
          scheduledStart: `${fri}T15:00:00`,
          timezone: zone,
          title: "Retro",
        },
      ],
    },
  ]);
}
