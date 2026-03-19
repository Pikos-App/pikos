/**
 * seed-stress.ts — Heavy-load scenario for performance testing.
 *
 * Inserts a large volume of folders, pages, and rich content to stress-test:
 *   - Sidebar rendering with many folders + page counts
 *   - Page list scroll performance (virtualization)
 *   - FTS5 index under load
 *   - Calendar density with many overlapping blocks
 *   - SQLite query performance under realistic row counts
 *
 * Volumes (configurable via env):
 *   SEED_FOLDERS  default 20
 *   SEED_PAGES    default 500  (spread across folders)
 *   SEED_SCHEDS   default 200  (subset of pages get calendar blocks)
 *
 * Usage:
 *   pnpm seed stress [path/to/workspace.sqlite]
 *   SEED_PAGES=1000 pnpm seed stress
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
  codeBlock,
  nowIso,
  nowLocalISO,
} from "./_db.ts";

const MARKER = "⚙️ [seed-stress] Stress test marker";

const FOLDER_COUNT = Number(process.env.SEED_FOLDERS ?? 20);
const PAGE_COUNT = Number(process.env.SEED_PAGES ?? 500);
const SCHED_COUNT = Number(process.env.SEED_SCHEDS ?? 200);

const FOLDER_COLORS = [
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#f43f5e",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#3b82f6",
  "#84cc16",
  "#f97316",
];


const TAGS_POOL = [
  "work",
  "personal",
  "urgent",
  "review",
  "research",
  "blocked",
  "waiting",
  "idea",
  "reference",
  "project",
  "meeting",
  "design",
  "dev",
  "qa",
  "infra",
  "marketing",
  "finance",
  "legal",
  "hr",
  "ops",
];

type Status = "not_started" | "in_progress" | "done";
const STATUSES: Status[] = ["not_started", "in_progress", "done"];
type Priority = 0 | 1 | 2 | 3 | 4;

function randPriority(): Priority {
  // Skew toward lower priorities — more realistic
  const r = Math.random();
  if (r < 0.05) return 1; // urgent
  if (r < 0.2) return 2; // high
  if (r < 0.5) return 3; // medium
  if (r < 0.8) return 4; // low
  return 0; // none
}

function randStatus(): Status {
  const r = Math.random();
  if (r < 0.6) return "not_started";
  if (r < 0.85) return "in_progress";
  return "done";
}

function randTags(): string[] {
  const n = Math.floor(Math.random() * 4); // 0–3 tags
  return faker.helpers.arrayElements(TAGS_POOL, n);
}

function richContent(): string {
  // Build a varied Tiptap doc to exercise the renderer
  const nodes = [
    heading(2, faker.lorem.sentence({ min: 3, max: 8 }).replace(/\.$/, "")),
    paragraph(faker.lorem.paragraph()),
  ];

  if (Math.random() > 0.4) {
    nodes.push(
      heading(3, faker.lorem.words({ min: 2, max: 5 })),
      paragraph(faker.lorem.paragraph())
    );
  }

  if (Math.random() > 0.5) {
    nodes.push(
      bulletList(
        faker.lorem.sentence(),
        faker.lorem.sentence(),
        faker.lorem.sentence(),
        ...(Math.random() > 0.6 ? [faker.lorem.sentence()] : [])
      )
    );
  }

  if (Math.random() > 0.6) {
    nodes.push(
      taskList(
        { text: faker.lorem.sentence(), checked: Math.random() > 0.5 },
        { text: faker.lorem.sentence(), checked: Math.random() > 0.5 },
        { text: faker.lorem.sentence(), checked: false }
      )
    );
  }

  if (Math.random() > 0.8) {
    nodes.push(
      codeBlock(
        "typescript",
        `// ${faker.hacker.phrase()}\nconst ${faker.hacker.noun()} = ${faker.number.int({ min: 1, max: 999 })};`
      )
    );
  }

  if (Math.random() > 0.5) {
    nodes.push(paragraph(faker.lorem.paragraph()));
  }

  return tiptapDoc(...nodes);
}

// Random local wall-clock time within the next 90 days (or past 30 days)
function randScheduledStart(): string {
  const offsetDays = faker.number.int({ min: -30, max: 90 });
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(
    faker.number.int({ min: 6, max: 22 }),
    faker.number.int({ min: 0, max: 3 }) * 15,
    0,
    0
  );
  return d.toISOString().replace("Z", "").slice(0, 19);
}

function randScheduledEnd(start: string, durationMins: number): string {
  const d = new Date(start);
  d.setMinutes(d.getMinutes() + durationMins);
  return d.toISOString().replace("Z", "").slice(0, 19);
}

export function run(dbPath: string = defaultDbPath()): void {
  console.log("\nPikos seed — stress test");
  console.log(`  Target DB   : ${dbPath}`);
  console.log(
    `  Volumes     : ${FOLDER_COUNT} folders · ${PAGE_COUNT} pages · ${SCHED_COUNT} schedules\n`
  );

  const db = openDb(dbPath);

  if (alreadySeeded(db, MARKER)) {
    console.log("  Already seeded (marker page found). Pass --force to re-run.");
    db.close();
    return;
  }

  faker.seed(42); // deterministic run

  // ── Folders ────────────────────────────────────────────────────────────────
  console.log(`  Creating ${FOLDER_COUNT} folders…`);
  const folderIds: string[] = [];

  // A few pages go to Inbox (folderId = null) — skip creating those folder slots
  for (let i = 0; i < FOLDER_COUNT; i++) {
    const name = `${faker.commerce.department()} · ${faker.word.noun()}`;
    const id = getOrCreateFolder(db, name, {
      color: FOLDER_COLORS[i % FOLDER_COLORS.length],
      sortOrder: i,
    });
    folderIds.push(id);
  }

  // ── Pages ──────────────────────────────────────────────────────────────────
  console.log(`  Creating ${PAGE_COUNT} pages…`);

  // Marker
  insertPage(db, {
    folderId: folderIds[0],
    title: MARKER,
    subtitle: "Delete this page to re-seed",
    content: tiptapDoc(paragraph("Stress seed marker.")),
    status: "done",
    priority: 0,
    sortOrder: 0,
  });

  const pageIds: string[] = [];

  // Page counts per folder (random, plus ~5% in inbox)
  const inboxCount = Math.max(1, Math.round(PAGE_COUNT * 0.05));
  const folderPageCount = PAGE_COUNT - inboxCount;

  // Inbox pages
  for (let i = 0; i < inboxCount; i++) {
    const status = randStatus();
    const id = insertPage(db, {
      folderId: null,
      title: faker.lorem.sentence({ min: 3, max: 10 }).replace(/\.$/, ""),
      subtitle: faker.lorem.sentence({ min: 5, max: 15 }),
      content: richContent(),
      status,
      priority: randPriority(),
      tags: randTags(),
      sortOrder: i,
      completedAt: status === "done" ? nowLocalISO() : null,
    });
    pageIds.push(id);
  }

  // Folder pages
  for (let i = 0; i < folderPageCount; i++) {
    const folderId = folderIds[i % folderIds.length];
    const status = randStatus();
    const id = insertPage(db, {
      folderId,
      title: faker.lorem.sentence({ min: 3, max: 10 }).replace(/\.$/, ""),
      subtitle: faker.lorem.sentence({ min: 5, max: 15 }),
      content: richContent(),
      status,
      priority: randPriority(),
      tags: randTags(),
      sortOrder: Math.floor(i / folderIds.length),
      completedAt: status === "done" ? nowLocalISO() : null,
    });
    pageIds.push(id);

    if ((i + 1) % 100 === 0) {
      process.stdout.write(`    ${i + 1}/${folderPageCount}\r`);
    }
  }
  process.stdout.write("\n");

  // ── Schedules ──────────────────────────────────────────────────────────────
  console.log(`  Creating ${SCHED_COUNT} schedules…`);

  // Randomly pick SCHED_COUNT pages to schedule (with replacement allowed)
  const durations = [15, 30, 45, 60, 90, 120];
  for (let i = 0; i < SCHED_COUNT; i++) {
    const pageId = pageIds[Math.floor(Math.random() * pageIds.length)];
    const start = randScheduledStart();
    const dur = faker.helpers.arrayElement(durations);
    const end = randScheduledEnd(start, dur);

    insertSchedule(db, {
      pageId,
      scheduledStart: start,
      scheduledEnd: end,
      timezone: "America/Los_Angeles",
    });
  }

  db.close();

  console.log(`\n  Done.`);
  console.log(`  Folders  : ${FOLDER_COUNT}`);
  console.log(`  Pages    : ${PAGE_COUNT} (${inboxCount} inbox + ${folderPageCount} in folders)`);
  console.log(`  Schedules: ${SCHED_COUNT}`);
  console.log(`\n  Tip: SEED_FOLDERS=50 SEED_PAGES=2000 pnpm seed stress`);
}
