// Marketing seed — generic, relatable data for hero recordings.
// Called automatically when VITE_SEED=marketing is set.

import type { StorageAdapter } from "@pikos/core";
import type { MockStorageAdapter } from "@pikos/core";
import { addDays } from "date-fns";

export async function seedMarketing(adapter: StorageAdapter): Promise<void> {
  // Clear any existing data to prevent duplicates on re-mount
  (adapter as MockStorageAdapter).clear();
  // Use the current date (which may be mocked by Playwright's clock)
  const now = new Date();

  function day(offset: number): string {
    return addDays(now, offset).toISOString().slice(0, 10);
  }

  // Day aliases (Mon=0 when clock is mocked to Monday)
  const mon = day(0);
  const tue = day(1);
  const wed = day(2);
  const thu = day(3);
  const fri = day(4);

  const work = await adapter.createFolder({ color: "#6366f1", name: "Work", parentId: null });
  const personal = await adapter.createFolder({
    color: "#10b981",
    name: "Personal",
    parentId: null,
  });
  const notes = await adapter.createFolder({ color: "#f59e0b", name: "Notes", parentId: null });

  // ═══════════════════════════════════════════════════════════════════════════
  // SCHEDULE MAP — knowledge-worker week, no overlaps.
  //
  // The hero recording (e2e/record-hero.spec.ts) interacts with three pages:
  //   • "Roadmap planning" Mon 9–11am — prepopulated 2-hour block with rich
  //     content (the just-ended planning meeting). The demo opens its popover
  //     and marks it done.
  //   • "Send recap" — created live during the recording by clicking the Tue
  //     10am calendar slot. The natural follow-up to the planning meeting.
  //   • "Draft: search relevance" — dragged from the inbox list onto Thu 9am,
  //     resized to a 1-hour block, then double-clicked open and edited inline.
  // Tue 10am and Thu 9am are intentionally empty so the recorded interactions
  // read cleanly.
  //
  //  MON           TUE         WED         THU         FRI
  //  ────────────  ──────────  ──────────  ──────────  ──────────
  //  [all-day Thu: Dentist appt]
  //
  //  9:00   Roadmap     Standup             (Draft       Deep work
  //  10:00  planning    (Send recap         — dragged)   block
  //  11:00              — recorded)         1:1 w/ Sam
  //  12:00
  //  1:00   Reply
  //  2:00               Design     Focus               Budget review
  //  3:00               review     time (RFC)
  //  4:00                          Sprint demo
  //  5:00                          Evening walk
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Work — Mon ───────────────────────────────────────────────────────────

  // The star page. Rich content reads like a real planning doc so anyone who
  // downloads the app sees substantive seed data, not lorem ipsum.
  const roadmap = await adapter.createPage({
    content: doc(
      h2("Roadmap planning — notes"),
      p(
        "Two-hour kickoff with eng leads and design. Goal: pick the three bets we commit to this quarter and the risks that could sink them."
      ),
      h3("Themes"),
      bullets(
        "Reduce time-to-first-value for new users",
        "Pay down platform debt in the search and sync paths",
        "Open up the API for power users and integrations"
      ),
      h3("Bets"),
      bullets(
        "Onboarding v2 — Maya leads, eng support from Jamie",
        "Search relevance overhaul — Sam owns; proposal due next week",
        "Public API beta — Priya scopes, target invite list by EOM"
      ),
      h3("Risks"),
      bullets(
        "Sam is out the last two weeks of Q2 — search bet has key-person risk",
        "API beta depends on auth refactor that hasn't started"
      ),
      h3("Decisions"),
      bullets(
        "Drop the editor extensions bet — defer to Q3",
        "Move weekly demo from Friday to Wednesday so async folks see it"
      ),
      h3("Next steps"),
      bullets(
        "I send the recap with decisions and owners — by Tuesday EOD",
        "Maya schedules the onboarding design review for next week"
      )
    ),
    folderId: work.id,
    priority: 1,
    status: "not_started",
    subtitle: "Pick the three bets and the risks that could sink them",
    tags: ["planning"],
    title: "Roadmap planning",
  });
  await adapter.createPageSchedule({
    pageId: roadmap.id,
    scheduledEnd: `${mon}T11:00:00`,
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

  // ── Work — Tue ───────────────────────────────────────────────────────────

  const standup = await adapter.createPage({
    content: doc(
      h3("What I'm working on"),
      bullets(
        "Roadmap recap going out today",
        "Reviewing Sam's search proposal before Friday",
        "Unblocking Jamie on the onboarding spec"
      ),
      h3("Blockers"),
      p("None this week.")
    ),
    folderId: work.id,
    priority: 2,
    status: "not_started",
    subtitle: "Quick async post in #team",
    tags: ["meetings"],
    title: "Team standup",
  });
  await adapter.createPageSchedule({
    pageId: standup.id,
    scheduledEnd: `${tue}T09:30:00`,
    scheduledStart: `${tue}T09:00:00`,
    timezone: "America/Los_Angeles",
  });

  const designReview = await adapter.createPage({
    content: doc(
      p(
        "Walk through Maya's onboarding v2 mocks. Focus: empty states and the first-page experience."
      ),
      h3("Things to flag"),
      bullets(
        "The empty Today view still feels punishing",
        "Hover affordances on the calendar blocks need work",
        "Settings nav is buried"
      )
    ),
    folderId: work.id,
    priority: 2,
    status: "not_started",
    subtitle: "Onboarding v2 mocks — Maya driving",
    tags: ["design"],
    title: "Design review — onboarding",
  });
  await adapter.createPageSchedule({
    pageId: designReview.id,
    scheduledEnd: `${tue}T15:00:00`,
    scheduledStart: `${tue}T14:00:00`,
    timezone: "America/Los_Angeles",
  });

  // ── Work — Wed ───────────────────────────────────────────────────────────

  const focus = await adapter.createPage({
    content: doc(
      p("Block this for the search relevance proposal. No meetings, no Slack."),
      h3("Sections to draft"),
      bullets(
        "Problem statement — what's broken about today's ranking",
        "Options considered — BM25 tweaks vs. learning-to-rank",
        "Decision criteria and rough cost",
        "Migration plan — index rebuild risk"
      )
    ),
    folderId: work.id,
    priority: 1,
    status: "not_started",
    subtitle: "Search relevance proposal — get a v0 done",
    tags: ["deep work"],
    title: "Focus time — search proposal",
  });
  await adapter.createPageSchedule({
    pageId: focus.id,
    scheduledEnd: `${wed}T15:30:00`,
    scheduledStart: `${wed}T14:00:00`,
    timezone: "America/Los_Angeles",
  });

  const sprintDemo = await adapter.createPage({
    content: doc(
      h3("Demoing this week"),
      bullets(
        "Onboarding v2 — first-run state behind a flag",
        "Search relevance — early A/B results",
        "Calendar drag-to-schedule polish"
      ),
      p("Keep each demo under 3 minutes. Questions in the thread, not live.")
    ),
    folderId: work.id,
    priority: 2,
    status: "not_started",
    subtitle: "Weekly demo — async-friendly",
    tags: ["meetings"],
    title: "Sprint demo",
  });
  await adapter.createPageSchedule({
    pageId: sprintDemo.id,
    scheduledEnd: `${wed}T16:30:00`,
    scheduledStart: `${wed}T16:00:00`,
    timezone: "America/Los_Angeles",
  });

  // ── Work — Thu ───────────────────────────────────────────────────────────

  const oneOnOne = await adapter.createPage({
    content: doc(
      h3("Topics"),
      bullets(
        "Q2 priorities — is search the right second bet?",
        "Sam's PTO at end of quarter — coverage plan",
        "Career conversation — staff promo timeline"
      ),
      h3("From last time"),
      bullets("Follow up on the design crit feedback", "Confirm the eng candidate offer is out")
    ),
    folderId: work.id,
    priority: 2,
    status: "not_started",
    subtitle: "Weekly with manager",
    tags: ["meetings"],
    title: "1:1 with Sam",
  });
  await adapter.createPageSchedule({
    pageId: oneOnOne.id,
    scheduledEnd: `${thu}T11:30:00`,
    scheduledStart: `${thu}T11:00:00`,
    timezone: "America/Los_Angeles",
  });

  // ── Work — Fri ───────────────────────────────────────────────────────────

  const deepWork = await adapter.createPage({
    content: doc(
      p("Final push on the onboarding doc. Aim to get the walkthrough and FAQ sections done.")
    ),
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

  const budget = await adapter.createPage({
    content: doc(
      h2("Q1 budget actuals"),
      p("Walk through team spend vs. plan. Flag anything trending over for Q2 reforecast."),
      h3("Categories to review"),
      bullets(
        "Cloud infra — 8% over, mostly egress",
        "Vendor tools — under, after consolidating two products",
        "Headcount — on plan",
        "Travel — under (a lot of conferences slipped)"
      )
    ),
    folderId: work.id,
    priority: 2,
    status: "not_started",
    subtitle: "Q1 actuals vs. plan — flag what's drifting",
    tags: ["finance"],
    title: "Budget review — Q1 actuals",
  });
  await adapter.createPageSchedule({
    pageId: budget.id,
    scheduledEnd: `${fri}T14:45:00`,
    scheduledStart: `${fri}T14:00:00`,
    timezone: "America/Los_Angeles",
  });

  // ── Personal ─────────────────────────────────────────────────────────────

  const walk = await adapter.createPage({
    content: doc(p("Just walk. Clear the head after a long day.")),
    folderId: personal.id,
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

  const dentist = await adapter.createPage({
    content: doc(p("Address is in the calendar invite. Arrive 10 minutes early.")),
    folderId: personal.id,
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

  // ── Notes — unscheduled reference pages ─────────────────────────────────

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
    folderId: notes.id,
    priority: 4,
    status: "not_started",
    subtitle: "Books people have mentioned recently",
    tags: ["reading"],
    title: "Books to read",
  });

  await adapter.createPage({
    content: doc(
      bullets(
        "Better at writing — design docs, proposals, postmortems",
        "More fluent in SQL window functions",
        "Get comfortable enough with Rust to read the codebase"
      )
    ),
    folderId: notes.id,
    priority: 4,
    status: "not_started",
    subtitle: "Skills worth investing in this year",
    tags: ["growth"],
    title: "Things to learn this year",
  });

  // ── Inbox — unscheduled work items ──────────────────────────────────────

  await adapter.createPage({
    content: doc(
      p("First pass before Sam's review on Friday. Focus on the migration risk section.")
    ),
    folderId: null,
    priority: 2,
    status: "not_started",
    subtitle: "First pass before Sam reviews",
    tags: ["writing"],
    title: "Draft: search relevance",
  });

  await adapter.createPage({
    content: doc(p("Send a follow-up if we haven't heard back by Wednesday.")),
    folderId: null,
    priority: 3,
    status: "not_started",
    subtitle: "Final round Wed",
    tags: ["hiring"],
    title: "Review candidate",
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
