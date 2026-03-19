/**
 * seed-realistic.ts — A believable day-to-day life scenario.
 *
 * Populates the workspace with the kind of data a real Pikos user would
 * accumulate after a few weeks: work projects, personal tasks, health goals,
 * reading notes, recurring meetings, and some completed history.
 *
 * Designed to test:
 *   - Mixed status/priority spread in page lists
 *   - Today view with overdue + upcoming items
 *   - Calendar density at realistic levels (not overwhelming)
 *   - Folder structure that mirrors real use-cases
 *   - Tags appearing across multiple folders
 *
 * Usage:
 *   pnpm seed realistic [path/to/workspace.sqlite]
 */

import { faker } from "@faker-js/faker";
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

const MARKER = "⚙️ [seed-realistic] Realistic life marker";

// "Today" from the script's point of view — seeds relative dates
const TODAY = new Date("2026-03-12");

function daysFromToday(n: number): Date {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + n);
  return d;
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function timedStr(d: Date, hour: number, minute = 0): string {
  const out = new Date(d);
  out.setHours(hour, minute, 0, 0);
  // Return local wall-clock (no Z suffix — Pikos stores wall time)
  return `${dateStr(out)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

type Status = "not_started" | "in_progress" | "done";
type Priority = 0 | 1 | 2 | 3 | 4;

interface PageSpec {
  folder: string;
  title: string;
  subtitle?: string;
  body: string;
  status: Status;
  priority: Priority;
  tags: string[];
  start?: string;
  end?: string;
  durationMins?: number;
}

// ── Content builders ──────────────────────────────────────────────────────────

function meetingNotes(title: string, attendees: string[], items: string[]): string {
  return tiptapDoc(
    heading(2, title),
    paragraph(`Attendees: ${attendees.join(", ")}`),
    heading(3, "Agenda"),
    bulletList(...items),
    heading(3, "Action items"),
    taskList(
      { text: `Follow up with ${attendees[0]} on blockers`, checked: false },
      { text: "Update project board", checked: false },
      { text: "Send recap email", checked: true }
    )
  );
}

function projectNote(title: string, description: string, tasks: string[]): string {
  return tiptapDoc(
    heading(2, title),
    paragraph(description),
    heading(3, "Tasks"),
    taskList(...tasks.map((t, i) => ({ text: t, checked: i < 2 }))),
    heading(3, "Notes"),
    paragraph(faker.lorem.paragraph())
  );
}

function journalEntry(date: Date, mood: string, body: string): string {
  return tiptapDoc(
    heading(2, `${dateStr(date)} — ${mood}`),
    paragraph(body),
    heading(3, "Gratitude"),
    bulletList(
      faker.lorem.sentence({ min: 4, max: 10 }),
      faker.lorem.sentence({ min: 4, max: 10 }),
      faker.lorem.sentence({ min: 4, max: 10 })
    )
  );
}

function readingNote(book: string, author: string, quote: string): string {
  return tiptapDoc(
    heading(2, book),
    paragraph(`by ${author}`),
    heading(3, "Highlight"),
    paragraph(`"${quote}"`),
    heading(3, "My takeaway"),
    paragraph(faker.lorem.paragraph())
  );
}

function healthLog(activity: string, duration: string, notes: string): string {
  return tiptapDoc(
    heading(2, activity),
    bulletList(`Duration: ${duration}`, `Date: ${dateStr(TODAY)}`, `Notes: ${notes}`)
  );
}

// ── Page catalogue ────────────────────────────────────────────────────────────

const PAGES: PageSpec[] = [
  // ── Work — current sprint ──────────────────────────────────────────────────
  {
    folder: "Work",
    title: "Q1 product roadmap review",
    subtitle: "Align with leadership on March milestones before EOQ",
    body: meetingNotes(
      "Q1 Roadmap Review",
      ["Sarah", "Marcus", "Priya"],
      ["Review shipped features vs plan", "Reprioritize backlog for March", "Set Q2 themes"]
    ),
    status: "done",
    priority: 2,
    tags: ["planning", "meeting"],
    start: timedStr(daysFromToday(-5), 10),
    end: timedStr(daysFromToday(-5), 11),
    durationMins: 60,
  },
  {
    folder: "Work",
    title: "Ship GOO-104 bubble menu",
    subtitle: "Bold, italic, code, link buttons in editor selection popover",
    body: projectNote(
      "Bubble menu implementation",
      "Selection-based formatting toolbar using TipTap's BubbleMenu extension.",
      [
        "Install @tiptap/extension-bubble-menu",
        "Build BubbleMenu component with shadcn buttons",
        "Wire bold / italic / code / link actions",
        "Keyboard shortcut passthrough test",
        "Accessibility: aria-label every button",
      ]
    ),
    status: "done",
    priority: 1,
    tags: ["dev", "editor"],
  },
  {
    folder: "Work",
    title: "Fix calendar timezone offset on DST week",
    subtitle: "Blocks shift 1 hour after DST; root cause in rrule expansion",
    body: tiptapDoc(
      heading(2, "Bug report"),
      paragraph(
        "After March 8 DST transition, blocks seeded before the transition display 1h late. " +
          "rrule.js expands using the system TZ offset at expansion time rather than the stored wall-clock."
      ),
      heading(3, "Investigation notes"),
      bulletList(
        "Reproduced with seed-dst.ts data",
        "PageSchedule.timezone = 'America/Los_Angeles' — correct",
        "rrule.js dtstart must include TZ-aware Date object, not naive ISO string"
      ),
      heading(3, "Fix"),
      paragraph(
        "Pass `{ tzid: 'America/Los_Angeles' }` as RRule options. Use luxon for wall-clock expansion."
      )
    ),
    status: "in_progress",
    priority: 1,
    tags: ["bug", "calendar", "dev"],
    start: timedStr(daysFromToday(0), 14),
    end: timedStr(daysFromToday(0), 16),
  },
  {
    folder: "Work",
    title: "Write release notes for v0.1.1",
    subtitle: "Changelog covering last 3 sprints",
    body: tiptapDoc(
      heading(2, "v0.1.1 Release notes"),
      heading(3, "What's new"),
      bulletList(
        "Today smart view (GOO-79)",
        "Sidebar collapse (GOO-80)",
        "Calendar drag-to-create (GOO-76)",
        "Subtitle field on pages (GOO-77)",
        "Focus timer built-in (GOO-78)"
      ),
      heading(3, "Bug fixes"),
      bulletList(
        "Folder sort order persisted after reorder",
        "Page list empty state shown correctly in Inbox",
        "Tag filter now case-insensitive"
      )
    ),
    status: "not_started",
    priority: 2,
    tags: ["writing", "release"],
    start: timedStr(daysFromToday(1), 9),
    end: timedStr(daysFromToday(1), 10, 30),
  },
  {
    folder: "Work",
    title: "Design review — metadata header GOO-32",
    subtitle: "Collapsible row with status, priority, date, tags, subtitle",
    body: meetingNotes(
      "Design review: metadata header",
      ["Alex", "Jordan"],
      [
        "Collapsed state: show only title",
        "Expanded state: status, priority, date, tags, subtitle",
        "Cmd+Shift+M toggle",
        "Animation: CSS grid-template-rows 0→1fr",
      ]
    ),
    status: "not_started",
    priority: 3,
    tags: ["design", "meeting"],
    start: timedStr(daysFromToday(2), 13),
    end: timedStr(daysFromToday(2), 14),
  },
  {
    folder: "Work",
    title: "Weekly standup notes",
    subtitle: "Progress, blockers, next steps",
    body: meetingNotes(
      "Weekly standup",
      ["Alex", "Sarah", "Marcus", "Priya", "Jordan"],
      [
        "Alex: shipped GOO-104, working on GOO-106/107",
        "Sarah: design tokens finalised",
        "Marcus: CI pipeline green",
        "Priya: user interviews scheduled",
        "Jordan: pricing page draft",
      ]
    ),
    status: "done",
    priority: 0,
    tags: ["standup", "meeting"],
    start: timedStr(daysFromToday(-1), 9),
    end: timedStr(daysFromToday(-1), 9, 30),
  },
  {
    folder: "Work",
    title: "Spike: iCloud sync architecture",
    subtitle: "Research NSUbiquitousKeyValueStore vs CloudKit for Phase 4a",
    body: tiptapDoc(
      heading(2, "iCloud sync options"),
      heading(3, "NSUbiquitousKeyValueStore"),
      paragraph("Max 1 MB per app. Not viable for workspace DBs."),
      heading(3, "CloudKit (public/private DB)"),
      paragraph(
        "Can store arbitrary binary assets. Requires CloudKit entitlement. Complex conflict resolution."
      ),
      heading(3, "iCloud Drive file sync"),
      paragraph(
        "Put the .sqlite file in ~/Library/Mobile Documents/com.pikos.app/. " +
          "iCloud Drive syncs automatically. Watch for concurrent writes from multiple devices."
      ),
      heading(3, "Recommendation"),
      paragraph(
        "iCloud Drive + WAL mode + file-level locking. Simplest path; revisit at Phase 4a kickoff."
      )
    ),
    status: "not_started",
    priority: 4,
    tags: ["research", "sync", "dev"],
  },

  // ── Projects ───────────────────────────────────────────────────────────────
  {
    folder: "Projects",
    title: "Home renovation — kitchen",
    subtitle: "Replace countertops, repaint cabinets, new backsplash tile",
    body: projectNote("Kitchen renovation", "Budget: $4,500. Target completion: end of April.", [
      "Get 3 contractor quotes by March 20",
      "Order countertop samples",
      "Pick paint color (Sherwin-Williams Alabaster?)",
      "Source backsplash tile — 40 sq ft needed",
      "Schedule demo weekend",
      "Buy new cabinet hardware",
    ]),
    status: "in_progress",
    priority: 2,
    tags: ["home", "project"],
  },
  {
    folder: "Projects",
    title: "Side project: recipe manager app",
    subtitle: "Simple local-first recipe organiser — for family, no account needed",
    body: projectNote(
      "Recipe manager",
      "Scratch that itch. Built with Tauri + React (same stack as Pikos). SQLite backend.",
      [
        "Spec: import from URL (structured data scraping)",
        "Spec: tag + filter recipes",
        "Spec: shopping list from recipe ingredients",
        "Bootstrap Tauri project",
        "Design data model",
        "Prototype ingredient parser",
      ]
    ),
    status: "not_started",
    priority: 4,
    tags: ["project", "dev", "idea"],
  },
  {
    folder: "Projects",
    title: "Research: standing desk setup",
    subtitle: "Find a motorized frame under $600 that fits the alcove",
    body: tiptapDoc(
      heading(2, "Standing desk research"),
      heading(3, "Requirements"),
      bulletList(
        "Motorized lift (sit/stand memory positions)",
        "Width: 55–65 in",
        "Max depth: 28 in (alcove constraint)",
        "Budget: under $600 for frame only"
      ),
      heading(3, "Candidates"),
      bulletList(
        "FlexiSpot E7 — $379, solid reviews, 70 in max",
        "Uplift V2 — $599, best warranty, 80 in max",
        "IKEA Bekant — $479, no memory, borderline"
      ),
      heading(3, "Decision"),
      paragraph("Leaning FlexiSpot E7. Order before April 1 to catch sale.")
    ),
    status: "in_progress",
    priority: 3,
    tags: ["research", "home"],
  },

  // ── Personal ──────────────────────────────────────────────────────────────
  {
    folder: "Personal",
    title: "Morning run — 5k",
    subtitle: "Easy pace. Focus on cadence over speed.",
    body: healthLog(
      "5k morning run",
      "34 min",
      "Felt sluggish first 2k, settled in after. Knees ok."
    ),
    status: "done",
    priority: 0,
    tags: ["health", "run"],
    start: timedStr(daysFromToday(-1), 6, 30),
    end: timedStr(daysFromToday(-1), 7, 10),
    durationMins: 40,
  },
  {
    folder: "Personal",
    title: "Gym — upper body",
    subtitle: "Bench, overhead press, rows, curls",
    body: healthLog("Upper body lift", "50 min", "Bench: 3x8 @ 155 lb. New PR on OHP: 95 lb."),
    status: "not_started",
    priority: 0,
    tags: ["health", "gym"],
    start: timedStr(daysFromToday(1), 7),
    end: timedStr(daysFromToday(1), 8),
    durationMins: 60,
  },
  {
    folder: "Personal",
    title: "Call mom — Sunday",
    subtitle: "Weekly check-in",
    body: tiptapDoc(
      paragraph("Topics to cover:"),
      bulletList("Ask about dad's appointment", "Update on kitchen reno", "Plan Easter visit")
    ),
    status: "not_started",
    priority: 3,
    tags: ["personal", "family"],
    start: timedStr(daysFromToday(4), 11),
    end: timedStr(daysFromToday(4), 11, 45),
  },
  {
    folder: "Personal",
    title: "Journal — March 12",
    subtitle: "Mid-week reflection",
    body: journalEntry(
      TODAY,
      "Focused / calm",
      "Good morning session. Stayed off Twitter until noon. Finished the DST bug investigation faster than expected."
    ),
    status: "done",
    priority: 0,
    tags: ["journal"],
  },
  {
    folder: "Personal",
    title: "Dentist appointment",
    subtitle: "Routine cleaning + X-rays",
    body: tiptapDoc(
      paragraph("Dr. Kapur — 123 Main St, Suite 4B"),
      bulletList("Insurance: Blue Cross", "Bring ID", "Arrive 10 min early for paperwork")
    ),
    status: "not_started",
    priority: 3,
    tags: ["health", "appointment"],
    start: timedStr(daysFromToday(7), 10, 30),
    end: timedStr(daysFromToday(7), 11, 30),
    durationMins: 60,
  },

  // ── Reading ───────────────────────────────────────────────────────────────
  {
    folder: "Reading",
    title: "Four Thousand Weeks — Oliver Burkeman",
    subtitle: "Finite time, finite energy — stop optimising, start choosing",
    body: readingNote(
      "Four Thousand Weeks",
      "Oliver Burkeman",
      "The problem with the efficiency trap is that when you become more efficient at doing things, you don't actually get more done — you just get assigned more to do."
    ),
    status: "in_progress",
    priority: 4,
    tags: ["reading", "productivity"],
  },
  {
    folder: "Reading",
    title: "Thinking in Systems — Donella Meadows",
    subtitle: "Systems thinking primer — feedback loops, stocks, flows",
    body: readingNote(
      "Thinking in Systems",
      "Donella Meadows",
      "You think that because you understand 'one' that you must therefore understand 'two' because one and one make two. But you forget that you must also understand 'and'."
    ),
    status: "done",
    priority: 4,
    tags: ["reading", "systems"],
  },
  {
    folder: "Reading",
    title: "Article: Local-first software — Ink & Switch",
    subtitle: "Seven ideals for local-first apps — foundational read for Pikos",
    body: tiptapDoc(
      heading(2, "Local-first software — Ink & Switch"),
      heading(3, "Seven ideals"),
      bulletList(
        "1. Fast — no round trips for your own data",
        "2. Multi-device — seamless across all your devices",
        "3. Offline — full functionality without a network",
        "4. Collaboration — real-time when online",
        "5. Longevity — data outlives the app",
        "6. Privacy — user owns data, no surveillance",
        "7. User control — you choose when to sync"
      ),
      heading(3, "Relevance to Pikos"),
      paragraph(
        "Pikos hits ideals 1, 3, 5, 6, 7 from day one. " +
          "Ideal 2 requires Phase 4 iCloud sync. " +
          "Ideal 4 is deferred — single-user app for now."
      )
    ),
    status: "done",
    priority: 3,
    tags: ["reading", "architecture", "reference"],
  },

  // ── Inbox (no folder) ─────────────────────────────────────────────────────
  {
    folder: "__INBOX__",
    title: "Email Dan about invoice",
    subtitle: "Invoice #2024-03-001 overdue by 2 weeks",
    body: tiptapDoc(
      paragraph(
        "Subject: Re: Invoice #2024-03-001 — could you confirm receipt and ETA for payment?"
      )
    ),
    status: "not_started",
    priority: 1,
    tags: ["finance"],
  },
  {
    folder: "__INBOX__",
    title: "Buy birthday gift for Alex",
    subtitle: "Birthday March 20 — looking at Lamy Safari fountain pen",
    body: tiptapDoc(
      bulletList(
        "Lamy Safari Fine nib — $30 on JetPens",
        "Ink: Diamine Oxblood or Sailor Jentle",
        "Wrap + card"
      )
    ),
    status: "not_started",
    priority: 2,
    tags: ["personal", "shopping"],
  },
  {
    folder: "__INBOX__",
    title: "Rename PKOS repo to pikos",
    subtitle: "Align repo name with product name — update CI, docs, README",
    body: tiptapDoc(
      heading(3, "Steps"),
      taskList(
        { text: "Rename GitHub repo", checked: false },
        { text: "Update tauri.conf.json identifier", checked: false },
        { text: "Update CLAUDE.md references", checked: false },
        { text: "Update README badge URLs", checked: false },
        { text: "Redirect old URL (GitHub does this automatically)", checked: false }
      )
    ),
    status: "not_started",
    priority: 4,
    tags: ["dev", "housekeeping"],
  },
];

export function run(dbPath: string = defaultDbPath()): void {
  console.log("\nPikos seed — realistic life scenario");
  console.log(`  Target DB : ${dbPath}\n`);

  const db = openDb(dbPath);

  if (alreadySeeded(db, MARKER)) {
    console.log("  Already seeded (marker page found). Pass --force to re-run.");
    db.close();
    return;
  }

  faker.seed(7);

  // Build folder map
  const folderMap = new Map<string, string | null>();
  folderMap.set("__INBOX__", null);

  const folderDefs: Array<{ key: string; color: string; sortOrder: number }> = [
    { key: "Work", color: "#3b82f6", sortOrder: 0 },
    { key: "Projects", color: "#8b5cf6", sortOrder: 1 },
    { key: "Personal", color: "#10b981", sortOrder: 2 },
    { key: "Reading", color: "#f59e0b", sortOrder: 3 },
  ];

  for (const { key, color, sortOrder } of folderDefs) {
    const id = getOrCreateFolder(db, key, { color, sortOrder });
    folderMap.set(key, id);
  }

  // Marker
  insertPage(db, {
    folderId: folderMap.get("Work")!,
    title: MARKER,
    subtitle: "Delete this page to re-seed",
    content: tiptapDoc(paragraph("Realistic seed marker.")),
    status: "done",
    priority: 0,
    sortOrder: 0,
  });

  // Folder-level sort counters
  const sortCounters = new Map<string | null, number>();
  const getSortOrder = (fid: string | null): number => {
    const n = sortCounters.get(fid) ?? 1;
    sortCounters.set(fid, n + 1);
    return n;
  };

  let total = 0;
  for (const spec of PAGES) {
    const folderId = folderMap.get(spec.folder) ?? null;
    const pageId = insertPage(db, {
      folderId,
      title: spec.title,
      subtitle: spec.subtitle,
      content: spec.body,
      contentText: [spec.title, spec.subtitle, spec.tags.join(" ")].filter(Boolean).join(" "),
      status: spec.status,
      priority: spec.priority,
      tags: spec.tags,
      sortOrder: getSortOrder(folderId),
      completedAt: spec.status === "done" ? nowLocalISO() : null,
      durationMins: spec.durationMins ?? null,
    });

    if (spec.start) {
      insertSchedule(db, {
        pageId,
        scheduledStart: spec.start,
        scheduledEnd: spec.end ?? null,
        timezone: spec.start.includes("T") ? "America/Los_Angeles" : null,
      });
    }

    console.log(`  ${spec.folder.padEnd(18)} ${spec.status.padEnd(14)} ${spec.title}`);
    total++;
  }

  db.close();

  console.log(`\n  Done — ${total} pages seeded.`);
  console.log(`  Folders: Work · Projects · Personal · Reading`);
  console.log(`  Inbox  : 3 pages`);
}
