/**
 * seed-demo.ts — Polished, photogenic data for demo videos and screenshots.
 *
 * Goals:
 *   - Everything looks real and purposeful — no "lorem ipsum"
 *   - Today view has a satisfying mix of done + in-progress + upcoming
 *   - Calendar is dense enough to look busy but not overwhelming
 *   - Folder names + icons photograph well
 *   - Priority + status spread looks balanced on screen
 *   - Tags are colourful and varied
 *
 * Usage:
 *   pnpm seed demo [path/to/workspace.sqlite]
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
} from "./_db.ts";

const MARKER = "⚙️ [seed-demo] Demo data marker";

const TODAY = new Date("2026-03-12"); // Thursday — mid-week looks productive

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
  durationMins?: number;
}

// ── Folders ───────────────────────────────────────────────────────────────────

const FOLDERS: Record<string, { color: string; sortOrder: number }> = {
  "🚀 Pikos Launch": { color: "#6366f1", sortOrder: 0 },
  "🎨 Design": { color: "#ec4899", sortOrder: 1 },
  "💡 Ideas": { color: "#f59e0b", sortOrder: 2 },
  "🧘 Personal": { color: "#10b981", sortOrder: 3 },
};

// ── Pages ──────────────────────────────────────────────────────────────────────

const PAGES: Page[] = [
  // ── 🚀 Pikos Launch ────────────────────────────────────────────────────────

  {
    folder: "🚀 Pikos Launch",
    title: "App Store submission checklist",
    subtitle: "Everything needed before hitting Submit in App Store Connect",
    content: tiptapDoc(
      heading(2, "App Store submission checklist"),
      taskList(
        { text: "Privacy policy URL live on pikos.app/privacy", checked: true },
        { text: "App icon all sizes exported (1024px master)", checked: true },
        { text: "Screenshots — 6.7″ iPhone + 15″ MacBook Pro", checked: true },
        { text: "App description ≤ 4000 chars, keywords ≤ 100 chars", checked: true },
        { text: "What's new copy for v1.0", checked: false },
        { text: "Age rating questionnaire complete", checked: false },
        { text: "Pricing set — $19.99 one-time", checked: false },
        { text: "TestFlight build passes Apple review", checked: false }
      )
    ),
    status: "in_progress",
    priority: 1,
    tags: ["launch", "appstore"],
    start: d(0, 9),
    end: d(0, 10),
    durationMins: 60,
  },
  {
    folder: "🚀 Pikos Launch",
    title: "Landing page copy — hero section",
    subtitle: "The 10-second pitch for someone landing from a Hacker News post",
    content: tiptapDoc(
      heading(2, "Hero section"),
      paragraph("Headline: Your notes, tasks, and calendar. One app, local-first."),
      paragraph(
        "Sub: Pikos replaces Obsidian + TickTick + Fantastical — no account required, no subscription for the basics."
      ),
      heading(3, "CTA"),
      paragraph("Primary: Download for Mac — Free"),
      paragraph("Secondary: See how it works →"),
      heading(3, "Social proof"),
      bulletList(
        '"Finally an app that treats notes and tasks as the same thing." — HN',
        '"The calendar drag-to-schedule is magic." — early tester'
      )
    ),
    status: "done",
    priority: 2,
    tags: ["launch", "marketing", "writing"],
  },
  {
    folder: "🚀 Pikos Launch",
    title: "Beta feedback synthesis",
    subtitle: "Common patterns from 47 beta responses",
    content: tiptapDoc(
      heading(2, "Beta feedback — key themes"),
      heading(3, "Top requests"),
      bulletList(
        "Mobile app (iOS) — 31 of 47",
        "Markdown import/export — 28 of 47",
        "Tags autocomplete in editor — 22 of 47",
        "Dark mode — 18 of 47",
        "Web clipper — 15 of 47"
      ),
      heading(3, "Sentiment"),
      paragraph(
        "NPS: 62 (promoters 71%, detractors 9%). Strong praise for speed and offline reliability."
      ),
      heading(3, "Prioritisation"),
      paragraph(
        "iOS and markdown export align with roadmap. Tags autocomplete fast-tracked to Phase 2."
      )
    ),
    status: "done",
    priority: 2,
    tags: ["research", "launch"],
    start: d(-2, 14),
    end: d(-2, 15, 30),
  },
  {
    folder: "🚀 Pikos Launch",
    title: "Hacker News Show HN post draft",
    subtitle: "Ask for feedback, not upvotes — link to /open for the technical crowd",
    content: tiptapDoc(
      heading(2, "Show HN: Pikos — notes + tasks + calendar, local-first Mac app"),
      paragraph(
        "Hi HN! I've been building Pikos for the past 8 months. It's the app I wanted but couldn't find: " +
          "something that treats every note as a potential task, and every task as something you can schedule on a calendar. " +
          "No account, no sync subscription for the basics, Tauri + SQLite under the hood."
      ),
      heading(3, "What makes it different"),
      bulletList(
        "Every page is simultaneously a note and a task — no type distinction",
        "Drag-to-schedule on the calendar view",
        "Natural language input: 'standup m/w/f at 9am for 30m'",
        "Local SQLite — your data, your machine"
      ),
      heading(3, "Tech stack"),
      paragraph("Tauri 2 · React 19 · SQLite (via sqlx) · Tiptap · Tailwind v4")
    ),
    status: "not_started",
    priority: 1,
    tags: ["launch", "marketing"],
    start: d(7, 10),
    end: d(7, 10, 30),
  },
  {
    folder: "🚀 Pikos Launch",
    title: "Product Hunt launch day ops",
    subtitle: "Minute-by-minute schedule for the PH launch",
    content: tiptapDoc(
      heading(2, "PH launch day"),
      bulletList(
        "12:01 AM PT — post goes live",
        "7:00 AM — tweet from @pikos_app",
        "8:00 AM — email list announcement",
        "9:00 AM — HN Show HN post",
        "12:00 PM — LinkedIn post",
        "3:00 PM — community Discord / Slack shares",
        "6:00 PM — mid-day update comment on PH",
        "11:59 PM — final push / celebrate"
      )
    ),
    status: "not_started",
    priority: 2,
    tags: ["launch", "marketing"],
    start: d(14),
  },

  // ── 🎨 Design ─────────────────────────────────────────────────────────────

  {
    folder: "🎨 Design",
    title: "Collapsible metadata header — GOO-32",
    subtitle: "Animated expand/collapse with CSS grid-template-rows trick",
    content: tiptapDoc(
      heading(2, "GOO-32 — Collapsible metadata header"),
      heading(3, "Collapsed state"),
      paragraph("Title always visible, inline-editable. [↑ hide] button top-right."),
      heading(3, "Expanded state"),
      paragraph("Row 1: Status · Priority · Date · Tags"),
      paragraph("Row 2: Subtitle / description"),
      heading(3, "Animation"),
      paragraph("CSS grid-template-rows: 0fr → 1fr. No layout jump. 200ms ease."),
      heading(3, "Keyboard"),
      bulletList("Cmd+Shift+M toggle", "Tab through fields", "Esc → focus editor")
    ),
    status: "in_progress",
    priority: 1,
    tags: ["design", "dev"],
    start: d(0, 14),
    end: d(0, 16),
    durationMins: 120,
  },
  {
    folder: "🎨 Design",
    title: "Icon system audit",
    subtitle: "Replace inconsistent icon usage with Lucide throughout",
    content: tiptapDoc(
      heading(2, "Icon system audit"),
      taskList(
        { text: "Sidebar folder icons — Lucide Folder / FolderOpen", checked: true },
        { text: "Page list status icons — Circle / CircleDot / CheckCircle", checked: true },
        { text: "Priority icons — Minus / AlertCircle / ChevronUp / Dot", checked: false },
        { text: "Calendar — CalendarDays / Clock / ChevronLeft / ChevronRight", checked: false },
        { text: "Toolbar — Bold / Italic / Code / Link / List / Check", checked: false }
      )
    ),
    status: "in_progress",
    priority: 3,
    tags: ["design"],
  },
  {
    folder: "🎨 Design",
    title: "Dark mode token mapping",
    subtitle: "Map all Tailwind semantic tokens to light and dark values",
    content: tiptapDoc(
      heading(2, "Dark mode tokens"),
      heading(3, "Background"),
      bulletList(
        "background: slate-50 / slate-950",
        "surface: white / slate-900",
        "surface-raised: slate-100 / slate-800"
      ),
      heading(3, "Text"),
      bulletList(
        "foreground: slate-900 / slate-50",
        "muted: slate-500 / slate-400",
        "subtle: slate-400 / slate-600"
      ),
      heading(3, "Brand"),
      bulletList("primary: indigo-600 / indigo-400", "primary-hover: indigo-700 / indigo-300")
    ),
    status: "not_started",
    priority: 2,
    tags: ["design", "theme"],
  },
  {
    folder: "🎨 Design",
    title: "Calendar block visual polish",
    subtitle: "Rounded corners, colour-coded by priority, hover state",
    content: tiptapDoc(
      heading(2, "Calendar block design"),
      paragraph("Priority colour strip on left edge (3px). Rounded 6px. Subtle shadow."),
      heading(3, "States"),
      bulletList(
        "Default: surface bg, border-l-4 priority colour",
        "Hover: slightly elevated shadow, cursor grab",
        "Dragging: 90% opacity, scale 1.02",
        "Done: muted bg, strikethrough title"
      )
    ),
    status: "not_started",
    priority: 3,
    tags: ["design", "calendar"],
  },

  // ── 💡 Ideas ─────────────────────────────────────────────────────────────

  {
    folder: "💡 Ideas",
    title: "Weekly review template",
    subtitle: "Structured prompt to ship every Sunday evening",
    content: tiptapDoc(
      heading(2, "Weekly review"),
      heading(3, "What did I ship?"),
      paragraph("List 3–5 things finished this week."),
      heading(3, "What did I avoid?"),
      paragraph("Honest list. No judgement."),
      heading(3, "Energy audit"),
      paragraph("What drained me? What energised me?"),
      heading(3, "Next week — top 3"),
      paragraph("The 3 most important things for next week."),
      heading(3, "Inbox zero"),
      paragraph("Process all loose items to Inbox, then triage.")
    ),
    status: "done",
    priority: 3,
    tags: ["template", "productivity"],
  },
  {
    folder: "💡 Ideas",
    title: "Whiteboard integration concept",
    subtitle: "Freeform canvas inside a page — for spatial thinkers",
    content: tiptapDoc(
      heading(2, "Whiteboard concept"),
      paragraph(
        "Add a /canvas block type to the editor. Opens a tldraw-powered freeform surface. " +
          "Stores SVG or tldraw JSON in the page content blob. Optional — off by default."
      ),
      heading(3, "Prior art"),
      bulletList(
        "Notion — page-as-canvas (separate from editor)",
        "Obsidian Canvas — excellent, but outside notes",
        "Miro — real-time collab; overkill for local-first"
      ),
      heading(3, "Phase"),
      paragraph("Phase 5 at earliest. Log as idea for now.")
    ),
    status: "not_started",
    priority: 4,
    tags: ["idea", "future"],
  },
  {
    folder: "💡 Ideas",
    title: "Command palette GOO-61",
    subtitle: "Cmd+P global search + actions — fastest navigation primitive",
    content: tiptapDoc(
      heading(2, "Command palette"),
      paragraph("Open with Cmd+P from anywhere. Fuzzy search: pages, folders, commands."),
      heading(3, "Result types"),
      bulletList(
        "Pages — title + subtitle preview",
        "Folders — jump to folder view",
        "Commands — create page, toggle theme, open settings…",
        "Recent — weighted by last_opened_at"
      ),
      heading(3, "Tech"),
      paragraph(
        "FTS5 for page search. Local command registry (array of {label, action}). cmdk library or roll own."
      )
    ),
    status: "not_started",
    priority: 2,
    tags: ["idea", "dev", "ux"],
  },

  // ── 🧘 Personal ──────────────────────────────────────────────────────────

  {
    folder: "🧘 Personal",
    title: "Morning pages — March 12",
    subtitle: "Stream of consciousness before the day starts",
    content: tiptapDoc(
      paragraph(
        "Thursday. Good energy. The sleep was solid — 7.5 h, no interruptions. " +
          "Want to make real progress on the metadata header today. Keep the tab open, skip Slack until noon. " +
          "Also: order birthday gift for Alex before the week's out."
      )
    ),
    status: "done",
    priority: 0,
    tags: ["journal"],
    start: d(0, 6, 30),
    end: d(0, 7),
    durationMins: 30,
  },
  {
    folder: "🧘 Personal",
    title: "Run — 5k easy",
    subtitle: "Active recovery. No watch, just legs.",
    content: tiptapDoc(
      paragraph("Route: river trail loop. Headphones: yes (podcast)."),
      bulletList("Goal: under 35 min", "Stretch after", "Foam roll IT band")
    ),
    status: "done",
    priority: 0,
    tags: ["health", "run"],
    start: d(-1, 7),
    end: d(-1, 7, 38),
    durationMins: 38,
  },
  {
    folder: "🧘 Personal",
    title: "Dinner with Jamie — Friday",
    subtitle: "Reservations at Oleana, 7 PM",
    content: tiptapDoc(
      paragraph("Oleana — 134 Hampshire St, Cambridge."),
      bulletList(
        "Reservation: 7:00 PM, name: Alex",
        "Menu: Turkish-inspired, great vegetarian options",
        "Topics: new apartment search, catch up generally"
      )
    ),
    status: "not_started",
    priority: 3,
    tags: ["personal", "social"],
    start: d(1, 19),
    end: d(1, 21),
    durationMins: 120,
  },

  // ── Inbox ─────────────────────────────────────────────────────────────────

  {
    folder: "__INBOX__",
    title: "Respond to Priya's PR review",
    subtitle: "GOO-103 scroll memory — one comment on the ResizeObserver cleanup",
    content: tiptapDoc(
      paragraph(
        "Her comment: 'Should we return early if ref.current is null rather than optional chaining?' " +
          "Reply: agree, cleaner — will push a fixup."
      )
    ),
    status: "not_started",
    priority: 2,
    tags: ["dev", "review"],
    start: d(0, 11),
    end: d(0, 11, 15),
  },
  {
    folder: "__INBOX__",
    title: "Renew domain pikos.app",
    subtitle: "Expires March 31 — auto-renew off, renew manually",
    content: tiptapDoc(
      paragraph("Registrar: Cloudflare. Log in → Domains → pikos.app → Renew. $10/yr.")
    ),
    status: "not_started",
    priority: 1,
    tags: ["ops"],
  },
];

export function run(dbPath: string = defaultDbPath()): void {
  console.log("\nPikos seed — demo data");
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
    folderId: folderMap.get("🚀 Pikos Launch")!,
    title: MARKER,
    subtitle: "Delete this page to re-seed",
    content: tiptapDoc(paragraph("Demo seed marker.")),
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
      completedAt: spec.status === "done" ? new Date().toISOString() : null,
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

    const folderLabel = spec.folder === "__INBOX__" ? "Inbox" : spec.folder;
    console.log(`  ${folderLabel.padEnd(20)} ${spec.status.padEnd(14)} ${spec.title}`);
    total++;
  }

  db.close();

  console.log(`\n  Done — ${total} pages seeded.`);
  console.log(`  Today (${TODAY.toISOString().slice(0, 10)}): 4 scheduled blocks`);
  console.log(`  Use this dataset for screenshots and demo recordings.`);
}
