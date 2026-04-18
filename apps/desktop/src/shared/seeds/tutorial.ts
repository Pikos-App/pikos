// Tutorial seed — onboarding data seeded on first workspace creation.
// Teaches Pikos concepts through real pages that showcase key features.
// Called automatically in selectWorkspace() for new workspaces.

import { extractText } from "@pikos/core";
import type { StorageAdapter } from "@pikos/core";

const MARKER = "Welcome to Pikos";

/** Check if tutorial data was already seeded (idempotency guard). */
async function alreadySeeded(adapter: StorageAdapter): Promise<boolean> {
  const { results } = await adapter.searchPages(MARKER);
  return results.some((r) => r.title.startsWith(MARKER));
}

export async function seedTutorial(
  adapter: StorageAdapter
): Promise<{ welcomePageId: string; folderId: string } | null> {
  if (await alreadySeeded(adapter)) return null;

  const now = new Date();

  function day(offset: number): string {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  }

  function dayTime(offset: number, hour: number, minute = 0): string {
    return `${day(offset)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  }

  /** Create a page with contentText auto-extracted from content. */
  async function createPage(data: Parameters<StorageAdapter["createPage"]>[0]) {
    return adapter.createPage({ ...data, contentText: extractText(data.content) });
  }

  // ── Single tutorial folder ──────────────────────────────────────────────

  const tutorial = await adapter.createFolder({
    color: "#6366f1",
    name: "Tutorial",
    parentId: null,
  });

  // ── Welcome page (marker + landing) ─────────────────────────────────────

  const welcome = await createPage({
    content: doc(
      p(
        "Hi, glad you\u2019re here. Pikos brings your notes, tasks, and calendar into one place. " +
          "Every page is both a note you can write in and a task you can schedule, so there\u2019s no mode to switch between."
      ),
      p(
        "Everything lives on your device. No account, no cloud, no telemetry. Your data stays yours."
      ),
      h3("Try a few things"),
      tasks(
        { checked: false, text: "Press Cmd+N to open the quick-add dialog and type anything" },
        {
          checked: false,
          text: "Press Cmd+Shift+C to flip the right panel between editor and calendar",
        },
        { checked: false, text: "Drag a page from the list onto a calendar time slot" },
        { checked: false, text: "Drag a page onto a folder in the sidebar to move it" },
        { checked: false, text: "Click the checkbox next to this task to mark it done" },
        { checked: false, text: "Press Cmd+K to search across everything you\u2019ve written" }
      ),
      h3("When you\u2019re done exploring"),
      p(
        "Right-click the Tutorial folder in the sidebar and delete it. All tutorial pages go with it. " +
          "Deleted something by accident? Look for the undo toast at the bottom of the screen."
      )
    ),
    folderId: tutorial.id,
    priority: 0,
    status: "not_started",
    subtitle: "Your notes, tasks, and calendar. One app, on your device.",
    tags: ["tutorial"],
    title: "Welcome to Pikos \ud83d\udc4b",
  });

  // ── Core workflow: quick add → schedule → complete ──────────────────────

  const workflow = await createPage({
    content: doc(
      p(
        "Everything in Pikos runs through three steps: add, schedule, complete. " +
          "Once that clicks, the rest is polish."
      ),
      h3("1. Add (Cmd+N)"),
      p(
        "Quick-add is a single text field. Type a title, and Pikos pulls out any metadata it recognizes."
      ),
      bullets(
        "review slides tomorrow 2pm for 1h",
        "call dentist monday 9am !high",
        "grocery list #personal ~Errands",
        "team standup weekdays 9am"
      ),
      p(
        "You can mix and match: dates (today, tomorrow, monday, mar 5), " +
          "times (2pm, 14:00), duration (for 1h, for 30m), " +
          "priority (!urgent, !high, !medium, !low), tags (#tag), and folders (~FolderName). " +
          "Anything unrecognized becomes the title."
      ),
      h3("2. Schedule"),
      bullets(
        "Drag a page from the list onto a calendar time slot",
        "Click an empty slot to create a page right there",
        "Set the date in the page\u2019s metadata header (top of the editor)",
        "All-day? Drop it into the all-day row at the top of the calendar"
      ),
      h3("3. Complete"),
      bullets(
        "Click the checkbox in the page list",
        "Click the checkbox in the page editor",
        "Hover a calendar block and click the \u2713 quick-action"
      ),
      p(
        "Recurring pages behave slightly differently. Completing the current occurrence " +
          "advances to the next one instead of finishing the whole series."
      )
    ),
    folderId: tutorial.id,
    priority: 0,
    status: "not_started",
    subtitle: "The core loop: create a page, put it on the calendar, mark it done",
    tags: ["tutorial"],
    title: "Quick add, schedule, complete",
  });
  await adapter.createPageSchedule({
    pageId: workflow.id,
    scheduledEnd: dayTime(0, 15, 30),
    scheduledStart: dayTime(0, 15),
    timezone: "America/Los_Angeles",
  });

  // ── Going further: power features ───────────────────────────────────────

  await createPage({
    content: doc(
      p(
        "A few features worth knowing about once you\u2019ve got the basics down. " +
          "None of this is mandatory. Pikos works fine without touching any of it."
      ),
      h3("Recurring events"),
      p(
        "Pikos understands natural cadences. Try \u201cstandup weekdays 9am\u201d in quick-add, " +
          "or open the repeat button in a page\u2019s metadata header for a picker. " +
          "To skip a single occurrence without breaking the series, right-click the calendar block."
      ),
      h3("Reminders"),
      p(
        "Each scheduled page can have a reminder lead time: 5, 10, 15, or 30 minutes before it starts. " +
          "Set a default in Settings \u2192 Notifications, or override it per page."
      ),
      h3("Daily summary"),
      p(
        "Each morning at a time you pick, Pikos can send one notification with everything scheduled today plus anything overdue. " +
          "Turn it on in Settings \u2192 Notifications. Quiet hours silence notifications during the times you don\u2019t want to be bothered."
      ),
      h3("Organizing"),
      bullets(
        "Right-click a folder to rename, recolor, or delete it",
        "Drag folders in the sidebar to reorder",
        "Today shows scheduled and overdue pages. Inbox shows anything without a folder. Both are pinned to the top of the sidebar.",
        "Tags work across folders, which is handy when a project touches several areas"
      ),
      h3("Getting out of trouble"),
      p(
        "Deleted the wrong page? The undo toast at the bottom of the screen will bring it back. " +
          "Settings, shortcuts, and notification preferences all live under Cmd+,."
      )
    ),
    folderId: tutorial.id,
    priority: 0,
    status: "not_started",
    subtitle: "Recurring events, reminders, and the daily summary",
    tags: ["tutorial"],
    title: "Going further",
  });

  // ── Keyboard shortcuts ──────────────────────────────────────────────────

  await createPage({
    content: doc(
      p(
        "The full list lives in Settings \u2192 Shortcuts, and most are customizable. " +
          "These are the ones worth committing to memory."
      ),
      h3("Navigation"),
      bullets(
        "Cmd+N: Quick-add a new page",
        "Cmd+K: Search all pages",
        "Cmd+Shift+C: Toggle between editor and calendar",
        "Cmd+\\: Toggle the sidebar",
        "Cmd+1\u20139: Jump to a folder by position",
        "Cmd+,: Open settings",
        "\u2191 / \u2193: Move through the page list or sidebar"
      ),
      h3("Editor"),
      p(
        "The editor supports markdown shortcuts as you type: # for headings, " +
          "- for bullets, [] for task lists, > for quotes, and ``` for code blocks. " +
          "If you\u2019d write it in markdown, it works here."
      ),
      bullets(
        "/: Open the slash menu to insert blocks",
        "Cmd+B / Cmd+I / Cmd+U: Bold / italic / underline",
        "Cmd+Shift+K: Insert or edit a link",
        "Cmd+F: Find in the current page",
        "Tab / Shift+Tab: Indent / outdent list items"
      ),
      h3("Calendar"),
      bullets(
        "\u2190 / \u2192: Previous / next week",
        "T: Jump back to today",
        "Drag the bottom edge of a block to resize it",
        "Right-click a block to edit, delete, or skip an occurrence"
      ),
      h3("Tips"),
      bullets(
        "Right-click nearly anything (pages, folders, calendar blocks) for contextual actions",
        "The metadata header at the top of each page edits status, priority, tags, schedule, and recurrence",
        "On Windows and Linux, Cmd becomes Ctrl"
      )
    ),
    folderId: tutorial.id,
    priority: 0,
    status: "not_started",
    subtitle: "The shortcuts and moves worth committing to memory",
    tags: ["tutorial", "reference"],
    title: "Shortcuts & tips",
  });

  // ── Example: a real page with tasks ─────────────────────────────────────

  const example = await createPage({
    content: doc(
      p("Week of March 12. Priorities and action items."),
      h3("This week"),
      tasks(
        { checked: true, text: "Finalize Q1 report draft" },
        { checked: false, text: "Schedule 1:1 with Jamie" },
        { checked: false, text: "Review pull requests from last week" }
      ),
      h3("Notes"),
      p(
        "Product sync moved to Thursday. Check the shared doc for the updated roadmap before the meeting."
      )
    ),
    folderId: tutorial.id,
    priority: 3,
    status: "not_started",
    subtitle: "What a real page looks like: note and tasks together, scheduled on the calendar",
    tags: ["example"],
    title: "Example: weekly planning",
  });
  await adapter.createPageSchedule({
    pageId: example.id,
    scheduledEnd: dayTime(1, 10),
    scheduledStart: dayTime(1, 9),
    timezone: "America/Los_Angeles",
  });

  return { folderId: tutorial.id, welcomePageId: welcome.id };
}

// ── Tiptap JSON helpers (browser-safe, no Node deps) ───────────────────────

type Node = Record<string, unknown>;

function doc(...nodes: Node[]): string {
  return JSON.stringify({ content: nodes, type: "doc" });
}

function p(text: string): Node {
  return { content: [{ text, type: "text" }], type: "paragraph" };
}

function h3(text: string): Node {
  return { attrs: { level: 3 }, content: [{ text, type: "text" }], type: "heading" };
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

function tasks(...items: { text: string; checked: boolean }[]): Node {
  return {
    content: items.map(({ checked, text }) => ({
      attrs: { checked },
      content: [p(text)],
      type: "taskItem",
    })),
    type: "taskList",
  };
}
