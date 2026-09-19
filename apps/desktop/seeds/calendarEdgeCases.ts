// Calendar edge-case seed — targeted regression fixtures for the calendar
// refinement pass. Unlike the realistic Mon→Sun ramp in `calendar.ts` /
// `calendarColors.ts`, this seed is NOT meant to look like a believable week.
// It's a labeled testbed: each day-cluster exercises one specific layout
// behavior so visual diffs and screenshot tests can target it directly.
//
// Layout (anchored at Monday of the current week):
//   Week 1 (M+0…Su+6) — INTENTIONALLY EMPTY. The realistic baseline lives in
//                       the `calendar` and `calendar-colors` seeds.
//   Week 2 (M+7…Su+13)  — Cross-midnight events (single midnight, stay timed)
//   Week 3 (M+14…Su+20) — Multi-midnight timed segments + true all-day events
//   Week 4 (M+21…Su+27) — Containment edge cases (sections 5/6)
//   Week 5 (M+28…Su+34) — Density + multi-folder color muting + clipping
//
// Every event title is prefixed `[FIXTURE]` for easy grep / screenshot
// targeting. Folder assignment defaults to `work`; the multi-folder muting
// fixtures in week 5 deliberately use distinct folders to verify color
// decisions per nesting level.

import type { StorageAdapter } from "@pikos/core";
import { addDays, format, startOfWeek } from "date-fns";

const MARKER = "Calendar edge cases seed marker";

async function alreadySeeded(adapter: StorageAdapter): Promise<boolean> {
  const { results } = await adapter.searchPages(MARKER);
  return results.some((r) => r.title.includes(MARKER));
}

type FolderKey = "work" | "personal" | "health" | "family" | "errands";

const FOLDER_NAMES: Record<FolderKey, string> = {
  errands: "Errands",
  family: "Family",
  health: "Health",
  personal: "Personal",
  work: "Work",
};

const FOLDER_COLORS: Record<FolderKey, string> = {
  errands: "#f59e0b",
  family: "#10b981",
  health: "#8b5cf6",
  personal: "#3b82f6",
  work: "#ef4444",
};

