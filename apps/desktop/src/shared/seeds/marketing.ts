// Marketing seed — generic, relatable data for hero recordings.
// Called automatically when VITE_SEED=marketing is set.

import type { StorageAdapter } from "@pikos/core";
import type { MockStorageAdapter } from "@pikos/core";

export async function seedMarketing(adapter: StorageAdapter): Promise<void> {
  // Clear any existing data to prevent duplicates on re-mount
  (adapter as MockStorageAdapter).clear();
  // Use the current date (which may be mocked by Playwright's clock)
  const now = new Date();

  function day(offset: number): string {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  }

  // Day aliases (Mon=0 when clock is mocked to Monday)
  const mon = day(0);
  const tue = day(1);
  const wed = day(2);
  const thu = day(3);
  const fri = day(4);
  const sat = day(5);

  // ── Folders ──────────────────────────────────────────────────────────────

  const home = await adapter.createFolder({ color: "#10b981", name: "Home", parentId: null });
  const work = await adapter.createFolder({ color: "#6366f1", name: "Work", parentId: null });
  const health = await adapter.createFolder({ color: "#ec4899", name: "Health", parentId: null });
  const ideas = await adapter.createFolder({ color: "#f59e0b", name: "Ideas", parentId: null });

  // ═══════════════════════════════════════════════════════════════════════════
  // SCHEDULE MAP — every timed event has its own unique slot, no overlaps.
  //
  //  MON        TUE        WED        THU        FRI        SAT
  //  ─────────  ─────────  ─────────  ─────────  ─────────  ─────────
  //  [all-day: Library books due]     [all-day: Dentist appt]
  //
  //  9:00  Goals review    Team update             Deep work
  //  10:00                                                    Farmers mkt
  //  11:00                            Grocery run
  //  12:00
  //  1:00  Reply to emails
  //  2:00                  Focus time              Budget rev
  //  3:00                                                     (drag target)
  //  4:00                             Meal prep
  //  5:00                  Evening walk
  //  6:00
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Work ─────────────────────────────────────────────────────────────────

  const goals = await adapter.createPage({
    content: doc(
      h2("Q1 goals — how did it go?"),
      p(
        "Three main goals this quarter: finish the onboarding project, reduce support tickets by 20%, and document the main workflows. Two out of three are done."
      ),
      h3("What worked"),
      bullets(
        "Blocking off Wednesday mornings for deep work",
        "Weekly check-ins kept things on track",
        "Writing things down instead of keeping them in my head"
      ),
      h3("Q2 priorities"),
      p(
        "Focus on the new onboarding flow, continue the support ticket work, and start the knowledge base project."
      )
    ),
    folderId: work.id,
    priority: 1,
    status: "in_progress",
    subtitle: "Look back at Q1 progress and plan for Q2",
    tags: ["planning"],
    title: "Quarterly goals review",
  });
  await adapter.createPageSchedule({
    pageId: goals.id,
    scheduledEnd: `${mon}T10:00:00`,
    scheduledStart: `${mon}T09:00:00`,
    timezone: "America/Los_Angeles",
  });

  const emails = await adapter.createPage({
    content: doc(
      p("A few threads that need a response. Nothing urgent but don't let them pile up.")
    ),
    folderId: work.id,
    priority: 3,
    status: "not_started",
    subtitle: "Clear the inbox before lunch",
    tags: ["admin"],
    title: "Reply to emails",
  });
  await adapter.createPageSchedule({
    pageId: emails.id,
    scheduledEnd: `${mon}T13:30:00`,
    scheduledStart: `${mon}T13:00:00`,
    timezone: "America/Los_Angeles",
  });

  const update = await adapter.createPage({
    content: doc(
      h2("Team update — this week"),
      bullets(
        "Onboarding project: final review stage",
        "Support tickets: trending down, new FAQ page helped",
        "Knowledge base: outline done, starting first drafts next week"
      ),
      p("Keep it short — 5 minutes max.")
    ),
    folderId: work.id,
    priority: 2,
    status: "not_started",
    subtitle: "Quick sync for the all-hands",
    tags: ["meetings"],
    title: "Team update",
  });
  await adapter.createPageSchedule({
    pageId: update.id,
    scheduledEnd: `${tue}T09:30:00`,
    scheduledStart: `${tue}T09:00:00`,
    timezone: "America/Los_Angeles",
  });

  const focus = await adapter.createPage({
    content: doc(
      p("Block this time to make progress on the project proposal. Close everything else.")
    ),
    folderId: work.id,
    priority: 2,
    status: "not_started",
    subtitle: "No meetings, no Slack — just write",
    tags: ["deep work"],
    title: "Focus time — project draft",
  });
  await adapter.createPageSchedule({
    pageId: focus.id,
    scheduledEnd: `${wed}T15:30:00`,
    scheduledStart: `${wed}T14:00:00`,
    timezone: "America/Los_Angeles",
  });

  const deepWork = await adapter.createPage({
    content: doc(p("Final push on the docs. Aim to get the walkthrough and FAQ sections done.")),
    folderId: work.id,
    priority: 1,
    status: "not_started",
    subtitle: "Finish the onboarding documentation",
    tags: ["deep work"],
    title: "Deep work block",
  });
  await adapter.createPageSchedule({
    pageId: deepWork.id,
    scheduledEnd: `${fri}T10:30:00`,
    scheduledStart: `${fri}T09:00:00`,
    timezone: "America/Los_Angeles",
  });

  // ── Home ─────────────────────────────────────────────────────────────────

  const grocery = await adapter.createPage({
    content: doc(
      h2("Grocery list"),
      bullets(
        "Eggs, milk, bread",
        "Chicken thighs, ground turkey",
        "Spinach, bell peppers, onions",
        "Rice, pasta, canned tomatoes",
        "Bananas, apples, frozen berries"
      )
    ),
    folderId: home.id,
    priority: 3,
    status: "not_started",
    subtitle: "Restock basics plus a few things for the weekend",
    tags: ["errands"],
    title: "Grocery run",
  });
  await adapter.createPageSchedule({
    pageId: grocery.id,
    scheduledEnd: `${thu}T11:45:00`,
    scheduledStart: `${thu}T11:00:00`,
    timezone: "America/Los_Angeles",
  });

  const budget = await adapter.createPage({
    content: doc(
      h2("March budget check-in"),
      p(
        "Halfway through the month. Groceries are on track but eating out has been higher than planned."
      ),
      h3("Categories to review"),
      bullets(
        "Groceries — on budget",
        "Dining out — over by about $60",
        "Subscriptions — cancel the ones not being used",
        "Gas — slightly under"
      )
    ),
    folderId: home.id,
    priority: 2,
    status: "not_started",
    subtitle: "Check spending against the monthly plan",
    tags: ["finance"],
    title: "Budget review — March",
  });
  await adapter.createPageSchedule({
    pageId: budget.id,
    scheduledEnd: `${fri}T14:45:00`,
    scheduledStart: `${fri}T14:00:00`,
    timezone: "America/Los_Angeles",
  });

  await adapter.createPage({
    content: doc(
      p("Still have a few boxes from the move. Donate what we don't need, toss what's broken.")
    ),
    folderId: home.id,
    priority: 4,
    status: "not_started",
    subtitle: "Sort through boxes from the move",
    tags: ["home"],
    title: "Clean out the garage",
  });

  const farmers = await adapter.createPage({
    content: doc(bullets("Fresh bread", "Seasonal fruit", "Flowers for the table")),
    folderId: home.id,
    priority: 3,
    status: "not_started",
    subtitle: "Saturday morning — bring reusable bags",
    tags: ["errands"],
    title: "Farmers market",
  });
  await adapter.createPageSchedule({
    pageId: farmers.id,
    scheduledEnd: `${sat}T11:00:00`,
    scheduledStart: `${sat}T10:00:00`,
    timezone: "America/Los_Angeles",
  });

  // ── Health ───────────────────────────────────────────────────────────────

  const mealPrep = await adapter.createPage({
    content: doc(
      bullets(
        "Chicken and rice bowls with roasted veggies",
        "Overnight oats — 5 jars for the week",
        "Big pot of soup — freeze half",
        "Cut up fruit and veggies for snacks"
      )
    ),
    folderId: health.id,
    priority: 3,
    status: "not_started",
    subtitle: "Prep lunches for the week",
    tags: ["food"],
    title: "Meal prep",
  });
  await adapter.createPageSchedule({
    pageId: mealPrep.id,
    scheduledEnd: `${thu}T17:00:00`,
    scheduledStart: `${thu}T16:00:00`,
    timezone: "America/Los_Angeles",
  });

  const walk = await adapter.createPage({
    content: doc(p("Just walk. Clear the head after a long day.")),
    folderId: health.id,
    priority: 0,
    status: "not_started",
    subtitle: "30 minutes, no phone",
    tags: ["exercise"],
    title: "Evening walk",
  });
  await adapter.createPageSchedule({
    pageId: walk.id,
    scheduledEnd: `${wed}T17:30:00`,
    scheduledStart: `${wed}T17:00:00`,
    timezone: "America/Los_Angeles",
  });

  // ── All-day events ───────────────────────────────────────────────────────

  const library = await adapter.createPage({
    content: doc(p("Three books in the tote bag by the door.")),
    folderId: null,
    priority: 3,
    status: "not_started",
    subtitle: "Drop off on the way to work",
    tags: ["errands"],
    title: "Library books due",
  });
  await adapter.createPageSchedule({
    pageId: library.id,
    scheduledStart: tue,
  });

  const dentist = await adapter.createPage({
    content: doc(p("Address is in the calendar invite. Arrive 10 minutes early.")),
    folderId: null,
    priority: 2,
    status: "not_started",
    subtitle: "10:30am — confirmed",
    tags: ["health"],
    title: "Dentist appointment",
  });
  await adapter.createPageSchedule({
    pageId: dentist.id,
    scheduledStart: thu,
  });

  // ── Ideas ────────────────────────────────────────────────────────────────

  await adapter.createPage({
    content: doc(
      h2("To read"),
      bullets(
        "Thinking in Systems — a good intro to systems thinking",
        "Four Thousand Weeks — about making peace with limited time",
        "The Creative Act — on the creative process, not just for artists",
        "Range — why generalists triumph in a specialized world"
      )
    ),
    folderId: ideas.id,
    priority: 4,
    status: "not_started",
    subtitle: "Books people have mentioned recently",
    tags: ["reading"],
    title: "Book recommendations",
  });

  await adapter.createPage({
    content: doc(
      bullets(
        "Nice candle or diffuser set",
        "A good cookbook",
        "Portable Bluetooth speaker",
        "Handwritten letter + small gift card"
      )
    ),
    folderId: ideas.id,
    priority: 4,
    status: "not_started",
    subtitle: "Running list so I'm not scrambling last minute",
    tags: ["personal"],
    title: "Gift ideas for birthdays",
  });

  await adapter.createPage({
    content: doc(
      bullets(
        "Basic home repairs — fix things instead of calling someone",
        "Cooking a few new cuisines — start with Thai",
        "Get better at budgeting and personal finance"
      )
    ),
    folderId: ideas.id,
    priority: 4,
    status: "not_started",
    subtitle: "Skills and topics worth exploring",
    tags: ["growth"],
    title: "Things to learn this year",
  });

  // ── Inbox — rich content page for demo editing ───────────────────────────

  const research = await adapter.createPage({
    content: doc(
      h2("Vacation planning"),
      p(
        "Looking for a relaxing long weekend trip — somewhere within a short flight or a few hours' drive. Ideally somewhere with good food, easy walks, and not too crowded."
      ),
      h3("Top options"),
      bullets(
        "Coastal town — seafood, beach walks, maybe a lighthouse",
        "Mountain cabin — hiking trails, campfire, quiet mornings",
        "Lake house — kayaking, reading on the dock, small-town charm"
      ),
      h3("Budget"),
      bullets(
        "Flights or gas: ~$150",
        "Accommodation: $100–150/night, 3 nights max",
        "Food and activities: ~$200",
        "Total target: under $600"
      ),
      h3("Logistics"),
      bullets(
        "Check pet-friendly options if bringing the dog",
        "Pack rain jacket just in case",
        "Book by end of week for best rates"
      ),
      h3("Notes"),
      p(
        "A few friends recommended the coast — apparently there's a great oyster bar near the harbor. Also heard the mountain route has a waterfall hike that's easy enough for a casual day trip."
      ),
      p(
        "Need to double-check if the lake house rental includes a canoe or if we'd need to rent one separately."
      )
    ),
    folderId: null,
    priority: 2,
    status: "in_progress",
    subtitle: "Plan a long weekend getaway",
    tags: ["travel", "planning"],
    title: "Research vacation spots",
  });
  await adapter.createPageSchedule({
    pageId: research.id,
    scheduledStart: mon,
  });

  // ── Inbox — unscheduled ─────────────────────────────────────────────────

  await adapter.createPage({
    content: doc(p("Check if they have anything open next week. Prefer mornings.")),
    folderId: null,
    priority: 2,
    status: "not_started",
    subtitle: "Morning hours are best",
    tags: ["errands"],
    title: "Call the dentist",
  });

  await adapter.createPage({
    content: doc(p("Compare a few options. Don't need unlimited data — mostly on wifi.")),
    folderId: null,
    priority: 3,
    status: "not_started",
    subtitle: "Current plan is too expensive",
    tags: ["finance"],
    title: "Look up new phone plan",
  });
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
