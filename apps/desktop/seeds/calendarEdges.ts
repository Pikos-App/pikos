// Labeled regression fixtures for calendar layout, deliberately not a
// believable week: each day-cluster exercises one layout behavior, so a visual
// diff or screenshot can target it by its `[FIXTURE]` title.
//
// Anchored at Monday of the current week, which `calendarWeek` fills:
//   Week 2 (M+7…Su+13)  — cross-midnight events (one midnight, stay timed)
//   Week 3 (M+14…Su+20) — multi-midnight timed segments beside true all-day events
//   Week 4 (M+21…Su+27) — containment: adjacent, overlapping, nested, shared edges
//   Week 5 (M+28…Su+34) — density, nesting across folders, column clipping

import type { StorageAdapter } from "@pikos/core";

import { type CalendarFolderKey, calendarFolders, mondayOffset } from "./calendarWeek";
import { doc, p } from "./doc";
import { at, day, plantPage } from "./plant";

export async function plantCalendarEdges(adapter: StorageAdapter): Promise<void> {
  const folderIds = await calendarFolders(adapter);
  const monday = mondayOffset();
  const dayN = (n: number): number => monday + n;

  type TimedSpec = {
    title: string;
    folder?: CalendarFolderKey;
    startDay: number;
    startHour: number;
    startMinute?: number;
    endDay?: number;
    endHour: number;
    endMinute?: number;
  };

  async function addTimed(spec: TimedSpec): Promise<void> {
    await plantPage(adapter, {
      content: doc(p(spec.title), p("Calendar edge-case fixture.")),
      end: at(spec.endDay ?? spec.startDay, spec.endHour, spec.endMinute ?? 0),
      folderId: folderIds[spec.folder ?? "work"],
      start: at(spec.startDay, spec.startHour, spec.startMinute ?? 0),
      tags: ["calendar-fixture"],
      title: spec.title,
    });
  }

  type AllDaySpec = {
    title: string;
    folder?: CalendarFolderKey;
    startDay: number;
    endDay?: number;
  };

  async function addAllDay(spec: AllDaySpec): Promise<void> {
    await plantPage(adapter, {
      content: doc(p(spec.title), p("Calendar edge-case fixture (all-day).")),
      folderId: folderIds[spec.folder ?? "work"],
      start: day(spec.startDay),
      tags: ["calendar-fixture"],
      title: spec.title,
      ...(spec.endDay !== undefined && { end: day(spec.endDay) }),
    });
  }

  // ── Week 2 — Cross-midnight (single midnight, stay in timed grid) ────────
  // Each fixture on its own day-pair so landing portions don't collide.

  // Mon+7 → Tue+8: short spillover (11 PM → 1 AM)
  await addTimed({
    endDay: dayN(8),
    endHour: 1,
    startDay: dayN(7),
    startHour: 23,
    title: "[FIXTURE] Cross-midnight short",
  });

  // Wed+9 → Thu+10: long spillover (6 PM → 6 AM, dominates Thu morning)
  await addTimed({
    endDay: dayN(10),
    endHour: 6,
    startDay: dayN(9),
    startHour: 18,
    title: "[FIXTURE] Cross-midnight long (dominates Thu AM)",
  });

  // Fri+11 → Sat+12: 24-hour single-midnight, two split segments
  await addTimed({
    endDay: dayN(12),
    endHour: 23,
    startDay: dayN(11),
    startHour: 23,
    title: "[FIXTURE] Cross-midnight 24h",
  });

  // Sat+12 → Sun+13: cross-midnight + same-day overlap on origin day
  await addTimed({
    endDay: dayN(13),
    endHour: 2,
    startDay: dayN(12),
    startHour: 22,
    title: "[FIXTURE] Cross-midnight w/ overlap",
  });
  await addTimed({
    endHour: 23,
    endMinute: 30,
    startDay: dayN(12),
    startHour: 23,
    title: "[FIXTURE] Cross-midnight overlap peer",
  });

  // ── Week 3 — Multi-day timed (segments per day) + true all-day ──────────
  // Multi-day timed events render as N+1 segments in the timed grid; only
  // start-time-less events end up in the all-day row.

  // Mon+14 → Wed+16: 2-midnight SHORT (~26 hrs, 3 segments)
  await addTimed({
    endDay: dayN(16),
    endHour: 1,
    startDay: dayN(14),
    startHour: 23,
    title: "[FIXTURE] 2-midnight short (3 segments)",
  });

  // Tue+15 → Thu+17: 2-midnight LONG (48 hrs, 3 segments)
  await addTimed({
    endDay: dayN(17),
    endHour: 10,
    startDay: dayN(15),
    startHour: 10,
    title: "[FIXTURE] 2-midnight long (3 segments)",
  });

  // Mon+14 → Thu+17: 3-midnight (4 segments across Mon–Thu)
  await addTimed({
    endDay: dayN(17),
    endHour: 17,
    startDay: dayN(14),
    startHour: 9,
    title: "[FIXTURE] 3-midnight (4 segments)",
  });

  // Tue+15 → Wed+16: multi-day TRUE all-day, sits in the all-day row alongside
  // the timed segments below it.
  await addAllDay({
    endDay: dayN(16),
    folder: "personal",
    startDay: dayN(15),
    title: "[FIXTURE] All-day Offsite",
  });

  // Fri+18: single-day true all-day
  await addAllDay({
    folder: "personal",
    startDay: dayN(18),
    title: "[FIXTURE] All-day Holiday (single)",
  });

  // Fri+18 → Sun+20: multi-day true all-day
  await addAllDay({
    endDay: dayN(20),
    folder: "family",
    startDay: dayN(18),
    title: "[FIXTURE] All-day Weekend trip",
  });

  // Sat+19 → Sun+20: overlapping multi-day all-day (overlaps Weekend trip)
  await addAllDay({
    endDay: dayN(20),
    folder: "work",
    startDay: dayN(19),
    title: "[FIXTURE] All-day Conference (overlaps Trip)",
  });

  // ── Week 4 — Containment ────────────────────────────────────────────────────
  // One fixture cluster per day, all in afternoon for easy scan.

  // Mon+21: Adjacent peers — touching boundary, no overlap. Must NOT nest.
  await addTimed({
    endHour: 14,
    endMinute: 30,
    startDay: dayN(21),
    startHour: 13,
    title: "[FIXTURE] Adjacent A (1:00–2:30)",
  });
  await addTimed({
    endHour: 15,
    endMinute: 30,
    startDay: dayN(21),
    startHour: 14,
    startMinute: 30,
    title: "[FIXTURE] Adjacent B (2:30–3:30)",
  });

  // Tue+22: Overlap-not-contained — B extends past A. Must NOT nest.
  await addTimed({
    endHour: 15,
    startDay: dayN(22),
    startHour: 13,
    title: "[FIXTURE] Overlap-not-contained A (1–3)",
  });
  await addTimed({
    endHour: 16,
    startDay: dayN(22),
    startHour: 14,
    startMinute: 30,
    title: "[FIXTURE] Overlap-not-contained B (2:30–4)",
  });

  // Wed+23 and Thu+24: a child covering 75% and 62.5% of its parent's length.
  await addTimed({
    endHour: 15,
    startDay: dayN(23),
    startHour: 13,
    title: "[FIXTURE] Marginal-75 parent (1–3, 120m)",
  });
  await addTimed({
    endHour: 14,
    endMinute: 45,
    startDay: dayN(23),
    startHour: 13,
    startMinute: 15,
    title: "[FIXTURE] Marginal-75 child (1:15–2:45, 90m, ratio=75%)",
  });

  await addTimed({
    endHour: 15,
    startDay: dayN(24),
    startHour: 13,
    title: "[FIXTURE] Just-below parent (1–3, 120m)",
  });
  await addTimed({
    endHour: 14,
    endMinute: 30,
    startDay: dayN(24),
    startHour: 13,
    startMinute: 15,
    title: "[FIXTURE] Just-below child (1:15–2:30, 75m, ratio=62.5%)",
  });

  // Fri+25: Clear containment — small child well inside large parent.
  await addTimed({
    endHour: 16,
    startDay: dayN(25),
    startHour: 13,
    title: "[FIXTURE] Clear-contain parent (1–4)",
  });
  await addTimed({
    endHour: 14,
    endMinute: 30,
    startDay: dayN(25),
    startHour: 14,
    title: "[FIXTURE] Clear-contain child (2–2:30)",
  });

  // Sat+26: same-start/different-end (morning) + same-end/different-start (afternoon).
  // Exercises strict-inequality rule on shared boundaries.
  await addTimed({
    endHour: 12,
    startDay: dayN(26),
    startHour: 10,
    title: "[FIXTURE] Same-start parent (10–12)",
  });
  await addTimed({
    endHour: 11,
    startDay: dayN(26),
    startHour: 10,
    title: "[FIXTURE] Same-start child (10–11)",
  });
  await addTimed({
    endHour: 15,
    startDay: dayN(26),
    startHour: 13,
    title: "[FIXTURE] Same-end parent (1–3)",
  });
  await addTimed({
    endHour: 15,
    startDay: dayN(26),
    startHour: 14,
    title: "[FIXTURE] Same-end child (2–3)",
  });

  // Sun+27: 3-deep nesting (morning) + false-cascade regression (afternoon).
  await addTimed({
    endHour: 12,
    startDay: dayN(27),
    startHour: 9,
    title: "[FIXTURE] 3-deep A (9–12)",
  });
  await addTimed({
    endHour: 11,
    endMinute: 45,
    startDay: dayN(27),
    startHour: 9,
    startMinute: 15,
    title: "[FIXTURE] 3-deep B (9:15–11:45)",
  });
  await addTimed({
    endHour: 11,
    startDay: dayN(27),
    startHour: 9,
    startMinute: 30,
    title: "[FIXTURE] 3-deep C (9:30–11)",
  });
  // False-cascade regression: 3 adjacent peers must render as 3 columns,
  // NOT a nested chain. Each touches the next at the boundary, no overlap.
  await addTimed({
    endHour: 14,
    startDay: dayN(27),
    startHour: 13,
    title: "[FIXTURE] False-cascade 1 (1–2)",
  });
  await addTimed({
    endHour: 15,
    startDay: dayN(27),
    startHour: 14,
    title: "[FIXTURE] False-cascade 2 (2–3)",
  });
  await addTimed({
    endHour: 16,
    startDay: dayN(27),
    startHour: 15,
    title: "[FIXTURE] False-cascade 3 (3–4)",
  });

  // ── Week 5 — Density, nesting across folders, column clipping ───────────────

  // Mon+28: Mild density — 4 overlapping peers in 1-hr window.
  // Same duration, staggered start → all peers (none contains another).
  // Should render at compact width (titles only, no time label).
  for (let i = 0; i < 4; i++) {
    const startMin = i * 10;
    const endMin = startMin + 30;
    await addTimed({
      endHour: 13 + Math.floor(endMin / 60),
      endMinute: endMin % 60,
      startDay: dayN(28),
      startHour: 13,
      startMinute: startMin,
      title: `[FIXTURE] Mild-density ${i + 1} of 4`,
    });
  }

  // Tue+29: Severe density — 8 overlapping peers in 2-hr window.
  // Last 3–4 should collapse into "+N more" pill.
  for (let i = 0; i < 8; i++) {
    const startMin = i * 15;
    const endMin = startMin + 30;
    await addTimed({
      endHour: 13 + Math.floor(endMin / 60),
      endMinute: endMin % 60,
      startDay: dayN(29),
      startHour: 13 + Math.floor(startMin / 60),
      startMinute: startMin % 60,
      title: `[FIXTURE] Severe-density ${i + 1} of 8`,
    });
  }

  // Wed+30: Dense + nested mix — 1 parent containing 5 overlapping children.
  // Verify nesting still works under width pressure.
  await addTimed({
    endHour: 16,
    startDay: dayN(30),
    startHour: 13,
    title: "[FIXTURE] Dense-nest parent (1–4)",
  });
  for (let i = 0; i < 5; i++) {
    const startMin = 15 + i * 15;
    const endMin = startMin + 30;
    await addTimed({
      endHour: 13 + Math.floor(endMin / 60),
      endMinute: endMin % 60,
      startDay: dayN(30),
      startHour: 13 + Math.floor(startMin / 60),
      startMinute: startMin % 60,
      title: `[FIXTURE] Dense-nest child ${i + 1} of 5`,
    });
  }

  // Thu+31 to Sun+34 morning: nests whose levels share or differ in folder
  // color, so adjacent levels of one colour stay distinguishable.
  await addTimed({
    endHour: 16,
    folder: "work",
    startDay: dayN(31),
    startHour: 13,
    title: "[FIXTURE] Same-folder parent (work, 1–4)",
  });
  await addTimed({
    endHour: 15,
    folder: "work",
    startDay: dayN(31),
    startHour: 13,
    startMinute: 30,
    title: "[FIXTURE] Same-folder child (work, 1:30–3)",
  });

  await addTimed({
    endHour: 16,
    folder: "work",
    startDay: dayN(32),
    startHour: 13,
    title: "[FIXTURE] Diff-folder parent (work, 1–4)",
  });
  await addTimed({
    endHour: 15,
    folder: "personal",
    startDay: dayN(32),
    startHour: 13,
    startMinute: 30,
    title: "[FIXTURE] Diff-folder child (personal, 1:30–3)",
  });

  await addTimed({
    endHour: 16,
    folder: "work",
    startDay: dayN(33),
    startHour: 13,
    title: "[FIXTURE] 3-deep grandparent (work, 1–4)",
  });
  await addTimed({
    endHour: 15,
    endMinute: 45,
    folder: "personal",
    startDay: dayN(33),
    startHour: 13,
    startMinute: 15,
    title: "[FIXTURE] 3-deep middle (personal, 1:15–3:45)",
  });
  await addTimed({
    endHour: 15,
    folder: "health",
    startDay: dayN(33),
    startHour: 13,
    startMinute: 30,
    title: "[FIXTURE] 3-deep innermost (health, 1:30–3)",
  });

  await addTimed({
    endHour: 12,
    folder: "work",
    startDay: dayN(34),
    startHour: 9,
    title: "[FIXTURE] Same-as-parent grandparent (work, 9–12)",
  });
  await addTimed({
    endHour: 11,
    endMinute: 45,
    folder: "personal",
    startDay: dayN(34),
    startHour: 9,
    startMinute: 15,
    title: "[FIXTURE] Same-as-parent middle (personal, 9:15–11:45)",
  });
  await addTimed({
    endHour: 11,
    folder: "personal",
    startDay: dayN(34),
    startHour: 9,
    startMinute: 30,
    title: "[FIXTURE] Same-as-parent innermost (personal, 9:30–11)",
  });

  // Sun+34 afternoon: column clipping stress. 6 identical 2-hr peers in the
  // same window. Width pressure could otherwise bleed past the column edge —
  // verify nothing renders outside its day boundary.
  for (let i = 0; i < 6; i++) {
    await addTimed({
      endHour: 15,
      startDay: dayN(34),
      startHour: 13,
      title: `[FIXTURE] Clipping ${i + 1} of 6 (1–3)`,
    });
  }
}