export async function seedCalendarEdgeCases(adapter: StorageAdapter): Promise<void> {
  if (await alreadySeeded(adapter)) return;

  const monday = startOfWeek(new Date(), { weekStartsOn: 1 });

  function dayN(n: number): Date {
    return addDays(monday, n);
  }

  function dateStr(d: Date): string {
    return format(d, "yyyy-MM-dd");
  }

  function timed(d: Date, hour: number, minute = 0): string {
    return `${dateStr(d)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  }

  const folderIds = {} as Record<FolderKey, string>;
  for (const key of Object.keys(FOLDER_NAMES) as FolderKey[]) {
    const folder = await adapter.createFolder({
      color: FOLDER_COLORS[key],
      name: FOLDER_NAMES[key],
      parentId: null,
    });
    folderIds[key] = folder.id;
  }

  await adapter.createPage({
    content: doc(
      p("Calendar edge cases seed marker."),
      p("Targeted regression fixtures for calendar layout. Layout by week:"),
      bullets(
        "Week 1 (current Mon–Sun) — empty. Realistic baseline lives in `calendar` / `calendar-colors` seeds.",
        "Week 2 — cross-midnight events (single midnight, stay timed)",
        "Week 3 — multi-midnight timed segments + true all-day (intentionally co-located)",
        "Week 4 — containment edge cases (adjacent / overlap / marginal / nested)",
        "Week 5 — density + multi-folder color muting + column clipping"
      ),
      p("Every event title is prefixed [FIXTURE] for grep / screenshot targeting."),
      p("Delete this marker page to re-seed.")
    ),
    folderId: folderIds.work,
    priority: 0,
    status: "done",
    subtitle: "Delete this page to re-seed",
    tags: [],
    title: MARKER,
  });

  type TimedSpec = {
    title: string;
    folder?: FolderKey;
    startDay: Date;
    startHour: number;
    startMinute?: number;
    endDay?: Date;
    endHour: number;
    endMinute?: number;
  };

  async function addTimed(spec: TimedSpec): Promise<void> {
    const folder = spec.folder ?? "work";
    const start = timed(spec.startDay, spec.startHour, spec.startMinute ?? 0);
    const end = timed(spec.endDay ?? spec.startDay, spec.endHour, spec.endMinute ?? 0);
    const page = await adapter.createPage({
      content: doc(p(spec.title), p("Calendar edge-case fixture.")),
      folderId: folderIds[folder],
      priority: 0,
      status: "not_started",
      subtitle: null,
      tags: ["calendar-fixture"],
      title: spec.title,
    });
    await adapter.createPageSchedule({
      pageId: page.id,
      scheduledEnd: end,
      scheduledStart: start,
      timezone: "America/Los_Angeles",
    });
  }

  type AllDaySpec = {
    title: string;
    folder?: FolderKey;
    startDay: Date;
    endDay?: Date;
  };

  async function addAllDay(spec: AllDaySpec): Promise<void> {
    const folder = spec.folder ?? "work";
    const page = await adapter.createPage({
      content: doc(p(spec.title), p("Calendar edge-case fixture (all-day).")),
      folderId: folderIds[folder],
      priority: 0,
      status: "not_started",
      subtitle: null,
      tags: ["calendar-fixture"],
      title: spec.title,
    });
    // All-day = date-only ISO string (no 'T'). Timezone omitted.
    const baseInput: { pageId: string; scheduledStart: string; scheduledEnd?: string } = {
      pageId: page.id,
      scheduledStart: dateStr(spec.startDay),
    };
    if (spec.endDay) baseInput.scheduledEnd = dateStr(spec.endDay);
    await adapter.createPageSchedule(baseInput);
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

  // ── Week 4 — Containment edge cases (sections 5/6) ───────────────────────
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

  // Wed+23: Marginal at 75% threshold.
  // A=1–3PM (120m), B=1:15–2:45PM (90m). Ratio = 90/120 = 75%.
  // Chosen behavior: 75% is the threshold — equal-to threshold is ambiguous.
  // Document whatever buildDayBlocks decides here as the canonical answer.
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

  // Thu+24: Just below threshold — 62.5%, should nest.
  // A=1–3PM (120m), B=1:15–2:30PM (75m). Ratio = 75/120 = 62.5%.
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
  // 3-deep: A=180m, B=150m (83% of A → nests), C=90m (60% of B → nests).
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

  // ── Week 5 — Density + multi-folder color muting + column clipping ───────

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

  // Thu+31: Same-folder nest (parent + child both `work`).
  // Child should render with full fill (NO muting).
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

  // Fri+32: Different-folder nest. Parent=work, child=personal.
  // Child should render MUTED with personal-color left border.
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

  // Sat+33: 3-deep mixed-folder. Each level's muting decision is based on
  // its DIRECT containment parent, not the root.
  //   work (grandparent) → personal (middle) → health (innermost)
  // Both inner levels should be muted (each differs from its direct parent).
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

  // Sun+34 morning: same-folder nest INSIDE different-folder parent.
  //   work (GP) → personal (P) → personal (C)
  // Innermost matches its DIRECT parent (personal), so it must NOT be muted.
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
    title: "[FIXTURE] Same-as-parent innermost (personal, 9:30–11, NOT muted)",
  });

  // Sun+34 afternoon: column clipping stress. 6 identical 2-hr peers in the
  // same window. Width pressure could otherwise bleed past the column edge —
  // verify nothing renders outside its day boundary.
  // (Note: the realistic dense-day regression fixture is W1 Sun in `calendar.ts`
  // — keep that as the canonical "real life dense" shape.)
  for (let i = 0; i < 6; i++) {
    await addTimed({
      endHour: 15,
      startDay: dayN(34),
      startHour: 13,
      title: `[FIXTURE] Clipping ${i + 1} of 6 (1–3)`,
    });
  }
}

// ── Tiptap JSON helpers ──────────────────────────────────────────────────────

type Node = Record<string, unknown>;

function doc(...nodes: Node[]): string {
  return JSON.stringify({ content: nodes, type: "doc" });
}

function p(text: string): Node {
  return { content: [{ text, type: "text" }], type: "paragraph" };
}

function bullets(...items: string[]): Node {
  return {
    content: items.map((text) => ({
      content: [p(text)],
      type: "listItem",
    })),
    type: "bulletList",
  };
}
