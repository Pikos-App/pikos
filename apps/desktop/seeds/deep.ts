// A workspace two years into daily use: thousands of pages created over that
// time and mostly finished, folders nested five deep, subpage trees, series
// with hundreds of completed occurrences, focus history, a full trash and a few
// very long documents. For the costs that only show at scale: sidebar and list
// virtualisation, the Completed section's paging, search, the Data panel.
//
// A seeded generator drives every choice, so two runs plant the same workspace
// shifted to today.

import type { Page, PagePriority, StorageAdapter } from "@pikos/core";
import { formatLocalISO } from "@pikos/core";
import { addDays, addMinutes, setDate, startOfDay } from "date-fns";

import { bullets, doc, h2, h3, type Node, p, quote, tasks } from "./doc";
import { SENTENCES } from "./editor";
import {
  at,
  day,
  ensureFolder,
  instant,
  plantOnce,
  plantPage,
  random,
  type Random,
  shift,
} from "./plant";
import { replayHistory, weekdayFrom } from "./routines";

export interface DeepScale {
  pages: number;
  /** Days of history behind the oldest page. */
  historyDays: number;
  subpageParents: number;
  focusSessions: number;
  trashed: number;
  hugeDocuments: number;
  /** Multiplies how far back each repeating series starts. */
  seriesHistory: number;
}

export const DEEP_SCALE: DeepScale = {
  focusSessions: 500,
  historyDays: 730,
  hugeDocuments: 3,
  pages: 2400,
  seriesHistory: 1,
  subpageParents: 25,
  trashed: 40,
};

export async function seedDeep(
  adapter: StorageAdapter,
  scale: DeepScale = DEEP_SCALE
): Promise<void> {
  await plantOnce(adapter, "Deep seed marker", () => plantDeep(adapter, scale));
}

const AREAS = {
  health: {
    color: "#8b5cf6",
    objects: [
      "physio appointment",
      "running plan",
      "blood test results",
      "sleep log",
      "meal plan",
      "dentist check-up",
    ],
    sub: ["Running", "Appointments"],
    verbs: ["Book", "Log", "Review", "Plan", "Cancel"],
  },
  home: {
    color: "#10b981",
    objects: [
      "boiler service",
      "garden fence",
      "council tax",
      "bathroom tiles",
      "broadband contract",
      "loft insulation",
    ],
    sub: ["Garden", "Repairs", "Bills"],
    verbs: ["Fix", "Call about", "Pay", "Measure", "Order", "Compare quotes for"],
  },
  learning: {
    color: "#f59e0b",
    objects: [
      "Spanish vocab",
      "statistics chapter",
      "guitar scales",
      "SICP exercises",
      "typography course",
      "history podcast notes",
    ],
    sub: ["Books", "Courses"],
    verbs: ["Finish", "Summarise", "Practise", "Read", "Start"],
  },
  money: {
    color: "#ef4444",
    objects: [
      "tax return",
      "pension statement",
      "credit card bill",
      "savings transfer",
      "receipts",
      "insurance renewal",
    ],
    sub: ["Taxes", "Accounts"],
    verbs: ["File", "Check", "Pay", "Reconcile", "Download"],
  },
  work: {
    color: "#3b82f6",
    objects: [
      "roadmap doc",
      "hiring loop",
      "incident review",
      "quarterly plan",
      "onboarding guide",
      "pricing page",
      "API migration",
      "design spec",
    ],
    sub: ["Meetings", "Hiring", "Planning", "Incidents"],
    verbs: ["Draft", "Review", "Ship", "Prepare", "Follow up on", "Sync on", "Decide on"],
  },
} as const;

type AreaKey = keyof typeof AREAS;

const TAGS = [
  ...Object.keys(AREAS),
  ...[
    "urgent",
    "waiting",
    "someday",
    "idea",
    "reference",
    "meeting",
    "call",
    "errand",
    "reading",
    "writing",
  ],
  ...Array.from({ length: 100 }, (_, i) => `topic-${String(i + 1).padStart(3, "0")}`),
];

