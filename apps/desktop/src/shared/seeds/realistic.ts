// Realistic seed — believable day-to-day life scenario.
// Tests mixed status/priority, Today view, calendar density, folder structure, tags.

import type { StorageAdapter } from "@pikos/core";

const MARKER = "Realistic seed marker";

async function alreadySeeded(adapter: StorageAdapter): Promise<boolean> {
  const { results } = await adapter.searchPages(MARKER);
  return results.some((r) => r.title.includes(MARKER));
}

export async function seedRealistic(adapter: StorageAdapter): Promise<void> {
  if (await alreadySeeded(adapter)) return;

  const now = new Date();

  function daysFrom(n: number): Date {
    const d = new Date(now);
    d.setDate(d.getDate() + n);
    return d;
  }

  function dateStr(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  function timed(d: Date, hour: number, minute = 0): string {
    return `${dateStr(d)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  }

  // ── Folders ──────────────────────────────────────────────────────────────

  const work = await adapter.createFolder({ color: "#3b82f6", name: "Work", parentId: null });
  const projects = await adapter.createFolder({
    color: "#8b5cf6",
    name: "Projects",
    parentId: null,
  });
  const personal = await adapter.createFolder({
    color: "#10b981",
    name: "Personal",
    parentId: null,
  });
  const reading = await adapter.createFolder({
    color: "#f59e0b",
    name: "Reading",
    parentId: null,
  });
  const finance = await adapter.createFolder({
    color: "#ef4444",
    name: "Finance",
    parentId: null,
  });

  // Helper: create page + optional schedule
  type PageSpec = {
    folderId: string | null;
    title: string;
    subtitle?: string;
    content: string;
    status: "not_started" | "in_progress" | "done";
    priority: 0 | 1 | 2 | 3 | 4;
    tags: string[];
    start?: string;
    end?: string;
  };

  async function createWithSchedule(spec: PageSpec) {
    const page = await adapter.createPage({
      content: spec.content,
      folderId: spec.folderId,
      priority: spec.priority,
      status: spec.status,
      subtitle: spec.subtitle ?? null,
      tags: spec.tags,
      title: spec.title,
    });
    if (spec.start) {
      const isTimed = spec.start.includes("T");
      await adapter.createPageSchedule({
        pageId: page.id,
        ...(spec.end !== undefined && { scheduledEnd: spec.end }),
        scheduledStart: spec.start,
        ...(isTimed && { timezone: "America/Los_Angeles" }),
      });
    }
  }

  // ── Marker ─────────────────────────────────────────────────────────────

  await adapter.createPage({
    content: doc(p("Realistic seed marker.")),
    folderId: work.id,
    priority: 0,
    status: "done",
    subtitle: "Delete this page to re-seed",
    tags: [],
    title: MARKER,
  });

  // ── Work ───────────────────────────────────────────────────────────────

  await createWithSchedule({
    content: doc(
      h2("Q1 Roadmap Review"),
      p("Attendees: Sarah, Marcus, Priya"),
      h3("Agenda"),
      bullets("Review shipped features vs plan", "Reprioritize backlog for March", "Set Q2 themes"),
      h3("Action items"),
      tasks(
        { checked: false, text: "Follow up with Sarah on blockers" },
        { checked: false, text: "Update project board" },
        { checked: true, text: "Send recap email" }
      )
    ),
    end: timed(daysFrom(-5), 11),
    folderId: work.id,
    priority: 2,
    start: timed(daysFrom(-5), 10),
    status: "done",
    subtitle: "Align with leadership on milestones before EOQ",
    tags: ["planning", "meeting"],
    title: "Q1 product roadmap review",
  });

  await createWithSchedule({
    content: doc(
      h2("Bug report"),
      p(
        "After DST transition, blocks seeded before the transition display 1h late. " +
          "rrule.js expands using the system TZ offset at expansion time rather than the stored wall-clock."
      ),
      h3("Investigation notes"),
      bullets(
        "Reproduced with seed data",
        "PageSchedule.timezone = 'America/Los_Angeles' \u2014 correct",
        "rrule.js dtstart must include TZ-aware Date object, not naive ISO string"
      ),
      h3("Fix"),
      p(
        "Pass `{ tzid: 'America/Los_Angeles' }` as RRule options. Use luxon for wall-clock expansion."
      )
    ),
    end: timed(daysFrom(0), 16),
    folderId: work.id,
    priority: 1,
    start: timed(daysFrom(0), 14),
    status: "in_progress",
    subtitle: "Blocks shift 1 hour after DST; root cause in rrule expansion",
    tags: ["bug", "calendar", "dev"],
    title: "Fix calendar timezone offset on DST week",
  });

  await createWithSchedule({
    content: doc(
      h2("v0.1.1 Release notes"),
      h3("What's new"),
      bullets(
        "Today smart view",
        "Sidebar collapse",
        "Calendar drag-to-create",
        "Subtitle field on pages",
        "Focus timer built-in"
      ),
      h3("Bug fixes"),
      bullets(
        "Folder sort order persisted after reorder",
        "Page list empty state shown correctly in Inbox",
        "Tag filter now case-insensitive"
      )
    ),
    end: timed(daysFrom(1), 10, 30),
    folderId: work.id,
    priority: 2,
    start: timed(daysFrom(1), 9),
    status: "not_started",
    subtitle: "Changelog covering last 3 sprints",
    tags: ["writing", "release"],
    title: "Write release notes for v0.1.1",
  });

  await createWithSchedule({
    content: doc(
      h2("Design review: metadata header"),
      p("Attendees: Alex, Jordan"),
      h3("Agenda"),
      bullets(
        "Collapsed state: show only title",
        "Expanded state: status, priority, date, tags, subtitle",
        "Cmd+Shift+M toggle",
        "Animation: CSS grid-template-rows 0\u21921fr"
      )
    ),
    end: timed(daysFrom(2), 14),
    folderId: work.id,
    priority: 3,
    start: timed(daysFrom(2), 13),
    status: "not_started",
    subtitle: "Collapsible row with status, priority, date, tags, subtitle",
    tags: ["design", "meeting"],
    title: "Design review \u2014 metadata header",
  });

  await createWithSchedule({
    content: doc(
      h2("Weekly standup"),
      p("Attendees: Alex, Sarah, Marcus, Priya, Jordan"),
      h3("Updates"),
      bullets(
        "Alex: shipped GOO-104, working on GOO-106/107",
        "Sarah: design tokens finalised",
        "Marcus: CI pipeline green",
        "Priya: user interviews scheduled",
        "Jordan: pricing page draft"
      )
    ),
    end: timed(daysFrom(-1), 9, 30),
    folderId: work.id,
    priority: 0,
    start: timed(daysFrom(-1), 9),
    status: "done",
    subtitle: "Progress, blockers, next steps",
    tags: ["standup", "meeting"],
    title: "Weekly standup notes",
  });

  await createWithSchedule({
    content: doc(
      h2("iCloud sync options"),
      h3("NSUbiquitousKeyValueStore"),
      p("Max 1 MB per app. Not viable for workspace DBs."),
      h3("CloudKit (public/private DB)"),
      p(
        "Can store arbitrary binary assets. Requires CloudKit entitlement. Complex conflict resolution."
      ),
      h3("iCloud Drive file sync"),
      p(
        "Put the .sqlite file in ~/Library/Mobile Documents/com.pikos.app/. " +
          "iCloud Drive syncs automatically. Watch for concurrent writes from multiple devices."
      ),
      h3("Recommendation"),
      p("iCloud Drive + WAL mode + file-level locking. Simplest path; revisit at Phase 4a kickoff.")
    ),
    folderId: work.id,
    priority: 4,
    status: "not_started",
    subtitle: "Research NSUbiquitousKeyValueStore vs CloudKit for Phase 4a",
    tags: ["research", "sync", "dev"],
    title: "Spike: iCloud sync architecture",
  });

  await createWithSchedule({
    content: doc(
      h2("Monday standup"),
      p("Attendees: Alex, Sarah, Marcus, Priya, Jordan"),
      h3("Focus areas"),
      bullets(
        "Alex: start search command palette",
        "Sarah: finalize icon set",
        "Marcus: fix flaky CI test on Windows",
        "Priya: synthesis from user interviews",
        "Jordan: pricing page \u2014 final copy"
      )
    ),
    end: timed(daysFrom(0), 9, 30),
    folderId: work.id,
    priority: 0,
    start: timed(daysFrom(0), 9),
    status: "not_started",
    subtitle: "Kick off the week \u2014 share focus areas and blockers",
    tags: ["standup", "meeting"],
    title: "Monday standup",
  });

  await createWithSchedule({
    content: doc(
      h2("iCloud sync architecture sync"),
      p("Attendees: Alex, Marcus"),
      h3("Agenda"),
      bullets(
        "Review spike findings",
        "Confirm iCloud Drive + WAL mode approach",
        "Identify Rust-side file-watcher requirements",
        "Estimate scope for Phase 4a"
      )
    ),
    end: timed(daysFrom(0), 16),
    folderId: work.id,
    priority: 2,
    start: timed(daysFrom(0), 15),
    status: "not_started",
    subtitle: "Align with Marcus before committing to iCloud Drive approach",
    tags: ["meeting", "sync", "dev"],
    title: "Architecture sync \u2014 iCloud sync phase",
  });

  await createWithSchedule({
    content: doc(
      h2("Search command palette"),
      p(
        "Cmd+K opens a cmdk overlay. Types: pages (FTS), folders, commands. " +
          "Keyboard-only navigable. Closes on Esc or outside click."
      ),
      h3("Tasks"),
      tasks(
        { checked: true, text: "Install cmdk package" },
        { checked: true, text: "Build CommandPalette component with groups" },
        { checked: false, text: "Wire FTS search to pages group (debounced 150ms)" },
        { checked: false, text: "Wire folder navigation" },
        { checked: false, text: "Add Commands group: New Page, Toggle Calendar, Toggle Sidebar" },
        { checked: false, text: "Keyboard shortcut: Cmd+K to open/close" },
        { checked: false, text: "Animate with Radix Dialog for a11y" }
      )
    ),
    end: timed(daysFrom(2), 12),
    folderId: work.id,
    priority: 1,
    start: timed(daysFrom(2), 10),
    status: "in_progress",
    subtitle: "Cmdk-powered palette: search pages, switch folders, run commands",
    tags: ["dev", "feature"],
    title: "Implement search command palette",
  });

  await createWithSchedule({
    content: doc(
      h2("PR review: drag handle resize"),
      h3("Things to check"),
      tasks(
        { checked: false, text: "No layout thrash on drag (rAF batching)" },
        { checked: false, text: "Min/max width constraints enforced" },
        { checked: false, text: "Persists across page reloads (localStorage)" },
        { checked: false, text: "Keyboard fallback: arrow keys \u00b18px" },
        { checked: false, text: "No TypeScript `any` escapes" }
      )
    ),
    end: timed(daysFrom(1), 15),
    folderId: work.id,
    priority: 2,
    start: timed(daysFrom(1), 14),
    status: "not_started",
    subtitle: "Review Marcus\u2019s PR for resizable sidebar drag handle",
    tags: ["dev", "review"],
    title: "Code review: drag handle resize",
  });

  await createWithSchedule({
    content: doc(
      h2("Sprint 14 planning"),
      p("Attendees: Alex, Sarah, Marcus, Priya"),
      h3("Agenda"),
      bullets(
        "Review sprint 13 velocity",
        "Groom top 10 backlog items",
        "Assign owners",
        "Confirm release target for v0.2.0"
      )
    ),
    end: timed(daysFrom(3), 11, 30),
    folderId: work.id,
    priority: 2,
    start: timed(daysFrom(3), 10),
    status: "not_started",
    subtitle: "Pick items from backlog, estimate, assign owners",
    tags: ["planning", "meeting"],
    title: "Sprint planning \u2014 sprint 14",
  });

  await createWithSchedule({
    content: doc(
      h2("Bug: virtualized list flicker"),
      h3("Reproduction"),
      bullets(
        "Open a folder with 200+ pages",
        "Hold \u2193 arrow \u2014 blank rows appear for ~100ms between repaints",
        "Worse on M1 (higher render rate exposes the gap)"
      ),
      h3("Root cause hypothesis"),
      p(
        "Overscan count too low (currently 2). " +
          "React 19 concurrent mode defers offscreen renders, exposing the gap."
      ),
      h3("Fix"),
      p(
        "Increase overscan to 8. Add `scrollingDelay` to suppress placeholder rows while scrolling."
      )
    ),
    end: timed(daysFrom(4), 16),
    folderId: work.id,
    priority: 2,
    start: timed(daysFrom(4), 14),
    status: "not_started",
    subtitle: "Visible blank rows during rapid keyboard navigation in long lists",
    tags: ["bug", "dev", "performance"],
    title: "Fix page list virtualization flicker on fast scroll",
  });

  // ── Projects ────────────────────────────────────────────────────────────

  await createWithSchedule({
    content: doc(
      h2("Kitchen renovation"),
      p("Budget: $4,500. Target completion: end of April."),
      h3("Tasks"),
      tasks(
        { checked: true, text: "Get 3 contractor quotes by March 20" },
        { checked: true, text: "Order countertop samples" },
        { checked: false, text: "Pick paint color (Sherwin-Williams Alabaster?)" },
        { checked: false, text: "Source backsplash tile \u2014 40 sq ft needed" },
        { checked: false, text: "Schedule demo weekend" },
        { checked: false, text: "Buy new cabinet hardware" }
      )
    ),
    folderId: projects.id,
    priority: 2,
    status: "in_progress",
    subtitle: "Replace countertops, repaint cabinets, new backsplash tile",
    tags: ["home", "project"],
    title: "Home renovation \u2014 kitchen",
  });

  await createWithSchedule({
    content: doc(
      h2("Recipe manager"),
      p("Scratch that itch. Built with Tauri + React (same stack as Pikos). SQLite backend."),
      h3("Tasks"),
      tasks(
        { checked: true, text: "Spec: import from URL (structured data scraping)" },
        { checked: true, text: "Spec: tag + filter recipes" },
        { checked: false, text: "Spec: shopping list from recipe ingredients" },
        { checked: false, text: "Bootstrap Tauri project" },
        { checked: false, text: "Design data model" },
        { checked: false, text: "Prototype ingredient parser" }
      )
    ),
    folderId: projects.id,
    priority: 4,
    status: "not_started",
    subtitle: "Simple local-first recipe organiser \u2014 for family, no account needed",
    tags: ["project", "dev", "idea"],
    title: "Side project: recipe manager app",
  });

  await createWithSchedule({
    content: doc(
      h2("Standing desk research"),
      h3("Requirements"),
      bullets(
        "Motorized lift (sit/stand memory positions)",
        "Width: 55\u201365 in",
        "Max depth: 28 in (alcove constraint)",
        "Budget: under $600 for frame only"
      ),
      h3("Candidates"),
      bullets(
        "FlexiSpot E7 \u2014 $379, solid reviews, 70 in max",
        "Uplift V2 \u2014 $599, best warranty, 80 in max",
        "IKEA Bekant \u2014 $479, no memory, borderline"
      ),
      h3("Decision"),
      p("Leaning FlexiSpot E7. Order before April 1 to catch sale.")
    ),
    folderId: projects.id,
    priority: 3,
    status: "in_progress",
    subtitle: "Find a motorized frame under $600 that fits the alcove",
    tags: ["research", "home"],
    title: "Research: standing desk setup",
  });

  await createWithSchedule({
    content: doc(
      h2("Contractor outreach"),
      h3("Contacts"),
      bullets(
        "Mike Ferraro \u2014 recommended by neighbour, did their bathroom",
        "Green State Contracting \u2014 Houzz, 4.9 stars",
        "Bay Area Kitchen Co. \u2014 specialises in countertops"
      ),
      h3("What to include in request"),
      tasks(
        { checked: true, text: "Photos of current kitchen" },
        { checked: true, text: "Rough measurements" },
        { checked: false, text: "Scope: countertops + cabinet repaint + backsplash" },
        { checked: false, text: "Budget ceiling: $4,500" },
        { checked: false, text: "Preferred timeline: complete by end of April" }
      )
    ),
    end: timed(daysFrom(1), 18),
    folderId: projects.id,
    priority: 1,
    start: timed(daysFrom(1), 17),
    status: "not_started",
    subtitle: "Reach out to Houzz contacts by Tuesday EOD",
    tags: ["home", "project"],
    title: "Get 3 contractor quotes \u2014 kitchen reno",
  });

  await createWithSchedule({
    content: doc(
      h2("Recipe manager \u2014 data model"),
      h3("Tables"),
      bullets(
        "recipes(id, title, source_url, servings, prep_mins, cook_mins, notes, created_at)",
        "ingredients(id, recipe_id, name, quantity, unit, sort_order)",
        "steps(id, recipe_id, body, sort_order)",
        "tags(id, name)",
        "recipe_tags(recipe_id, tag_id)"
      ),
      h3("Open questions"),
      bullets(
        "Ingredient parser: NLP or rule-based regex?",
        "Shopping list: merge duplicates across recipes?",
        "Import: schema.org/Recipe JSON-LD \u2014 widest coverage"
      )
    ),
    end: timed(daysFrom(2), 21),
    folderId: projects.id,
    priority: 4,
    start: timed(daysFrom(2), 19, 30),
    status: "not_started",
    subtitle: "Tables: recipes, ingredients, steps, tags \u2014 SQLite schema draft",
    tags: ["dev", "project", "idea"],
    title: "Design recipe data model",
  });

  await createWithSchedule({
    content: doc(
      p("FlexiSpot E7 motorized frame \u2014 white, 55-in crossbar kit."),
      bullets(
        "Add to cart at flexispot.com",
        "Coupon: check RetailMeNot first",
        "Delivery address: home",
        "Assembly: weekend after delivery"
      )
    ),
    end: timed(daysFrom(3), 12, 20),
    folderId: projects.id,
    priority: 3,
    start: timed(daysFrom(3), 12),
    status: "not_started",
    subtitle: "Price is $379 \u2014 free shipping, arrives in 3\u20135 days",
    tags: ["home", "shopping"],
    title: "Order FlexiSpot E7 frame",
  });

  // ── Personal ────────────────────────────────────────────────────────────

  await createWithSchedule({
    content: doc(
      h2("5k morning run"),
      bullets(
        "Duration: 34 min",
        `Date: ${dateStr(daysFrom(-1))}`,
        "Felt sluggish first 2k, settled in after. Knees ok."
      )
    ),
    end: timed(daysFrom(-1), 7, 10),
    folderId: personal.id,
    priority: 0,
    start: timed(daysFrom(-1), 6, 30),
    status: "done",
    subtitle: "Easy pace. Focus on cadence over speed.",
    tags: ["health", "run"],
    title: "Morning run \u2014 5k",
  });

  await createWithSchedule({
    content: doc(
      h2("Upper body lift"),
      bullets("Duration: 50 min", "Bench: 3x8 @ 155 lb. New PR on OHP: 95 lb.")
    ),
    end: timed(daysFrom(1), 8),
    folderId: personal.id,
    priority: 0,
    start: timed(daysFrom(1), 7),
    status: "not_started",
    subtitle: "Bench, overhead press, rows, curls",
    tags: ["health", "gym"],
    title: "Gym \u2014 upper body",
  });

  await createWithSchedule({
    content: doc(
      p("Topics to cover:"),
      bullets("Ask about dad\u2019s appointment", "Update on kitchen reno", "Plan Easter visit")
    ),
    end: timed(daysFrom(4), 11, 45),
    folderId: personal.id,
    priority: 3,
    start: timed(daysFrom(4), 11),
    status: "not_started",
    subtitle: "Weekly check-in",
    tags: ["personal", "family"],
    title: "Call mom",
  });

  await createWithSchedule({
    content: doc(
      h2(`${dateStr(now)} \u2014 Focused / calm`),
      p(
        "Good morning session. Stayed off Twitter until noon. Finished the DST bug investigation faster than expected."
      ),
      h3("Gratitude"),
      bullets(
        "Clear headspace this morning",
        "Marcus unblocked the CI",
        "Sunset from the desk was gorgeous"
      )
    ),
    folderId: personal.id,
    priority: 0,
    status: "done",
    subtitle: "Mid-week reflection",
    tags: ["journal"],
    title: `Journal \u2014 ${dateStr(now)}`,
  });

  await createWithSchedule({
    content: doc(
      p("Dr. Kapur \u2014 123 Main St, Suite 4B"),
      bullets("Insurance: Blue Cross", "Bring ID", "Arrive 10 min early for paperwork")
    ),
    end: timed(daysFrom(7), 11, 30),
    folderId: personal.id,
    priority: 3,
    start: timed(daysFrom(7), 10, 30),
    status: "not_started",
    subtitle: "Routine cleaning + X-rays",
    tags: ["health", "appointment"],
    title: "Dentist appointment",
  });

  await createWithSchedule({
    content: doc(
      h2("4k morning run"),
      bullets("Duration: 28 min", "Start of week shakeout. Heart rate zone 2.")
    ),
    end: timed(daysFrom(0), 7, 5),
    folderId: personal.id,
    priority: 0,
    start: timed(daysFrom(0), 6, 30),
    status: "not_started",
    subtitle: "Easy 4k to start the week",
    tags: ["health", "run"],
    title: "Morning run",
  });

  await createWithSchedule({
    content: doc(
      h2("Legs session"),
      bullets("Duration: 55 min", "Squat: 3x5 @ 185 lb. Romanian DL: 3x8 @ 155 lb.")
    ),
    end: timed(daysFrom(2), 8),
    folderId: personal.id,
    priority: 0,
    start: timed(daysFrom(2), 7),
    status: "not_started",
    subtitle: "Squats, deadlifts, lunges, calf raises",
    tags: ["health", "gym"],
    title: "Gym \u2014 legs day",
  });

  await createWithSchedule({
    content: doc(
      h2("Evening walk"),
      bullets("Duration: 30 min", "No screen time. Neighbourhood loop.")
    ),
    end: timed(daysFrom(4), 18, 35),
    folderId: personal.id,
    priority: 0,
    start: timed(daysFrom(4), 18),
    status: "not_started",
    subtitle: "No phone, no podcast \u2014 just a walk",
    tags: ["health", "mindfulness"],
    title: "Evening walk \u2014 decompress",
  });

  await createWithSchedule({
    content: doc(
      h2("Yoga session"),
      bullets("Duration: 60 min", "Yin + flow hybrid. Hip openers, pigeon, thoracic rotation.")
    ),
    end: timed(daysFrom(5), 10),
    folderId: personal.id,
    priority: 0,
    start: timed(daysFrom(5), 9),
    status: "not_started",
    subtitle: "60-min flow, focus on hip flexors and thoracic mobility",
    tags: ["health", "yoga"],
    title: "Yoga \u2014 Saturday morning",
  });

  await createWithSchedule({
    content: doc(
      h2("Sunday meal prep"),
      h3("Menu"),
      bullets(
        "Protein: baked chicken thighs (8) + hard-boiled eggs (12)",
        "Grains: brown rice (4 cups dry) + lentils",
        "Veg: sheet pan broccoli + sweet potato",
        "Sauce: tahini lemon"
      ),
      h3("Grocery list"),
      bullets(
        "Chicken thighs \u00d7 8",
        "Broccoli \u00d7 2 heads",
        "Sweet potato \u00d7 4",
        "Brown rice",
        "Lentils",
        "Lemons"
      )
    ),
    end: timed(daysFrom(6), 17),
    folderId: personal.id,
    priority: 1,
    start: timed(daysFrom(6), 15),
    status: "not_started",
    subtitle: "Batch cook for the week: grains, proteins, roasted veg",
    tags: ["health", "food"],
    title: "Meal prep",
  });

  // ── Reading ─────────────────────────────────────────────────────────────

  await createWithSchedule({
    content: doc(
      h2("Four Thousand Weeks"),
      p("by Oliver Burkeman"),
      h3("Highlight"),
      p(
        "\u201CThe problem with the efficiency trap is that when you become more efficient at doing things, you don\u2019t actually get more done \u2014 you just get assigned more to do.\u201D"
      ),
      h3("My takeaway"),
      p("Resonates with Pikos\u2019 philosophy: tools should help you focus, not help you do more.")
    ),
    folderId: reading.id,
    priority: 4,
    status: "in_progress",
    subtitle: "Finite time, finite energy \u2014 stop optimising, start choosing",
    tags: ["reading", "productivity"],
    title: "Four Thousand Weeks \u2014 Oliver Burkeman",
  });

  await createWithSchedule({
    content: doc(
      h2("Thinking in Systems"),
      p("by Donella Meadows"),
      h3("Highlight"),
      p(
        "\u201CYou think that because you understand \u2018one\u2019 that you must therefore understand \u2018two\u2019 because one and one make two. But you forget that you must also understand \u2018and\u2019.\u201D"
      ),
      h3("My takeaway"),
      p("Changed how I think about feature interactions in Pikos.")
    ),
    folderId: reading.id,
    priority: 4,
    status: "done",
    subtitle: "Systems thinking primer \u2014 feedback loops, stocks, flows",
    tags: ["reading", "systems"],
    title: "Thinking in Systems \u2014 Donella Meadows",
  });

  await createWithSchedule({
    content: doc(
      h2("Local-first software \u2014 Ink & Switch"),
      h3("Seven ideals"),
      bullets(
        "1. Fast \u2014 no round trips for your own data",
        "2. Multi-device \u2014 seamless across all your devices",
        "3. Offline \u2014 full functionality without a network",
        "4. Collaboration \u2014 real-time when online",
        "5. Longevity \u2014 data outlives the app",
        "6. Privacy \u2014 user owns data, no surveillance",
        "7. User control \u2014 you choose when to sync"
      ),
      h3("Relevance to Pikos"),
      p(
        "Pikos hits ideals 1, 3, 5, 6, 7 from day one. Ideal 2 requires Phase 4 iCloud sync. Ideal 4 is deferred \u2014 single-user app for now."
      )
    ),
    folderId: reading.id,
    priority: 3,
    status: "done",
    subtitle: "Seven ideals for local-first apps \u2014 foundational read for Pikos",
    tags: ["reading", "architecture", "reference"],
    title: "Article: Local-first software \u2014 Ink & Switch",
  });

  await createWithSchedule({
    content: doc(
      h2("TLDR Tech \u2014 today"),
      p("Quick scan: flag anything about SQLite, CRDT, local-first, or Tauri."),
      h3("Flagged"),
      bullets(
        "libSQL fork of SQLite \u2014 Turso\u2019s embedded replicas could be useful for Phase 4 sync",
        "Electron 35 ships with V8 13 \u2014 note for cross-referencing with Tauri\u2019s webview"
      )
    ),
    end: timed(daysFrom(0), 8, 20),
    folderId: reading.id,
    priority: 4,
    start: timed(daysFrom(0), 8),
    status: "not_started",
    subtitle: "Skim for anything relevant to Pikos (sync, SQLite, local-first)",
    tags: ["reading", "tech"],
    title: "TLDR Tech newsletter",
  });

  await createWithSchedule({
    content: doc(
      h2("SQLite WAL mode notes"),
      h3("Key points"),
      bullets(
        "WAL allows concurrent reads + one writer without blocking",
        "Checkpoint merges WAL back into main db \u2014 auto or manual",
        "Safe for iCloud Drive if only one device writes at a time",
        "Set PRAGMA wal_autocheckpoint=1000 (pages) for predictable flush"
      ),
      h3("Relevance to Pikos"),
      p(
        "Pikos already enables WAL via PRAGMA. Need to verify checkpoint on app exit. Add `PRAGMA wal_checkpoint(TRUNCATE)` to shutdown handler."
      )
    ),
    end: timed(daysFrom(3), 21),
    folderId: reading.id,
    priority: 3,
    start: timed(daysFrom(3), 20),
    status: "not_started",
    subtitle: "Understand WAL checkpointing for safe concurrent access from iCloud Drive",
    tags: ["reading", "architecture", "dev"],
    title: "Article: SQLite WAL mode deep dive",
  });

  await createWithSchedule({
    content: doc(
      h2("Ch. 5 \u2014 The Watermelon Problem"),
      p("Reading goal: finish by Thursday evening."),
      h3("Key idea"),
      p(
        "Convenience culture trains us to prefer the path of least resistance, " +
          "eroding our capacity for activities that require sustained attention. " +
          "The problem isn\u2019t busyness \u2014 it\u2019s the avoidance of meaningful difficulty."
      ),
      h3("My reaction"),
      p(
        "Need to sit with this one. Relates to why Pikos doesn\u2019t have a sync feature yet \u2014 deliberate constraint, not laziness."
      )
    ),
    end: timed(daysFrom(1), 22),
    folderId: reading.id,
    priority: 4,
    start: timed(daysFrom(1), 21),
    status: "not_started",
    subtitle: "\u2018The Watermelon Problem\u2019 \u2014 why convenience undermines presence",
    tags: ["reading", "productivity"],
    title: "Read chapter 5 \u2014 Four Thousand Weeks",
  });

  // ── Finance ─────────────────────────────────────────────────────────────

  await createWithSchedule({
    content: doc(
      h2("March CC review"),
      h3("Recurring charges to audit"),
      bullets(
        "Adobe Creative Cloud \u2014 still needed?",
        "Figma seats \u2014 downgrade solo plan",
        "Namecheap renewal \u2014 3 domains",
        "Backblaze \u2014 keep"
      ),
      h3("One-time items to verify"),
      bullets("FlexiSpot order", "JetPens gift order", "AWS bill spike in March")
    ),
    end: timed(daysFrom(0), 19, 45),
    folderId: finance.id,
    priority: 2,
    start: timed(daysFrom(0), 19),
    status: "not_started",
    subtitle: "Flag any recurring charges to cancel before April billing",
    tags: ["finance", "review"],
    title: "Review March credit card statement",
  });

  await createWithSchedule({
    content: doc(
      p("Transfer $1,200 from Chase checking \u2192 Marcus HYSA."),
      bullets("Log in to Marcus", "Schedule transfer (settle by month end)", "Update budget sheet")
    ),
    end: timed(daysFrom(1), 12, 15),
    folderId: finance.id,
    priority: 2,
    start: timed(daysFrom(1), 12),
    status: "not_started",
    subtitle: "Monthly savings transfer \u2014 hit before end of March",
    tags: ["finance", "savings"],
    title: "Transfer $1,200 to HYSA",
  });

  await createWithSchedule({
    content: doc(
      h2("Q1 estimated taxes"),
      h3("Income sources"),
      bullets("Freelance consulting: $8,400", "W-2 salary: withheld automatically"),
      h3("Estimated tax owed"),
      p("~22% effective rate on freelance income = ~$1,848. Pay via IRS Direct Pay."),
      h3("Steps"),
      tasks(
        { checked: false, text: "Tally all Q1 invoices in Wave" },
        { checked: false, text: "Calculate SE tax + income tax" },
        { checked: false, text: "Pay via IRS Direct Pay before April 15" },
        { checked: false, text: "Log payment receipt number" }
      )
    ),
    end: timed(daysFrom(4), 11, 30),
    folderId: finance.id,
    priority: 1,
    start: timed(daysFrom(4), 10),
    status: "not_started",
    subtitle: "Due April 15 \u2014 calculate from Q1 freelance income now",
    tags: ["finance", "taxes"],
    title: "File Q1 estimated tax payment",
  });

  await createWithSchedule({
    content: doc(
      h2("March budget close"),
      bullets(
        "Income: $9,200 (salary + consulting)",
        "Fixed expenses: $3,450",
        "Variable: TBD \u2014 fill in after CC review",
        "Savings: $1,200 target"
      )
    ),
    end: timed(daysFrom(6), 17),
    folderId: finance.id,
    priority: 3,
    start: timed(daysFrom(6), 16),
    status: "not_started",
    subtitle: "Close out March actuals vs. plan",
    tags: ["finance", "review"],
    title: "Update monthly budget spreadsheet",
  });

  // ── Inbox ──────────────────────────────────────────────────────────────

  await createWithSchedule({
    content: doc(
      p("Subject: Re: Invoice #2024-03-001 \u2014 could you confirm receipt and ETA for payment?")
    ),
    folderId: null,
    priority: 1,
    status: "not_started",
    subtitle: "Invoice #2024-03-001 overdue by 2 weeks",
    tags: ["finance"],
    title: "Email Dan about invoice",
  });

  await createWithSchedule({
    content: doc(
      bullets(
        "Lamy Safari Fine nib \u2014 $30 on JetPens",
        "Ink: Diamine Oxblood or Sailor Jentle",
        "Wrap + card"
      )
    ),
    folderId: null,
    priority: 2,
    status: "not_started",
    subtitle: "Birthday coming up \u2014 looking at Lamy Safari fountain pen",
    tags: ["personal", "shopping"],
    title: "Buy birthday gift",
  });

  await createWithSchedule({
    content: doc(
      h3("Steps"),
      tasks(
        { checked: false, text: "Rename GitHub repo" },
        { checked: false, text: "Update tauri.conf.json identifier" },
        { checked: false, text: "Update CLAUDE.md references" },
        { checked: false, text: "Update README badge URLs" },
        { checked: false, text: "Redirect old URL (GitHub does this automatically)" }
      )
    ),
    folderId: null,
    priority: 4,
    status: "not_started",
    subtitle: "Align repo name with product name \u2014 update CI, docs, README",
    tags: ["dev", "housekeeping"],
    title: "Rename PKOS repo to pikos",
  });
}

// ── Tiptap JSON helpers ──────────────────────────────────────────────────────

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
