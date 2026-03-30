/**
 * seed-demo-marketing.ts — Generic, relatable demo data for marketing recordings.
 *
 * Goals:
 *   - No names, no technical jargon — an average person doing everyday things
 *   - Content is plain paragraphs and bullet lists — no task checklists in note bodies
 *   - Calendar has a satisfying mix of scheduled blocks
 *   - Folder names are simple and universal
 *
 * Usage:
 *   pnpm seed demo-marketing [path/to/workspace.sqlite]
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
  nowLocalISO,
} from "./_db.ts";

const MARKER = "⚙️ [seed-demo-marketing] Marketing demo data marker";

const TODAY = new Date("2026-03-16"); // Monday — must match RECORDING_DATE in record-hero.spec.ts

function d(offsetDays: number, hour?: number, minute = 0): string {
  const dt = new Date(TODAY);
  dt.setDate(dt.getDate() + offsetDays);
  if (hour === undefined) return dt.toISOString().slice(0, 10);
  return `${dt.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

type Status = "not_started" | "in_progress" | "done";
type Priority = 0 | 1 | 2 | 3 | 4;

interface Page {
  folder: string;
  title: string;
  subtitle?: string;
  content: string;
  status: Status;
  priority: Priority;
  tags: string[];
  start?: string;
  end?: string;
}

// ── Folders ───────────────────────────────────────────────────────────────────

const FOLDERS: Record<string, { color: string; sortOrder: number }> = {
  Home: { color: "#10b981", sortOrder: 0 },
  Work: { color: "#6366f1", sortOrder: 1 },
  Health: { color: "#ec4899", sortOrder: 2 },
  Ideas: { color: "#f59e0b", sortOrder: 3 },
};

// ── Pages ──────────────────────────────────────────────────────────────────────

const PAGES: Page[] = [
  // ── 🏠 Home ────────────────────────────────────────────────────────────────

  {
    folder: "Home",
    title: "Grocery list for the week",
    subtitle: "Restock basics plus a few things for the weekend",
    content: tiptapDoc(
      heading(2, "Grocery list"),
      bulletList(
        "Eggs, milk, bread",
        "Chicken thighs, ground turkey",
        "Spinach, bell peppers, onions",
        "Rice, pasta, canned tomatoes",
        "Bananas, apples, frozen berries",
        "Olive oil, soy sauce",
        "Paper towels, dish soap"
      )
    ),
    status: "not_started",
    priority: 3,
    tags: ["errands"],
  },
  {
    folder: "Home",
    title: "Plan weekend trip",
    subtitle: "A short getaway — somewhere within a few hours",
    content: tiptapDoc(
      heading(2, "Weekend trip ideas"),
      paragraph(
        "Looking for somewhere relaxing, not too far. Maybe a cabin by the lake or a small town with good food and walking trails."
      ),
      heading(3, "Options"),
      bulletList(
        "Lake house rental — quiet, good for reading",
        "Coastal town — seafood, beach walks",
        "Mountain cabin — hiking, campfire"
      ),
      heading(3, "To figure out"),
      bulletList(
        "Budget — keep it under $300 total",
        "Check pet-friendly options",
        "Pack rain jacket just in case"
      )
    ),
    status: "in_progress",
    priority: 2,
    tags: ["travel"],
  },
  {
    folder: "Home",
    title: "Budget review — March",
    subtitle: "Check spending against the monthly plan",
    content: tiptapDoc(
      heading(2, "March budget check-in"),
      paragraph(
        "Halfway through the month. Groceries are on track but eating out has been higher than planned. Need to watch that for the second half."
      ),
      heading(3, "Categories to review"),
      bulletList(
        "Groceries — on budget",
        "Dining out — over by about $60",
        "Subscriptions — cancel the ones not being used",
        "Gas — slightly under",
        "Fun / entertainment — on track"
      )
    ),
    status: "not_started",
    priority: 2,
    tags: ["finance"],
    start: d(1, 14),
    end: d(1, 14, 45),
  },
  {
    folder: "Home",
    title: "Clean out the garage",
    subtitle: "Sort through boxes from the move",
    content: tiptapDoc(
      paragraph(
        "Still have a few boxes from the move that need to go through. Donate what we don't need, toss what's broken, and organize the rest on the shelving unit."
      )
    ),
    status: "not_started",
    priority: 4,
    tags: ["home"],
  },

  // ── 💼 Work ─────────────────────────────────────────────────────────────────

  {
    folder: "Work",
    title: "Quarterly goals review",
    subtitle: "Look back at Q1 progress and plan for Q2",
    content: tiptapDoc(
      heading(2, "Q1 goals — how did it go?"),
      paragraph(
        "Three main goals this quarter: finish the onboarding project, reduce support tickets by 20%, and document the main workflows. Two out of three are done, support tickets are down 15% so far."
      ),
      heading(3, "What worked"),
      bulletList(
        "Blocking off Wednesday mornings for deep work",
        "Weekly check-ins kept things on track",
        "Writing things down instead of keeping them in my head"
      ),
      heading(3, "What to adjust"),
      bulletList(
        "Start saying no to meetings that don't need me",
        "Batch smaller tasks instead of context-switching",
        "Set clearer deadlines for myself, not just team deadlines"
      ),
      heading(3, "Q2 priorities"),
      paragraph(
        "Focus on the new onboarding flow, continue the support ticket work, and start the knowledge base project."
      )
    ),
    status: "in_progress",
    priority: 1,
    tags: ["planning"],
    start: d(0, 10),
    end: d(0, 11),
  },
  {
    folder: "Work",
    title: "Prepare team update",
    subtitle: "Quick summary for the all-hands on Friday",
    content: tiptapDoc(
      heading(2, "Team update — this week"),
      bulletList(
        "Onboarding project: final review stage",
        "Support tickets: trending down, new FAQ page helped",
        "Knowledge base: outline done, starting first drafts next week"
      ),
      paragraph("Keep it short — 5 minutes max. Focus on progress, not process.")
    ),
    status: "not_started",
    priority: 2,
    tags: ["meetings"],
    start: d(1, 9),
    end: d(1, 9, 30),
  },
  {
    folder: "Work",
    title: "Reply to emails",
    subtitle: "Clear the inbox before lunch",
    content: tiptapDoc(
      paragraph(
        "A few threads that need a response. Nothing urgent but don't let them pile up."
      )
    ),
    status: "not_started",
    priority: 3,
    tags: ["admin"],
    start: d(0, 11, 30),
    end: d(0, 12),
  },

  // ── 💪 Health ────────────────────────────────────────────────────────────────

  {
    folder: "Health",
    title: "Morning routine",
    subtitle: "Start the day right",
    content: tiptapDoc(
      heading(2, "Morning routine"),
      bulletList(
        "Wake up at 6:30, no snooze",
        "Glass of water before anything else",
        "10 minutes stretching or yoga",
        "Breakfast — keep it simple",
        "Review the day's plan"
      ),
      paragraph("The goal is consistency, not perfection. Just show up.")
    ),
    status: "done",
    priority: 0,
    tags: ["routine"],
    start: d(0, 6, 30),
    end: d(0, 7),
  },
  {
    folder: "Health",
    title: "Meal prep ideas",
    subtitle: "Simple meals to prep on Sunday",
    content: tiptapDoc(
      heading(2, "This week's meal prep"),
      bulletList(
        "Chicken and rice bowls with roasted veggies",
        "Overnight oats — 5 jars for the week",
        "Big pot of soup — freeze half",
        "Cut up fruit and veggies for snacks"
      ),
      paragraph(
        "Keep it simple. The point is to avoid ordering takeout on busy nights."
      )
    ),
    status: "not_started",
    priority: 3,
    tags: ["food"],
  },
  {
    folder: "Health",
    title: "Evening walk",
    subtitle: "Get outside, clear the head",
    content: tiptapDoc(
      paragraph("30 minutes around the neighborhood. No phone, just walk.")
    ),
    status: "done",
    priority: 0,
    tags: ["exercise"],
    start: d(-1, 18),
    end: d(-1, 18, 30),
  },
  {
    folder: "Health",
    title: "Schedule dentist appointment",
    subtitle: "Overdue by a couple months",
    content: tiptapDoc(
      paragraph("Call in the morning. Ask about the Saturday availability.")
    ),
    status: "not_started",
    priority: 2,
    tags: ["health"],
  },

  // ── 💡 Ideas ──────────────────────────────────────────────────────────────

  {
    folder: "Ideas",
    title: "Book recommendations",
    subtitle: "Books people have mentioned recently",
    content: tiptapDoc(
      heading(2, "To read"),
      bulletList(
        "Thinking in Systems — a good intro to systems thinking",
        "Four Thousand Weeks — about making peace with limited time",
        "The Creative Act — on the creative process, not just for artists",
        "Stoner — a quiet novel, supposedly very moving",
        "Range — why generalists triumph in a specialized world"
      )
    ),
    status: "not_started",
    priority: 4,
    tags: ["reading"],
  },
  {
    folder: "Ideas",
    title: "Gift ideas for birthdays",
    subtitle: "Running list so I'm not scrambling last minute",
    content: tiptapDoc(
      heading(2, "Gift ideas"),
      bulletList(
        "Nice candle or diffuser set",
        "A good cookbook",
        "Portable Bluetooth speaker",
        "Subscription box — coffee, tea, or snacks",
        "Handwritten letter + small gift card"
      ),
      paragraph("The best gift is one that shows you were paying attention to what they mentioned.")
    ),
    status: "not_started",
    priority: 4,
    tags: ["personal"],
  },
  {
    folder: "Ideas",
    title: "Things to learn this year",
    subtitle: "Skills and topics worth exploring",
    content: tiptapDoc(
      heading(2, "Learning goals"),
      bulletList(
        "Basic home repairs — fix things instead of calling someone",
        "Cooking a few new cuisines — start with Thai",
        "Get better at budgeting and personal finance",
        "Learn to use the sewing machine sitting in the closet"
      )
    ),
    status: "not_started",
    priority: 4,
    tags: ["growth"],
  },

  // ── Inbox ──────────────────────────────────────────────────────────────────

  {
    folder: "__INBOX__",
    title: "Research vacation spots",
    subtitle: "Look into a few options for the trip",
    content: tiptapDoc(
      heading(2, "Vacation research"),
      bulletList(
        "Coastal town — seafood, beach walks, pet-friendly",
        "Mountain cabin — hiking, campfire, quiet",
        "Lake house — fishing, kayaking, affordable"
      ),
      paragraph("Leaning toward the coast. Check prices for mid-April.")
    ),
    status: "in_progress",
    priority: 2,
    tags: ["travel"],
  },
  {
    folder: "__INBOX__",
    title: "Call the dentist",
    subtitle: "Morning hours are best",
    content: tiptapDoc(
      paragraph("Check if they have anything open next week. Prefer mornings.")
    ),
    status: "not_started",
    priority: 2,
    tags: ["errands"],
  },
  {
    folder: "__INBOX__",
    title: "Return library books",
    subtitle: "Due by Friday",
    content: tiptapDoc(
      paragraph("Three books in the tote bag by the door. Drop off on the way to work.")
    ),
    status: "not_started",
    priority: 3,
    tags: ["errands"],
  },
  {
    folder: "__INBOX__",
    title: "Look up new phone plan",
    subtitle: "Current plan is too expensive for what I use",
    content: tiptapDoc(
      paragraph(
        "Compare a few options. Don't need unlimited data — mostly on wifi. See if switching saves at least $15 a month."
      )
    ),
    status: "not_started",
    priority: 3,
    tags: ["finance"],
  },
];

export function run(dbPath: string = defaultDbPath()): void {
  console.log("\nPikos seed — marketing demo data");
  console.log(`  Target DB : ${dbPath}\n`);

  const db = openDb(dbPath);

  if (alreadySeeded(db, MARKER)) {
    console.log("  Already seeded (marker page found). Pass --force to re-run.");
    db.close();
    return;
  }

  const folderMap = new Map<string, string | null>();
  folderMap.set("__INBOX__", null);

  for (const [name, opts] of Object.entries(FOLDERS)) {
    folderMap.set(name, getOrCreateFolder(db, name, opts));
  }

  // Marker
  insertPage(db, {
    folderId: folderMap.get("Home")!,
    title: MARKER,
    subtitle: "Delete this page to re-seed",
    content: tiptapDoc(paragraph("Marketing demo seed marker.")),
    status: "done",
    priority: 0,
    sortOrder: 0,
  });

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
      content: spec.content,
      contentText: [spec.title, spec.subtitle, spec.tags.join(" ")].filter(Boolean).join(" "),
      status: spec.status,
      priority: spec.priority,
      tags: spec.tags,
      sortOrder: getSortOrder(folderId),
      completedAt: spec.status === "done" ? nowLocalISO() : null,
    });

    if (spec.start) {
      insertSchedule(db, {
        pageId,
        scheduledStart: spec.start,
        scheduledEnd: spec.end ?? null,
        timezone: spec.start.includes("T") ? "America/Los_Angeles" : null,
      });
    }

    const folderLabel = spec.folder === "__INBOX__" ? "Inbox" : spec.folder;
    console.log(`  ${folderLabel.padEnd(20)} ${spec.status.padEnd(14)} ${spec.title}`);
    total++;
  }

  db.close();

  console.log(`\n  Done — ${total} pages seeded.`);
  console.log(`  Today (${TODAY.toISOString().slice(0, 10)}): scheduled blocks for morning routine, goals review, and emails`);
  console.log(`  Use this dataset for marketing recordings.`);
}
