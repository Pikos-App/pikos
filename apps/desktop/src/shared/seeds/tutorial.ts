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
  // Named "Start here" (not "Tutorial") so it reads as something to work
  // through and delete, not a folder to keep around.

  const tutorial = await adapter.createFolder({
    color: "#6366f1",
    name: "Start here",
    parentId: null,
  });

  // ── Welcome page (marker + landing) ─────────────────────────────────────
  // Uses bullets (not a task list) for the try-these items so the checkboxes
  // don\u2019t visually imply pages can be nested inside other pages.

  const welcome = await createPage({
    content: doc(
      p(
        "Pikos puts your notes, your tasks, and your calendar in one app. " +
          "No more bouncing between three that don\u2019t know about each other."
      ),
      p(
        "Every page is something you can write in, schedule, and check off when it\u2019s done. " +
          "Everything lives on your device. No account, no cloud, nothing tracked."
      ),
      h3("A few things to try"),
      bullets(
        "Click the New Page button above the page list (or press Cmd+N)",
        "Click Calendar at the top of the right pane (or press Cmd+Shift+C)",
        "Drag a page from the list onto a time slot to schedule it",
        "Drag a page onto a folder in the sidebar to move it",
        "Tick the checkbox beside a page to mark it done"
      ),
      h3("When you\u2019re done"),
      p(
        "Right-click the \u201cStart here\u201d folder in the sidebar and choose Delete. These pages will go with it. " +
          "If you delete something by accident, look for the Undo toast at the bottom of the screen."
      )
    ),
    folderId: tutorial.id,
    priority: 0,
    status: "not_started",
    subtitle: "Notes, tasks, and calendar in one app, on your device.",
    tags: ["tutorial"],
    title: "Welcome to Pikos \ud83d\udc4b",
  });

  // ── Core workflow: quick add → schedule → complete ──────────────────────

  const workflow = await createPage({
    content: doc(
      p("Most of Pikos is three steps: add, schedule, complete."),
      h3("1. Add"),
      p(
        "Click New Page (or press Cmd+N) and type what you want to do. " +
          "Pikos picks out the date, time, and duration from plain English:"
      ),
      bullets(
        "go for a run tomorrow 7am for 30m",
        "call dentist monday 9am",
        "book club thursday 7pm"
      ),
      p(
        "You can also pick a folder, add tags, or set priority from the menus that appear \u2014 " +
          "no need to learn any syntax."
      ),
      h3("2. Schedule"),
      p(
        "Put something on the calendar by dragging it from the list, or by clicking an empty slot and typing. For all-day things, use the strip at the top of the calendar instead of a time slot."
      ),
      h3("3. Complete"),
      p(
        "Tick the checkbox next to the page, in the list or on the calendar. " +
          "Recurring pages jump to their next date instead of closing the whole series."
      )
    ),
    folderId: tutorial.id,
    priority: 0,
    status: "not_started",
    subtitle: "Add, schedule, complete",
    tags: ["tutorial"],
    title: "Quick add, schedule, complete",
  });
  await adapter.createPageSchedule({
    pageId: workflow.id,
    scheduledEnd: dayTime(0, 15, 30),
    scheduledStart: dayTime(0, 15),
    timezone: "America/Los_Angeles",
  });

  // ── Example: a real page with tasks ─────────────────────────────────────
  // Sits just after the core-loop page so the reader sees what a finished
  // page feels like before the power-features tour. Uses a task list inside
  // the note body \u2014 the reader sees that inline task items live inside a
  // single page, they\u2019re formatting, not separate pages.

  const example = await createPage({
    content: doc(
      p("A few things I want to get to this week, plus notes to myself."),
      h3("This week"),
      tasks(
        { checked: true, text: "Pick up groceries (milk, bread, eggs)" },
        { checked: false, text: "Go for a long run on Wednesday" },
        { checked: false, text: "Call mom about the weekend" }
      ),
      h3("Notes"),
      p(
        "Book club moved to Thursday. Finish chapter 5 before we meet, and grab a bottle of wine on the way."
      )
    ),
    folderId: tutorial.id,
    priority: 3,
    status: "not_started",
    subtitle:
      "What a real page can look like: writing and a little to-do list, scheduled on the calendar",
    tags: ["example"],
    title: "Example: weekly planning",
  });
  await adapter.createPageSchedule({
    pageId: example.id,
    scheduledEnd: dayTime(1, 10),
    scheduledStart: dayTime(1, 9),
    timezone: "America/Los_Angeles",
  });

  // ── Going further: power features ───────────────────────────────────────

  await createPage({
    content: doc(
      p("A few things worth knowing about once the basics feel natural."),
      h3("Repeats"),
      p(
        "Type something like \u201cyoga weekdays 7am\u201d when adding, or pick a pattern from the repeat button on any page. " +
          "Need to skip one? Click it on the calendar and choose Skip in the popover."
      ),
      h3("Reminders"),
      p(
        "Pikos nudges you 10 minutes before a scheduled page starts, out of the box. " +
          "Change the lead time in Settings \u2192 Notifications, or override it per page."
      ),
      h3("Daily summary"),
      p(
        "You\u2019ll also get one notification each morning with today\u2019s plan and anything overdue. " +
          "Change the time, turn it off, or set quiet hours in Settings \u2192 Notifications."
      )
    ),
    folderId: tutorial.id,
    priority: 0,
    status: "not_started",
    subtitle: "Repeats, reminders, and the morning summary",
    tags: ["tutorial"],
    title: "Going further",
  });

  // ── Keyboard shortcuts ──────────────────────────────────────────────────

  await createPage({
    content: doc(
      p(
        "You don\u2019t have to memorize any of these \u2014 everything\u2019s reachable with the mouse. " +
          "But if you like shortcuts, these are the ones worth learning first."
      ),
      h3("Moving around"),
      bullets(
        "Cmd+N: New page",
        "Cmd+K: Search",
        "Cmd+Shift+C: Flip between page and calendar",
        "Cmd+\\: Show or hide the sidebar",
        "Cmd+1\u20139: Jump to a folder by position",
        "Cmd+,: Open settings",
        "\u2191 / \u2193: Move through the list"
      ),
      h3("Writing"),
      p(
        "Markdown works as you type: # for headings, - for bullets, > for quotes, and ``` for code."
      ),
      bullets(
        "/: Open the block menu",
        "Cmd+B, Cmd+I, Cmd+U: Bold, italic, underline",
        "Cmd+Shift+K: Add a link",
        "Cmd+F: Find in the page",
        "Tab, Shift+Tab: Indent or outdent a list"
      ),
      h3("Calendar"),
      bullets(
        "\u2190 / \u2192: Previous or next week",
        "T: Jump back to today",
        "Drag the bottom edge of an event to change its length"
      ),
      p("The full list (and a way to change any of them) is in Settings \u2192 Shortcuts.")
    ),
    folderId: tutorial.id,
    priority: 0,
    status: "not_started",
    subtitle: "A reference for when you want one. You don\u2019t need these to use the app.",
    tags: ["tutorial", "reference"],
    title: "Shortcuts & tips",
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