async function plantDeep(adapter: StorageAdapter, scale: DeepScale): Promise<void> {
  const rng = random(42);

  const folders: Record<AreaKey, string[]> = {
    health: [],
    home: [],
    learning: [],
    money: [],
    work: [],
  };
  for (const key of Object.keys(AREAS) as AreaKey[]) {
    const area = AREAS[key];
    const top = await ensureFolder(adapter, key[0]!.toUpperCase() + key.slice(1), {
      color: area.color,
    });
    folders[key].push(top.id);
    for (const name of area.sub) {
      folders[key].push((await ensureFolder(adapter, name, { parentId: top.id })).id);
    }
  }
  let parentId = folders.work[0]!;
  for (const name of ["Clients", "Acme", "Retainer", "Invoices"]) {
    parentId = (await ensureFolder(adapter, name, { parentId })).id;
    folders.work.push(parentId);
  }

  const pages: Page[] = [];
  let openOverdue = 0;
  for (let i = 0; i < scale.pages; i++) {
    const planted = await plantHistoricPage(adapter, rng, folders, scale, openOverdue < 40);
    if (planted.overdue) openOverdue++;
    pages.push(planted.page);
  }

  const projects = pages.filter((page) => page.folderId && folders.work.includes(page.folderId));
  for (const parent of rng.sample(projects, scale.subpageParents)) {
    for (let c = 0; c < rng.int(3, 6); c++) {
      const { page: child } = await plantPage(adapter, {
        content: doc(p(rng.pick(SENTENCES))),
        createdAt: parent.createdAt,
        done:
          parent.status === "done"
            ? (parent.completedAt ?? true)
            : rng.chance(0.4) && formatLocalISO(new Date()),
        folderId: parent.folderId,
        parentId: parent.id,
        title: `${parent.title} — part ${c + 1}`,
      });
      if (c === 0) {
        await plantPage(adapter, {
          folderId: parent.folderId,
          parentId: child.id,
          title: `${child.title}, notes`,
        });
      }
    }
  }

  for (let d = 0; d < scale.hugeDocuments; d++) {
    await plantPage(adapter, {
      content: hugeDocument(rng),
      createdAt: instant(at(-rng.int(60, 400), 10)),
      folderId: folders.learning[0]!,
      subtitle: "Around 12,000 words",
      tags: ["reference", "reading"],
      title: `Research notes — ${rng.pick(AREAS.learning.objects)} (${d + 1})`,
      updatedAt: instant(at(-rng.int(0, 30), 17)),
    });
  }

  await plantSeries(adapter, rng, folders, scale);

  const finished = pages.filter((page) => page.status === "done");
  for (let s = 0; s < scale.focusSessions; s++) {
    const page = rng.pick(finished.length > 0 ? finished : pages);
    const started = addMinutes(
      new Date(at(-rng.int(0, Math.min(365, scale.historyDays)), rng.int(7, 20))),
      rng.int(0, 59)
    );
    const minutes = rng.pick([15, 25, 25, 25, 50, 50, 90]);
    await adapter.createFocusSession({
      durationS: minutes * 60,
      endedAt: formatLocalISO(addMinutes(started, minutes)),
      pageId: page.id,
      startedAt: formatLocalISO(started),
    });
  }

  for (const page of rng.sample(pages, scale.trashed)) {
    await adapter.softDeletePage(page.id);
  }
}

async function plantHistoricPage(
  adapter: StorageAdapter,
  rng: Random,
  folders: Record<AreaKey, string[]>,
  scale: DeepScale,
  mayStayOverdue: boolean
): Promise<{ page: Page; overdue: boolean }> {
  const areaKey = rng.pick([
    "work",
    "work",
    "work",
    "home",
    "home",
    "money",
    "health",
    "learning",
  ] as const);
  const area = AREAS[areaKey];
  const createdAgo = Math.floor(scale.historyDays * rng.next() ** 2.2);
  const created = at(-createdAgo, rng.int(7, 22), rng.int(0, 59));

  let start: string | undefined;
  let end: string | undefined;
  let dueAgo: number | null = null;
  if (rng.chance(0.45)) {
    const offset = -createdAgo + rng.int(0, 21);
    dueAgo = -offset;
    if (rng.chance(0.7)) {
      start = at(offset, rng.int(8, 18), rng.pick([0, 15, 30, 45]));
      end = shift(start, rng.pick([30, 60, 60, 90]));
    } else {
      start = day(offset);
    }
  }

  let completed: string | null = null;
  if (dueAgo !== null && dueAgo > 0) {
    const doneChance = !mayStayOverdue ? 1 : dueAgo > 45 ? 0.97 : 0.7;
    if (rng.chance(doneChance)) completed = at(-dueAgo, rng.int(9, 21), rng.int(0, 59));
  } else if (dueAgo === null && rng.chance(createdAgo > 30 ? 0.65 : 0.25)) {
    completed = at(-rng.int(0, Math.max(0, createdAgo - 1)), rng.int(9, 21), rng.int(0, 59));
  }

  const lastTouchedAgo = completed ? null : rng.int(0, createdAgo);
  const { page } = await plantPage(adapter, {
    content: body(rng),
    createdAt: instant(created),
    done: completed ?? false,
    folderId: rng.chance(0.04) ? null : rng.pick(folders[areaKey]),
    priority: rng.pick([0, 0, 0, 0, 1, 1, 2, 2, 3, 4] as PagePriority[]),
    subtitle: rng.chance(0.5) ? rng.pick(SENTENCES) : null,
    tags: rng.sample(TAGS.slice(0, rng.chance(0.3) ? TAGS.length : 20), rng.int(0, 4)),
    title: `${rng.pick(area.verbs)} ${rng.pick(area.objects)}`,
    updatedAt: instant(completed ?? (lastTouchedAgo === null ? created : at(-lastTouchedAgo, 18))),
    ...(start !== undefined && { start }),
    ...(end !== undefined && { end }),
  });
  return { overdue: dueAgo !== null && dueAgo > 0 && completed === null, page };
}

