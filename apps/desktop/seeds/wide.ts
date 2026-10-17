// One of everything, a little of each: the realistic week with the mock
// calendar sync over it, a few repeating pages with history, and each surface
// nothing else plants. That means nested folders, a folder with no colour,
// subpages, the trash, focus sessions, dated completions, a page with several
// blocks, all-day spans and overdue all-day pages, and reminders.

import type { StorageAdapter } from "@pikos/core";
import { formatLocalISO } from "@pikos/core";
import { addMinutes } from "date-fns";

import { bold, bullets, doc, p, tasks } from "./doc";
import { formattingReference } from "./editor";
import {
  at,
  day,
  ensureFolder,
  instant,
  plantOnce,
  plantPage,
  plantSyncedLayer,
  random,
} from "./plant";
import { plantRealistic } from "./realistic";
import { plantRoutines } from "./routines";

export async function seedWide(adapter: StorageAdapter): Promise<void> {
  await plantOnce(adapter, "Wide seed marker", async () => {
    await plantRealistic(adapter);
    await plantSyncedLayer(adapter);
    await plantRoutines(adapter, ["vitamins", "plants", "birthday"]);
    await plantExtras(adapter);
  });
}

async function plantExtras(adapter: StorageAdapter): Promise<void> {
  const home = await ensureFolder(adapter, "Home", { color: "#10b981" });
  const renovation = await ensureFolder(adapter, "Renovation", {
    color: "#84cc16",
    parentId: home.id,
  });
  const kitchen = await ensureFolder(adapter, "Kitchen", { parentId: renovation.id });
  const archive = await ensureFolder(adapter, "Archive");

  const { page: plan } = await plantPage(adapter, {
    content: doc(
      p("Budget ", bold("£18k"), ". Quotes due by the end of the month."),
      bullets("Units", "Worktop", "Electrics")
    ),
    folderId: kitchen.id,
    priority: 2,
    subtitle: "Parent page with three subpages",
    tags: ["home"],
    title: "Kitchen renovation plan",
  });
  for (const [title, done] of [
    ["Get three quotes for units", true],
    ["Choose a worktop", false],
    ["Book the electrician", false],
  ] as const) {
    await plantPage(adapter, {
      done: done && at(-3, 18),
      folderId: kitchen.id,
      parentId: plan.id,
      title,
    });
  }

  const { page: report } = await plantPage(adapter, {
    blocks: [
      { end: at(1, 16), start: at(1, 14) },
      { end: at(3, 11), start: at(3, 9) },
    ],
    content: doc(
      tasks(
        { checked: true, text: "Numbers from finance" },
        { checked: false, text: "First draft" }
      )
    ),
    end: at(-1, 12),
    folderId: home.id,
    priority: 3,
    start: at(-1, 10),
    subtitle: "Three work blocks on three days",
    title: "Write the quarterly report",
  });

  const rng = random(11);
  for (let i = 0; i < 12; i++) {
    const started = addMinutes(new Date(at(-rng.int(0, 13), rng.int(8, 19))), rng.int(0, 45));
    const minutes = rng.pick([25, 25, 50, 90]);
    await adapter.createFocusSession({
      durationS: minutes * 60,
      endedAt: formatLocalISO(addMinutes(started, minutes)),
      pageId: i % 3 === 0 ? plan.id : report.id,
      startedAt: formatLocalISO(started),
    });
  }

  const finished = [
    "Renew car insurance",
    "Clear out the shed",
    "Return the parcel",
    "Book flu jab",
    "Pay the water bill",
    "Fix the bike light",
    "Order new filters",
    "Sort the photo backup",
  ];
  for (let i = 0; i < 16; i++) {
    const daysAgo = rng.int(1, 28);
    await plantPage(adapter, {
      createdAt: instant(at(-daysAgo - rng.int(1, 10), 9)),
      done: at(-daysAgo, rng.int(9, 20), rng.int(0, 59)),
      folderId: archive.id,
      title: `${finished[i % finished.length]}${i >= finished.length ? " (again)" : ""}`,
      updatedAt: instant(at(-daysAgo, 21)),
    });
  }

  await plantPage(adapter, {
    end: day(5),
    folderId: home.id,
    start: day(3),
    tags: ["family", "✈️travel"],
    title: "Family visit",
  });
  await plantPage(adapter, {
    folderId: home.id,
    priority: 3,
    start: day(-2),
    title: "Renew passport",
  });
  await plantPage(adapter, {
    end: at(-1, 17, 30),
    folderId: home.id,
    start: at(-1, 17),
    title: "Return library books",
  });
  await plantPage(adapter, {
    end: at(2, 10, 15),
    folderId: home.id,
    reminders: [30, 1440],
    start: at(2, 9, 30),
    title: "Dentist",
  });
  await plantPage(adapter, {
    end: at(1, 13),
    folderId: home.id,
    reminders: [-1],
    start: at(1, 12, 30),
    subtitle: "Reminders turned off",
    title: "Lunch with Sam",
  });

  await plantPage(adapter, {
    content: formattingReference(),
    subtitle: "Every node and mark once",
    title: "Formatting reference",
  });

  const { page: stale } = await plantPage(adapter, {
    content: doc(p("Milk, eggs.")),
    title: "Old grocery list",
  });
  await adapter.softDeletePage(stale.id);
  const oldProject = await ensureFolder(adapter, "Old side project", { color: "#a855f7" });
  await plantPage(adapter, { folderId: oldProject.id, title: "Landing page copy" });
  await plantPage(adapter, {
    done: at(-20, 11),
    folderId: oldProject.id,
    title: "Register the domain",
  });
  await adapter.softDeleteFolder(oldProject.id);
}
