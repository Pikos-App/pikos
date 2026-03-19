/**
 * seed-dst.ts — Pages around the US DST spring-forward (Pacific time).
 *
 * US Pacific DST 2026: clocks jump 2:00 AM → 3:00 AM on Sunday, March 8.
 *   Before: PST (UTC-8)   After: PDT (UTC-7)
 *
 * Covers edge cases:
 *   - Pages on the eve (Sat Mar 7, PST)
 *   - Pages in the non-existent 2:00–2:59 AM window
 *   - Pages straddling the gap
 *   - Pages after the transition (Sun Mar 8, PDT)
 *   - First full day on PDT (Mon Mar 9)
 *
 * Usage:
 *   pnpm seed dst [path/to/workspace.sqlite]
 */

import {
  openDb,
  defaultDbPath,
  getOrCreateFolder,
  insertPage,
  insertSchedule,
  alreadySeeded,
  tiptapDoc,
  heading,
  paragraph,
  bulletList,
  taskList,
  nowLocalISO,
} from "./_db.ts";

const MARKER = "⚙️ [seed-dst] PST vs PDT edge cases";
const TIMEZONE = "America/Los_Angeles";

type PageEntry = {
  title: string;
  subtitle: string;
  start: string;
  end: string | null;
  status: "not_started" | "in_progress" | "done";
  priority: 0 | 1 | 2 | 3 | 4;
  tags: string[];
  body?: string;
};

const PAGES: PageEntry[] = [
  // ── Saturday March 7 — normal PST ─────────────────────────────────────────
  {
    title: "Pre-DST planning session",
    subtitle: "Review tasks before clocks change tonight",
    start: "2026-03-07T09:00:00",
    end: "2026-03-07T10:00:00",
    status: "done",
    priority: 2,
    tags: ["dst", "planning"],
  },
  {
    title: "Saturday morning standup",
    subtitle: "Async notes before the long weekend",
    start: "2026-03-07T10:30:00",
    end: "2026-03-07T11:00:00",
    status: "done",
    priority: 3,
    tags: ["standup"],
  },
  {
    title: "Lunch break — check calendar edge cases",
    subtitle: "Verify app handles DST gap gracefully",
    start: "2026-03-07T12:00:00",
    end: "2026-03-07T13:00:00",
    status: "in_progress",
    priority: 0,
    tags: ["dst", "qa"],
  },
  {
    title: "Afternoon deep work",
    subtitle: "Finish GOO-79 Today smart view",
    start: "2026-03-07T14:00:00",
    end: "2026-03-07T16:00:00",
    status: "not_started",
    priority: 1,
    tags: ["focus", "dev"],
  },
  {
    title: "Set reminder to update wall clocks",
    subtitle: "Spring forward tonight — don't be late tomorrow",
    start: "2026-03-07T22:00:00",
    end: "2026-03-07T22:15:00",
    status: "not_started",
    priority: 3,
    tags: ["reminder", "dst"],
  },

  // ── DST transition zone — March 8 around 2 AM ─────────────────────────────
  // 2:00–2:59 AM does not exist (clocks skip to 3:00 AM). Pages below bracket
  // the gap so the calendar UI can be tested with non-existent wall times.
  {
    title: "Just before the DST gap",
    subtitle: "Scheduled at 1:45 AM — last valid moment in PST",
    start: "2026-03-08T01:45:00",
    end: "2026-03-08T02:00:00",
    status: "not_started",
    priority: 2,
    tags: ["dst", "edge-case"],
  },
  {
    title: "⚠ Exactly at 2:00 AM (non-existent wall time)",
    subtitle: "Clocks skip from 2:00 → 3:00; this slot doesn't exist in PST",
    start: "2026-03-08T02:00:00",
    end: "2026-03-08T02:30:00",
    status: "not_started",
    priority: 1,
    tags: ["dst", "gap", "edge-case"],
  },
  {
    title: "⚠ Mid-gap 2:30 AM (non-existent)",
    subtitle: "Another page inside the skipped hour",
    start: "2026-03-08T02:30:00",
    end: "2026-03-08T03:00:00",
    status: "not_started",
    priority: 1,
    tags: ["dst", "gap", "edge-case"],
  },
  {
    title: "Just after the DST gap",
    subtitle: "Clocks now read 3:00 AM PDT — first valid time post-spring",
    start: "2026-03-08T03:00:00",
    end: "2026-03-08T03:30:00",
    status: "not_started",
    priority: 2,
    tags: ["dst", "edge-case"],
  },

  // ── Sunday March 8 — PDT day ──────────────────────────────────────────────
  {
    title: "Sunday morning run",
    subtitle: "Shorter sleep thanks to DST — go anyway",
    start: "2026-03-08T07:00:00",
    end: "2026-03-08T08:00:00",
    status: "not_started",
    priority: 0,
    tags: ["health", "dst"],
  },
  {
    title: "DST day brunch",
    subtitle: "Meet at 10 AM PDT — remember it feels like 9",
    start: "2026-03-08T10:00:00",
    end: "2026-03-08T11:30:00",
    status: "not_started",
    priority: 3,
    tags: ["personal"],
  },
  {
    title: "Verify Pikos calendar render after DST",
    subtitle: "Check all blocks appear at correct wall-clock times in PDT",
    start: "2026-03-08T11:30:00",
    end: "2026-03-08T12:00:00",
    status: "not_started",
    priority: 1,
    tags: ["dst", "qa", "dev"],
  },
  {
    title: "Afternoon sync with east coast team",
    subtitle: "East coast already sprung forward; both on EDT/PDT",
    start: "2026-03-08T14:00:00",
    end: "2026-03-08T15:00:00",
    status: "not_started",
    priority: 2,
    tags: ["meeting"],
  },
  {
    title: "Evening wrap-up",
    subtitle: "First full day on PDT — how did the calendar hold up?",
    start: "2026-03-08T18:00:00",
    end: "2026-03-08T18:30:00",
    status: "not_started",
    priority: 3,
    tags: ["review", "dst"],
  },

  // ── All-day markers ───────────────────────────────────────────────────────
  {
    title: "March 7 — Last full day of PST",
    subtitle: "All-day marker for the day before spring forward",
    start: "2026-03-07",
    end: null,
    status: "done",
    priority: 0,
    tags: ["dst", "marker"],
  },
  {
    title: "March 8 — DST begins (spring forward)",
    subtitle: "Clocks +1h at 2 AM → 3 AM in America/Los_Angeles",
    start: "2026-03-08",
    end: null,
    status: "not_started",
    priority: 0,
    tags: ["dst", "marker"],
  },

  // ── Monday March 9 — first full day on PDT ───────────────────────────────
  {
    title: "Monday standup — first day fully on PDT",
    subtitle: "Confirm recurring meetings didn't drift by an hour",
    start: "2026-03-09T09:00:00",
    end: "2026-03-09T09:30:00",
    status: "not_started",
    priority: 3,
    tags: ["standup", "dst"],
  },
  {
    title: "Post-DST calendar audit",
    subtitle: "Compare scheduled blocks from Sat/Sun/Mon for drift",
    start: "2026-03-09T10:00:00",
    end: "2026-03-09T11:00:00",
    status: "not_started",
    priority: 2,
    tags: ["dst", "qa"],
  },
];

