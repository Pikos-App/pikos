/**
 * seed-tutorial.ts — Default tutorial / onboarding data.
 *
 * Shipped (or optionally seeded) on first launch to teach Pikos concepts:
 *   - What a page is
 *   - Folders vs Inbox
 *   - Tasks vs notes vs both
 *   - Scheduling on the calendar
 *   - Tags, priority, and status
 *   - Natural language quick-add
 *
 * Design principles:
 *   - Every page has real content that's genuinely useful to read
 *   - No "click here to do X" — show by example, not instruction
 *   - Deletable — the user should feel comfortable wiping all of this
 *   - Marker page ("Welcome to Pikos") is the idempotency guard
 *
 * Usage:
 *   pnpm seed tutorial [path/to/workspace.sqlite]
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
  codeBlock,
} from "./_db.ts";

const MARKER = "Welcome to Pikos 👋";

const TODAY = new Date("2026-03-12");

function d(offsetDays: number, hour?: number, minute = 0): string {
  const dt = new Date(TODAY);
  dt.setDate(dt.getDate() + offsetDays);
  if (hour === undefined) return dt.toISOString().slice(0, 10);
  return `${dt.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

export function run(dbPath: string = defaultDbPath()): void {
  console.log("\nPikos seed — tutorial / onboarding data");
  console.log(`  Target DB : ${dbPath}\n`);

  const db = openDb(dbPath);

  if (alreadySeeded(db, MARKER)) {
    console.log("  Already seeded (marker page found). Pass --force to re-run.");
    db.close();
    return;
  }

  const gettingStartedId = getOrCreateFolder(db, "Getting started", {
    color: "#6366f1",
    sortOrder: 0,
  });

  const examplesId = getOrCreateFolder(db, "Examples", {
    color: "#10b981",
    sortOrder: 1,
  });

  let sortOrder = 0;

  // ── Welcome page (marker + landing) ──────────────────────────────────────

  insertPage(db, {
    folderId: gettingStartedId,
    title: MARKER,
    subtitle: "Your notes, tasks, and calendar — one app, local-first.",
    content: tiptapDoc(
      heading(2, "Welcome to Pikos 👋"),
      paragraph(
        "Pikos is the app for people who can't decide whether they need a note-taking app or a task manager. " +
          "You don't have to decide — every page is both."
      ),
      heading(3, "Three things to try first"),
      taskList(
        { text: "Press Cmd+N to create your first page", checked: false },
        { text: "Drag a page onto the calendar to schedule it", checked: false },
        { text: "Type today's date in the quick-add bar (e.g. '@today 9am')", checked: false }
      ),
      heading(3, "Feel free to delete these example pages"),
      paragraph(
        "The 'Getting started' and 'Examples' folders are here to give you a feel for Pikos. " +
          "Delete them whenever you're ready — they're just sample data."
      )
    ),
    status: "not_started",
    priority: 0,
    tags: ["tutorial"],
    sortOrder: sortOrder++,
  });

  // ── Getting started: what is a page? ─────────────────────────────────────

  insertPage(db, {
    folderId: gettingStartedId,
    title: "Every page is a note AND a task",
    subtitle: "No mode-switching — just open a page and start typing",
    content: tiptapDoc(
      heading(2, "Every page is a note AND a task"),
      paragraph(
        "In most apps, notes and tasks are separate things. In Pikos, a page is both. " +
          "It has a title (the task), body (the note), and metadata (status, priority, schedule)."
      ),
      heading(3, "A page can be"),
      bulletList(
        "A quick task: 'Email Dan re: invoice' — one line, done",
        "A long note: meeting notes, research, journal entries",
        "A project: title + task list + context + schedule",
        "A recurring event: 'Daily standup' with an rrule"
      ),
      heading(3, "Status cycle"),
      paragraph("○ Not started  →  ◑ In progress  →  ✓ Done"),
      paragraph("Click the status icon in the page list or metadata header to cycle.")
    ),
    status: "done",
    priority: 0,
    tags: ["tutorial"],
    sortOrder: sortOrder++,
  });

  // ── Getting started: folders vs inbox ────────────────────────────────────

  insertPage(db, {
    folderId: gettingStartedId,
    title: "Folders and Inbox",
    subtitle: "Inbox is the default landing spot. Folders are optional groupings.",
    content: tiptapDoc(
      heading(2, "Folders and Inbox"),
      heading(3, "Inbox"),
      paragraph(
        "Every new page lands in Inbox unless you specify a folder. " +
          "Think of it as your capture zone — process it later, or leave it there forever. No judgement."
      ),
      heading(3, "Folders"),
      paragraph(
        "Folders group pages by project, area, or any mental model you prefer. " +
          "They're flat (no nesting in v1), coloured, and sortable. " +
          "A page can only be in one folder."
      ),
      heading(3, "Today"),
      paragraph(
        "The Today view is pinned above your folders. It shows every page with a schedule " +
          "date on or before today — across all folders. It's your daily dashboard."
      )
    ),
    status: "done",
    priority: 0,
    tags: ["tutorial"],
    sortOrder: sortOrder++,
  });

  // ── Getting started: scheduling ───────────────────────────────────────────

  const schedPageId = insertPage(db, {
    folderId: gettingStartedId,
    title: "Scheduling pages on the calendar",
    subtitle: "Drag a page onto the calendar, or use natural language in quick-add",
    content: tiptapDoc(
      heading(2, "Scheduling"),
      heading(3, "Three ways to schedule"),
      bulletList(
        "Drag a page from the list onto a calendar time slot",
        "Click the date field in the metadata header",
        "Quick-add: Cmd+N → type 'team sync @tomorrow 2pm for 1h'"
      ),
      heading(3, "Natural language examples"),
      bulletList(
        "'morning run @monday 7am for 45m' — one page, Monday",
        "'standup m/w/f at 9am' — 3 pages, next Mon/Wed/Fri",
        "'daily standup every monday 9am' — recurring template"
      ),
      heading(3, "Calendar view"),
      paragraph(
        "Toggle the right panel to Calendar with Cmd+Shift+C. " +
          "Click a time slot to quick-add. Drag blocks to reschedule. " +
          "Hover a block to mark done or remove the block."
      )
    ),
    status: "not_started",
    priority: 0,
    tags: ["tutorial"],
    sortOrder: sortOrder++,
    start: d(0, 15),
    end: d(0, 15, 30),
    durationMins: 30,
  });

  insertSchedule(db, {
    pageId: schedPageId,
    scheduledStart: d(0, 15),
    scheduledEnd: d(0, 15, 30),
    timezone: "America/Los_Angeles",
  });

  // ── Getting started: quick add ────────────────────────────────────────────

  insertPage(db, {
    folderId: gettingStartedId,
    title: "Quick-add with Cmd+N",
    subtitle: "Create any page from anywhere — with natural language",
    content: tiptapDoc(
      heading(2, "Quick-add (Cmd+N)"),
      paragraph(
        "Press Cmd+N from anywhere to open the Quick Add modal. " +
          "Type a page title — optionally include date, time, tags, folder, and priority tokens."
      ),
      heading(3, "Token reference"),
      bulletList(
        "@today · @tomorrow · @monday · @march20",
        "9pm · at 3:30pm · 14:00",
        "for 1h · for 30min",
        "#work · #design (tags)",
        "~Projects (folder)",
        "!urgent · !high · !medium · !low"
      ),
      heading(3, "Examples"),
      bulletList(
        "review sprint @friday 2pm for 1h !high",
        "call mom @sunday 11am #personal",
        "standup m/w/f at 9am for 30m ~Work"
      )
    ),
    status: "not_started",
    priority: 0,
    tags: ["tutorial"],
    sortOrder: sortOrder++,
  });

  // ── Getting started: keyboard shortcuts ───────────────────────────────────

  insertPage(db, {
    folderId: gettingStartedId,
    title: "Keyboard shortcuts",
    subtitle: "Everything reachable without a mouse",
    content: tiptapDoc(
      heading(2, "Keyboard shortcuts"),
      heading(3, "Navigation"),
      bulletList(
        "Cmd+N — Quick-add new page",
        "Cmd+P — Command palette (search + actions)",
        "J / K — Move up/down in page list",
        "Enter — Open selected page in editor",
        "Cmd+\\ — Toggle sidebar collapse",
        "Cmd+Shift+C — Toggle calendar / editor panel"
      ),
      heading(3, "Editor"),
      bulletList(
        "Cmd+B / Cmd+I / Cmd+U — Bold / italic / underline",
        "Cmd+Shift+X — Strikethrough",
        "Cmd+` — Inline code",
        "Tab / Shift+Tab — Indent / outdent list",
        "Cmd+Z / Cmd+Shift+Z — Undo / redo",
        "Esc — Return focus to page list"
      ),
      heading(3, "Metadata"),
      bulletList("Cmd+Shift+M — Expand / collapse metadata header")
    ),
    status: "not_started",
    priority: 0,
    tags: ["tutorial", "reference"],
    sortOrder: sortOrder++,
  });

  // ── Examples folder ───────────────────────────────────────────────────────

  sortOrder = 0;

  // Example: meeting notes
  insertPage(db, {
    folderId: examplesId,
    title: "1:1 with Marcus — March 11",
    subtitle: "Career growth, feedback on Q1, team dynamics",
    content: tiptapDoc(
      heading(2, "1:1 with Marcus — March 11"),
      paragraph("30 min · Remote"),
      heading(3, "His updates"),
      bulletList(
        "CI pipeline stabilised — deploy times down 40%",
        "Looking to move into tech lead role by end of year",
        "Wants more visibility on product decisions"
      ),
      heading(3, "My updates"),
      bulletList("GOO-104 shipped last week", "On track for v0.1.1 by March 20"),
      heading(3, "Action items"),
      taskList(
        { text: "Share product roadmap doc with Marcus", checked: false },
        { text: "Set up fortnightly arch sync with Marcus", checked: true },
        { text: "Write performance self-review draft", checked: false }
      )
    ),
    status: "done",
    priority: 3,
    tags: ["meeting", "work"],
    sortOrder: sortOrder++,
    start: d(-1, 14),
    end: d(-1, 14, 30),
  });

  // Example: project with tasks
  const projectPageId = insertPage(db, {
    folderId: examplesId,
    title: "Plan: spring wardrobe refresh",
    subtitle: "Pare down to essentials, replace worn basics",
    content: tiptapDoc(
      heading(2, "Spring wardrobe refresh"),
      paragraph("Budget: $300. Finish before April."),
      heading(3, "Declutter first"),
      taskList(
        { text: "Try on everything — donate anything ill-fitting", checked: true },
        { text: "Ditch worn-through socks + undershirts", checked: true },
        { text: "Sell 3 rarely-worn items on Poshmark", checked: false }
      ),
      heading(3, "Buy"),
      taskList(
        { text: "2x white Oxford shirts (Uniqlo)", checked: false },
        { text: "1x dark slim chinos", checked: false },
        { text: "Casual leather sneakers (size 11)", checked: false },
        { text: "6x quality socks", checked: false }
      )
    ),
    status: "in_progress",
    priority: 4,
    tags: ["personal", "shopping"],
    sortOrder: sortOrder++,
    start: d(3, 10),
    end: d(3, 11),
  });

  insertSchedule(db, {
    pageId: projectPageId,
    scheduledStart: d(3, 10),
    scheduledEnd: d(3, 11),
    timezone: "America/Los_Angeles",
  });

  // Example: research note
  insertPage(db, {
    folderId: examplesId,
    title: "Notes: SQLite WAL mode explained",
    subtitle: "Why WAL mode makes Pikos's reads non-blocking",
    content: tiptapDoc(
      heading(2, "SQLite WAL mode"),
      paragraph(
        "WAL (Write-Ahead Log) mode changes how SQLite handles concurrent reads and writes. " +
          "Instead of locking the database file, writers append to a separate .wal file. " +
          "Readers can continue reading the last committed state while a write is in progress."
      ),
      heading(3, "Why this matters for Pikos"),
      bulletList(
        "The Tauri IPC layer and the autosave debounce can write simultaneously without blocking reads",
        "Page list updates feel instant — no waiting for save to finish",
        "Crash recovery is safe — WAL is replayed on next open"
      ),
      heading(3, "Config in Pikos"),
      codeBlock(
        "rust",
        `SqliteConnectOptions::new()
    .journal_mode(SqliteJournalMode::Wal)
    .foreign_keys(true)`
      )
    ),
    status: "done",
    priority: 0,
    tags: ["reference", "dev"],
    sortOrder: sortOrder++,
  });

  // Example: simple task in inbox
  insertPage(db, {
    folderId: null, // inbox
    title: "Delete the Getting started folder when ready",
    subtitle: "These tutorial pages are safe to remove — your data lives separately",
    content: tiptapDoc(
      paragraph(
        "When you're comfortable with Pikos, delete the 'Getting started' and 'Examples' folders. " +
          "They're just sample content. Your real pages are safe."
      )
    ),
    status: "not_started",
    priority: 4,
    tags: ["tutorial"],
    sortOrder: 0,
  });

  db.close();

  console.log(`  Done — tutorial data seeded.`);
  console.log(`  Folders : Getting started · Examples`);
  console.log(`  Inbox   : 1 page`);
  console.log(`\n  Tip: delete 'Getting started' and 'Examples' to remove tutorial content.`);
}
