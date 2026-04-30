// Tutorial seed — onboarding data seeded on first workspace creation.
// Teaches Pikos concepts through real pages that showcase key features.
// Called automatically in selectWorkspace() for new workspaces.

import { extractText } from "@pikos/core";
import type { StorageAdapter } from "@pikos/core";
import { addDays, addHours, format, getHours, isSameDay, set, startOfHour } from "date-fns";

const MARKER = "Welcome to Pikos";

/** Check if tutorial data was already seeded (idempotency guard). */
async function alreadySeeded(adapter: StorageAdapter): Promise<boolean> {
  const { results } = await adapter.searchPages(MARKER);
  return results.some((r) => r.title.startsWith(MARKER));
}

/** "Cmd" on Mac, "Ctrl" elsewhere. Detected at seed time so the copy matches the user's platform. */
function modKey(): string {
  if (typeof navigator === "undefined") return "Cmd";
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Cmd" : "Ctrl";
}

/**
 * Pick the next hour boundary at least ~1h from now. If that lands after 21:00,
 * fall back to 09:00 the next day so the demo block is never crammed into the
 * late evening.
 */
function pickFutureSlot(now: Date): Date {
  const buffered = addHours(startOfHour(now), 2);
  if (!isSameDay(buffered, now) || getHours(buffered) > 21) {
    return set(addDays(now, 1), { hours: 9, milliseconds: 0, minutes: 0, seconds: 0 });
  }
  return buffered;
}

export async function seedTutorial(
  adapter: StorageAdapter
): Promise<{ welcomePageId: string; folderId: string } | null> {
  if (await alreadySeeded(adapter)) return null;

  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const MOD = modKey();

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
  // Scheduled today so the user sees it on the calendar — a small live demo
  // of the "every page is also a calendar event" idea.

  const welcomeStart = pickFutureSlot(now);
  const welcomeEnd = addHours(welcomeStart, 1);

  const welcome = await createPage({
    content: doc(
      p(
        "Every page is something you can write in, schedule, and check off when it’s done. " +
          "Everything stays on your device. No account, no cloud, nothing tracked."
      ),
      h3("A few things to try"),
      bullets(
        `Click the New Page button above the page list (or press ${MOD}+N)`,
        `Click Calendar at the top of the right pane (or press ${MOD}+Shift+C)`,
        "Drag a page from the list onto a time slot to schedule it",
        `Press ${MOD}+K to search across every page — by content, not just titles`,
        "Tick the checkbox beside a page to mark it done"
      ),
      h3("When you’re done"),
      p(
        "Right-click the “Start here” folder in the sidebar and choose Delete. These pages will go with it. " +
          "If you delete something by accident, look for the Undo toast at the bottom of the screen."
      )
    ),
    folderId: tutorial.id,
    priority: 0,
    status: "not_started",
    subtitle: "Notes, tasks, and calendar in one app, stored on your device.",
    tags: ["tutorial"],
    title: "Welcome to Pikos 👋",
  });
  await adapter.createPageSchedule({
    pageId: welcome.id,
    scheduledEnd: format(welcomeEnd, "yyyy-MM-dd'T'HH:mm:ss"),
    scheduledStart: format(welcomeStart, "yyyy-MM-dd'T'HH:mm:ss"),
    timezone: tz,
  });

  // ── How it works: add → schedule → complete + repeats + reminders ───────

  const howStart = set(addDays(now, 1), { hours: 9, milliseconds: 0, minutes: 0, seconds: 0 });
  const howEnd = addHours(howStart, 1);

  const howItWorks = await createPage({
    content: doc(
      p("Most of Pikos is three steps: add, schedule, complete."),
      h3("1. Add"),
      p(
        `Click New Page (or press ${MOD}+N) and type what you want to do. ` +
          "Pikos picks out the date, time, and duration from plain English:"
      ),
      bullets(
        "go for a run tomorrow 7am for 30m",
        "call dentist monday 9am",
        "book club thursday 7pm"
      ),
      p("You can also pick a folder, add tags, or set priority from the menus that appear."),
      h3("2. Schedule"),
      p(
        "Put something on the calendar by dragging it from the list, or by clicking an empty slot and typing. For all-day things, use the strip at the top of the calendar instead of a time slot."
      ),
      h3("3. Complete"),
      p("Tick the checkbox in the list, on the page, or on the calendar."),
      h3("Repeats"),
      p(
        "Type something like “team meeting every monday at 9am” when adding, or pick a pattern from the repeat button on any page. " +
          "Need to skip one? Click it on the calendar and choose “Skip this occurrence” in the popover."
      ),
      h3("Reminders"),
      p(
        "Pikos nudges you 10 minutes before a scheduled page starts, out of the box. " +
          "Change the lead time, override it per page, or turn reminders off entirely in Settings → Notifications."
      )
    ),
    folderId: tutorial.id,
    priority: 0,
    status: "not_started",
    subtitle: "Type what you want, drop it on the calendar, tick it off.",
    tags: ["tutorial"],
    title: "How it works",
  });
  await adapter.createPageSchedule({
    pageId: howItWorks.id,
    scheduledEnd: format(howEnd, "yyyy-MM-dd'T'HH:mm:ss"),
    scheduledStart: format(howStart, "yyyy-MM-dd'T'HH:mm:ss"),
    timezone: tz,
  });

  // ── Keyboard shortcuts ──────────────────────────────────────────────────

  await createPage({
    content: doc(
      p(
        "You don’t have to memorize any of these — everything’s reachable with the mouse. " +
          "But if you like shortcuts, these are the ones worth learning first."
      ),
      h3("Moving around"),
      bullets(
        `${MOD}+N: New page`,
        `${MOD}+W: Close the current page`,
        `${MOD}+K: Search`,
        `${MOD}+Shift+C: Flip between page and calendar`,
        `${MOD}+\\: Show or hide the sidebar`,
        `${MOD}+1–9: Jump to a folder by position`,
        `${MOD}+,: Open settings`
      ),
      h3("Writing"),
      p(
        "Markdown works as you type: # for headings, - for bullets, > for quotes, and ``` for code."
      ),
      bullets(
        "/: Open the block menu",
        `${MOD}+B, ${MOD}+I, ${MOD}+U: Bold, italic, underline`,
        `${MOD}+Shift+K: Add a link`,
        `${MOD}+F: Find in the page`,
        "Tab, Shift+Tab: Indent or outdent a list"
      ),
      h3("Calendar"),
      bullets(
        "← / →: Previous or next week",
        "T: Jump back to today",
        "Click an empty slot to create a page (drag across slots to set its duration)",
        "Drag the bottom edge of a page to change its duration"
      ),
      p("The full list (and a way to change any of them) is in Settings → Shortcuts.")
    ),
    folderId: tutorial.id,
    priority: 0,
    status: "not_started",
    subtitle: "A reference for when you want one. You don’t need these to use the app.",
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
