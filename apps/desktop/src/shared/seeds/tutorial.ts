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
      h2("Welcome to Pikos \ud83d\udc4b"),
      p(
        "Pikos combines notes, tasks, and a calendar into one app. " +
          "Every page is both a note and a task \u2014 no mode-switching required."
      ),
      h3("Try these to get started"),
      tasks(
        { checked: false, text: "Press Cmd+N to quick-add a new page" },
        { checked: false, text: "Open the calendar with Cmd+Shift+C" },
        { checked: false, text: "Drag this page onto a calendar time slot to schedule it" },
        { checked: false, text: "Click the status circle in the page list to mark a page done" },
        { checked: false, text: "Press Cmd+P to search across all your pages" }
      ),
      h3("When you\u2019re done exploring"),
      p(
        "Right-click the Tutorial folder in the sidebar and delete it. " +
          "Any pages you haven\u2019t deleted will move to your Inbox. " +
          "Deleted a page by mistake? An undo toast appears \u2014 just click it."
      )
    ),
    folderId: tutorial.id,
    priority: 0,
    status: "not_started",
    subtitle: "Your notes, tasks, and calendar \u2014 one app, on your device.",
    tags: ["tutorial"],
    title: "Welcome to Pikos \ud83d\udc4b",
  });

  // ── Core workflow: quick add → schedule → complete ──────────────────────

  const workflow = await createPage({
    content: doc(
      h2("The core workflow"),
      h3("1. Quick add (Cmd+N)"),
      p("Press Cmd+N from anywhere. Type a title with optional tokens:"),
      bullets(
        "review slides @tomorrow 2pm for 1h",
        "call dentist @monday 9am !high",
        "grocery list #personal ~Errands"
      ),
      p("Tokens: @date, time, for duration, #tag, ~Folder, !priority."),
      h3("2. Schedule"),
      bullets(
        "Drag a page from the list onto a calendar time slot",
        "Click an empty time slot on the calendar to create a page there",
        "Or set the date in the page metadata header"
      ),
      h3("3. Complete"),
      bullets(
        "Click the status circle in the page list",
        "Click the status circle in the page editor",
        "Hover a calendar block and click the checkmark"
      ),
      p("Status cycles: \u25CB Not started \u2192 \u25D1 In progress \u2192 \u2713 Done.")
    ),
    folderId: tutorial.id,
    priority: 0,
    status: "not_started",
    subtitle: "The core loop \u2014 create a page, put it on the calendar, mark it done",
    tags: ["tutorial"],
    title: "Quick add, schedule, complete",
  });
  await adapter.createPageSchedule({
    pageId: workflow.id,
    scheduledEnd: dayTime(0, 15, 30),
    scheduledStart: dayTime(0, 15),
    timezone: "America/Los_Angeles",
  });

  // ── Keyboard shortcuts ──────────────────────────────────────────────────

  await createPage({
    content: doc(
      h2("Keyboard shortcuts"),
      h3("Navigation"),
      bullets(
        "Cmd+N \u2014 Quick add a new page",
        "Cmd+P \u2014 Search all pages",
        "Cmd+Shift+C \u2014 Toggle between editor and calendar",
        "Cmd+\\ \u2014 Toggle sidebar",
        "J / K \u2014 Move up / down in the page list",
        "Enter \u2014 Open selected page"
      ),
      h3("Editor"),
      bullets(
        "Cmd+B / I / U \u2014 Bold / italic / underline",
        "Tab / Shift+Tab \u2014 Indent / outdent lists",
        "Esc \u2014 Return focus to the page list"
      ),
      h3("Managing pages"),
      bullets(
        "Right-click a page to delete it",
        "On the calendar, click a block then the trash icon to remove it",
        "Deleting shows an undo toast \u2014 click to recover"
      )
    ),
    folderId: tutorial.id,
    priority: 0,
    status: "not_started",
    subtitle: "Everything you need, no mouse required",
    tags: ["tutorial", "reference"],
    title: "Keyboard shortcuts",
  });

  // ── Example: a real page with tasks ─────────────────────────────────────

  const example = await createPage({
    content: doc(
      h2("Weekly planning"),
      p("Week of March 12 \u2014 priorities and action items."),
      h3("This week"),
      tasks(
        { checked: true, text: "Finalize Q1 report draft" },
        { checked: false, text: "Schedule 1:1 with Jamie" },
        { checked: false, text: "Review pull requests from last week" }
      ),
      h3("Notes"),
      p("Product sync moved to Thursday. Check shared doc for updated roadmap before the meeting.")
    ),
    folderId: tutorial.id,
    priority: 3,
    status: "in_progress",
    subtitle: "This is what a real page looks like \u2014 note + tasks in one place",
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

function h2(text: string): Node {
  return { attrs: { level: 2 }, content: [{ text, type: "text" }], type: "heading" };
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