function body(rng: Random): string {
  const roll = rng.next();
  const para = (): Node => p(rng.sample(SENTENCES, rng.int(2, 6)).join(" "));
  if (roll < 0.25) return doc(p());
  if (roll < 0.65) return doc(para());
  if (roll < 0.93) {
    return doc(
      h3("Notes"),
      para(),
      rng.chance(0.5)
        ? tasks(
            ...rng
              .sample(SENTENCES, rng.int(2, 5))
              .map((text) => ({ checked: rng.chance(0.5), text }))
          )
        : bullets(...rng.sample(SENTENCES, rng.int(2, 5))),
      para()
    );
  }
  return doc(
    ...Array.from({ length: rng.int(10, 20) }, (_, i) =>
      i % 5 === 0 ? h2(`Part ${i / 5 + 1}`) : para()
    )
  );
}

function hugeDocument(rng: Random): string {
  const blocks: Node[] = [];
  for (let i = 0; i < 160; i++) {
    if (i % 12 === 0) blocks.push(h2(`Section ${i / 12 + 1}`));
    blocks.push(p(rng.sample(SENTENCES, 7).join(" ")));
    if (i % 25 === 24) blocks.push(quote(p(rng.pick(SENTENCES))));
  }
  return doc(...blocks);
}

/** Long-running series, walked through their whole history. */
async function plantSeries(
  adapter: StorageAdapter,
  rng: Random,
  folders: Record<AreaKey, string[]>,
  scale: DeepScale
): Promise<void> {
  const ago = (days: number): number => -Math.max(7, Math.round(days * scale.seriesHistory));
  const series = [
    {
      area: "work",
      end: [16, 45],
      rrule: "FREQ=WEEKLY;BYDAY=FR",
      start: [16, 0],
      startDay: weekdayFrom(5, ago(540)),
      title: "Weekly review",
    },
    {
      area: "work",
      end: [9, 30],
      rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      start: [9, 15],
      startDay: weekdayFrom(1, ago(180)),
      title: "Daily standup",
    },
    {
      area: "learning",
      end: [7, 20],
      rrule: "FREQ=DAILY",
      start: [7, 0],
      startDay: ago(120),
      title: "Morning pages",
    },
    {
      area: "money",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=20",
      startDay: null,
      title: "Pay the credit card",
    },
    {
      area: "home",
      end: [18, 30],
      rrule: "FREQ=WEEKLY;BYDAY=SU",
      start: [18, 0],
      startDay: weekdayFrom(0, ago(365)),
      title: "Call parents",
    },
    {
      area: "work",
      end: [15, 0],
      rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TH",
      start: [14, 0],
      startDay: weekdayFrom(4, ago(400)),
      title: "Team retro",
    },
    {
      area: "home",
      rrule: "FREQ=MONTHLY;INTERVAL=2",
      startDay: ago(600),
      title: "Change the water filter",
    },
  ] as const;

  for (const s of series) {
    const anchor = s.startDay ?? monthDayAgo(20, ago(700));
    const timed = "start" in s;
    const { page } = await plantPage(adapter, {
      content: doc(p(rng.pick(SENTENCES))),
      createdAt: instant(at(anchor, 8)),
      folderId: folders[s.area][0]!,
      repeat: { rrule: s.rrule },
      start: timed ? at(anchor, s.start[0], s.start[1]) : day(anchor),
      title: s.title,
      ...(timed && { end: at(anchor, s.end[0], s.end[1]) }),
    });
    // Morning pages keeps its last three days open, the backlog shape; the rest
    // are caught up.
    const backlog = s.title === "Morning pages" ? 3 : 0;
    const length = backlog > 0 ? Math.max(0, -anchor - backlog) : 1500;
    const pattern = Array.from({ length }, () => (rng.chance(0.1) ? "s" : "d")).join("");
    await replayHistory(adapter, page.id, { pattern, rest: backlog > 0 ? "open" : "done" });
  }
}

/** Days from today to the `dayOfMonth` in the month `offset` days from today. */
function monthDayAgo(dayOfMonth: number, offset: number): number {
  const target = setDate(addDays(startOfDay(new Date()), offset), dayOfMonth);
  return Math.round((target.getTime() - startOfDay(new Date()).getTime()) / 86_400_000);
}
