// The iOS demo workspace (apps/ios/Pikos/Sources/Support/DemoWorkspace.swift),
// planted page for page so the desktop and iPhone screen tours show the same
// data. Change one and the other with it.

import type { PagePriority, StorageAdapter } from "@pikos/core";
import { formatDateOnly, getLocalTimezone } from "@pikos/core";
import { addDays } from "date-fns";

interface DemoPage {
  title: string;
  subtitle?: string;
  folderId: string | null;
  start?: string;
  end?: string;
  tags?: string[];
  priority?: PagePriority;
  content?: string;
}

export async function seedDemo(adapter: StorageAdapter): Promise<void> {
  const now = new Date();
  const hour = Math.min(Math.max(now.getHours(), 9), 19);
  const timezone = getLocalTimezone();

  function day(offset: number): string {
    return formatDateOnly(addDays(now, offset));
  }

  function time(dayOffset: number, h: number, m: number): string {
    const minutes = Math.min(Math.max(0, h * 60 + m), 24 * 60 - 1);
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    return `${day(dayOffset)}T${hh}:${mm}:00`;
  }

  async function folder(name: string, color: string): Promise<string> {
    return (await adapter.createFolder({ color, name, parentId: null })).id;
  }

  async function page(spec: DemoPage): Promise<string> {
    const created = await adapter.createPage({
      content: spec.content ?? doc(),
      folderId: spec.folderId,
      priority: spec.priority ?? 0,
      status: "not_started",
      subtitle: spec.subtitle ?? null,
      tags: spec.tags ?? [],
      title: spec.title,
    });
    if (spec.start) {
      await adapter.createPageSchedule({
        pageId: created.id,
        scheduledStart: spec.start,
        ...(spec.end !== undefined && { scheduledEnd: spec.end }),
        ...(spec.start.includes("T") && { timezone }),
      });
    }
    return created.id;
  }

  async function repeating({
    end,
    rrule,
    start,
    ...rest
  }: DemoPage & { start: string; rrule: string }): Promise<void> {
    const id = await page(rest);
    await adapter.createRecurrenceRule({
      pageId: id,
      rrule,
      scheduledStart: start,
      ...(end !== undefined && { scheduledEnd: end }),
      timezone,
    });
  }

  const work = await folder("Work", "#539bf5");
  const projects = await folder("Projects", "#9b8ae8");
  const personal = await folder("Personal", "#57a872");
  const reading = await folder("Reading", "#e09b4a");
  const finance = await folder("Finance", "#e5534b");

  await page({
    folderId: projects,
    priority: 2,
    start: day(-3),
    subtitle: "Reach out to Houzz contacts by Tuesday",
    title: "Get 3 contractor quotes — kitchen",
  });
  const flexispot = await page({
    content: doc(
      paragraph("FlexiSpot E7 motorized frame — white, 55-in crossbar kit."),
      bullets(
        "Add to cart at flexispot.com",
        "Coupon: check RetailMeNot first",
        "Delivery address: home",
        "Assembly: weekend after delivery"
      ),
      tasks(["Measure the alcove", true], ["Order the desktop top", false])
    ),
    folderId: projects,
    priority: 3,
    start: time(0, hour - 4, 0),
    subtitle: "Price is $379 — free shipping, arrives in 3–5 days",
    tags: ["home", "shopping"],
    title: "Order FlexiSpot E7 frame",
  });
  await page({
    end: time(0, hour - 1, 0),
    folderId: finance,
    priority: 1,
    start: time(0, hour - 2, 0),
    subtitle: "Confirmation number goes in the Finance folder",
    title: "File Q1 estimated tax payment",
  });
  const recipeModel = await page({
    end: time(0, hour, 45),
    folderId: projects,
    start: time(0, hour, 0),
    subtitle: "Tables: recipes, ingredients, steps, tags",
    title: "Design recipe data model",
  });
  await page({
    end: time(0, hour + 2, 0),
    folderId: personal,
    start: time(0, hour + 1, 30),
    title: "Call mom",
  });
  await page({
    end: time(0, hour + 4, 30),
    folderId: personal,
    start: time(0, hour + 3, 0),
    subtitle: "Lupa, 8 people — booked under Alex",
    title: "Dinner with Sam",
  });
  await page({ folderId: finance, start: day(0), title: "Transfer $1,200 to HYSA" });

  await repeating({
    end: time(0, 9, 45),
    folderId: work,
    rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    start: time(0, 9, 30),
    title: "Daily standup",
  });
  // Started three days ago and never ticked, so acting on today's asks about the days behind it.
  await repeating({
    folderId: personal,
    rrule: "FREQ=DAILY",
    start: time(-3, 8, 0),
    title: "Water the plants",
  });
  await page({
    end: time(1, 8, 0),
    folderId: personal,
    start: time(1, 7, 0),
    title: "Gym — legs day",
  });
  await page({
    end: time(1, 11, 30),
    folderId: work,
    start: time(1, 10, 0),
    subtitle: "Bring the velocity chart and the carry-over list",
    title: "Sprint planning — sprint 14",
  });
  await page({
    end: time(2, 12, 0),
    folderId: work,
    start: time(2, 10, 0),
    title: "Implement search command palette",
  });
  await page({
    end: day(6),
    folderId: personal,
    start: day(4),
    subtitle: "Hotel is the Harbour Inn, room block under Park",
    title: "Emmy and Brian Wedding Weekend",
  });
  await page({
    end: time(2, 8, 30),
    folderId: reading,
    start: time(2, 8, 0),
    title: "TLDR Tech newsletter",
  });

  await page({
    folderId: projects,
    subtitle: "Replace countertops, repaint cabinets, new backsplash",
    title: "Home renovation — kitchen",
  });
  await page({
    folderId: projects,
    subtitle: "Simple local-first recipe organiser for the family",
    title: "Side project: recipe manager app",
  });
  const deskResearch = await page({
    folderId: projects,
    subtitle: "Find a motorized frame under $600 that fits the alcove",
    title: "Research: standing desk setup",
  });
  const localFirst = await page({
    folderId: reading,
    subtitle: "Kleppmann et al. — the seven ideals",
    title: "Local-first software",
  });
  await page({
    folderId: null,
    subtitle: "Raised beds along the fence, herbs by the door",
    tags: ["home"],
    title: "Ideas for the garden",
  });
  await page({ folderId: null, title: "Book the car in for a service" });

  const mat = await page({
    folderId: projects,
    subtitle: "Returned, too thick for the chair",
    title: "Standing desk mat",
  });
  await adapter.setPagesStatus([mat], "done", now.toISOString());

  const opened = [localFirst, recipeModel, flexispot, deskResearch];
  for (const [index, id] of opened.entries()) {
    await adapter.updatePage(id, {
      lastOpenedAt: new Date(now.getTime() - (opened.length - index) * 60_000).toISOString(),
    });
  }
}

type Node = Record<string, unknown>;

function doc(...nodes: Node[]): string {
  return JSON.stringify({
    content: nodes.length > 0 ? nodes : [{ type: "paragraph" }],
    type: "doc",
  });
}

function paragraph(text: string): Node {
  return { content: [{ text, type: "text" }], type: "paragraph" };
}

function bullets(...items: string[]): Node {
  return {
    content: items.map((text) => ({ content: [paragraph(text)], type: "listItem" })),
    type: "bulletList",
  };
}

function tasks(...items: [string, boolean][]): Node {
  return {
    content: items.map(([text, checked]) => ({
      attrs: { checked },
      content: [paragraph(text)],
      type: "taskItem",
    })),
    type: "taskList",
  };
}