function makeBody(entry: PageEntry): string {
  return tiptapDoc(
    heading(2, entry.title),
    paragraph(entry.subtitle),
    bulletList(
      `Time: ${entry.start}${entry.end ? " → " + entry.end : ""}`,
      `Timezone: ${TIMEZONE}`,
      `Tags: ${entry.tags.join(", ")}`
    )
  );
}

export function run(dbPath: string = defaultDbPath()): void {
  console.log("\nPikos seed — DST / PST vs PDT edge cases");
  console.log(`  Target DB : ${dbPath}\n`);

  const db = openDb(dbPath);

  if (alreadySeeded(db, MARKER)) {
    console.log("  Already seeded (marker page found). Pass --force to re-run.");
    db.close();
    return;
  }

  const folderId = getOrCreateFolder(db, "DST Testing", {
    color: "#f59e0b",
    sortOrder: 99,
  });

  // Marker page (no schedule — just the idempotency guard)
  insertPage(db, {
    folderId,
    title: MARKER,
    subtitle: "Idempotency guard — delete to re-seed",
    content: tiptapDoc(paragraph("DST seed marker — do not rename.")),
    status: "done",
    priority: 0,
    sortOrder: 0,
  });

  PAGES.forEach((entry, i) => {
    const isTimed = entry.start.includes("T");
    const pageId = insertPage(db, {
      folderId,
      title: entry.title,
      subtitle: entry.subtitle,
      content: makeBody(entry),
      contentText: `${entry.subtitle} [${entry.tags.join(", ")}]`,
      status: entry.status,
      priority: entry.priority,
      tags: entry.tags,
      sortOrder: i + 1,
      completedAt: entry.status === "done" ? nowLocalISO() : null,
    });

    insertSchedule(db, {
      pageId,
      scheduledStart: entry.start,
      scheduledEnd: entry.end,
      timezone: isTimed ? TIMEZONE : null,
    });

    console.log(`  [${String(i + 1).padStart(2, "0")}] ${entry.start}  ${entry.title}`);
  });

  db.close();

  console.log(`\n  Done — ${PAGES.length} pages + 1 marker seeded.`);
  console.log(`  Folder   : DST Testing`);
  console.log(`  Timezone : ${TIMEZONE}`);
  console.log(`  Range    : 2026-03-07 (PST) → 2026-03-09 (PDT)`);
  console.log(`\n  ⚠ Gap pages (2:00–2:59 AM Mar 8) test non-existent wall times.`);
}
