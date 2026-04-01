// Stress seed — heavy-load scenario for performance testing.
// Tests sidebar rendering, page list scroll, FTS5 under load, calendar density.

import { faker } from "@faker-js/faker";
import type { StorageAdapter } from "@pikos/core";
import { invoke } from "@tauri-apps/api/core";

const MARKER = "Stress test marker";

const DEFAULT_FOLDERS = 20;
const DEFAULT_PAGES = 500;
const DEFAULT_SCHEDULES = 200;

const FOLDER_COLORS = [
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#f43f5e",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#3b82f6",
  "#84cc16",
  "#f97316",
];

const TAGS_POOL = [
  "work",
  "personal",
  "urgent",
  "review",
  "research",
  "blocked",
  "waiting",
  "idea",
  "reference",
  "project",
  "meeting",
  "design",
  "dev",
  "qa",
  "infra",
  "marketing",
  "finance",
  "legal",
  "hr",
  "ops",
];

type Status = "not_started" | "done";
type Priority = 0 | 1 | 2 | 3 | 4;

function randPriority(): Priority {
  const r = Math.random();
  if (r < 0.05) return 1;
  if (r < 0.2) return 2;
  if (r < 0.5) return 3;
  if (r < 0.8) return 4;
  return 0;
}

function randStatus(): Status {
  const r = Math.random();
  if (r < 0.7) return "not_started";
  return "done";
}

function randTags(): string[] {
  const n = Math.floor(Math.random() * 4);
  return faker.helpers.arrayElements(TAGS_POOL, n);
}

function richContent(): { content: string; contentText: string } {
  const texts: string[] = [];
  const heading = faker.lorem.sentence({ max: 8, min: 3 }).replace(/\.$/, "");
  const intro = faker.lorem.paragraph();
  texts.push(heading, intro);

  const nodes: Node[] = [h2(heading), p(intro)];

  if (Math.random() > 0.4) {
    const sub = faker.lorem.words({ max: 5, min: 2 });
    const body = faker.lorem.paragraph();
    texts.push(sub, body);
    nodes.push(h3(sub), p(body));
  }

  if (Math.random() > 0.5) {
    const items = [
      faker.lorem.sentence(),
      faker.lorem.sentence(),
      faker.lorem.sentence(),
      ...(Math.random() > 0.6 ? [faker.lorem.sentence()] : []),
    ];
    texts.push(...items);
    nodes.push(bullets(...items));
  }

  if (Math.random() > 0.6) {
    const taskItems = [
      { checked: Math.random() > 0.5, text: faker.lorem.sentence() },
      { checked: Math.random() > 0.5, text: faker.lorem.sentence() },
      { checked: false, text: faker.lorem.sentence() },
    ];
    texts.push(...taskItems.map((t) => t.text));
    nodes.push(tasks(...taskItems));
  }

  if (Math.random() > 0.8) {
    const snippet = `// ${faker.hacker.phrase()}\nconst ${faker.hacker.noun()} = ${faker.number.int({ max: 999, min: 1 })};`;
    texts.push(snippet);
    nodes.push(code("typescript", snippet));
  }

  if (Math.random() > 0.5) {
    const closing = faker.lorem.paragraph();
    texts.push(closing);
    nodes.push(p(closing));
  }

  return { content: doc(...nodes), contentText: texts.join(" ") };
}

function randScheduledStart(): string {
  const offsetDays = faker.number.int({ max: 90, min: -30 });
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(
    faker.number.int({ max: 22, min: 6 }),
    faker.number.int({ max: 3, min: 0 }) * 15,
    0,
    0
  );
  return d.toISOString().replace("Z", "").slice(0, 19);
}

function randScheduledEnd(start: string, durationMins: number): string {
  const d = new Date(start);
  d.setMinutes(d.getMinutes() + durationMins);
  return d.toISOString().replace("Z", "").slice(0, 19);
}

/** ISO timestamp N days ago at a random hour. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(faker.number.int({ max: 22, min: 7 }), faker.number.int({ max: 59, min: 0 }), 0, 0);
  return d.toISOString().replace("Z", "").slice(0, 19);
}

/** ISO timestamp between `after` and `before`. */
function dateBetween(after: string, before: string): string {
  const a = new Date(after).getTime();
  const b = new Date(before).getTime();
  return new Date(a + Math.random() * (b - a)).toISOString().replace("Z", "").slice(0, 19);
}

interface PageRecord {
  id: string;
  status: Status;
  createdAt: string;
}

export async function seedStress(
  adapter: StorageAdapter,
  opts?: { folders?: number; pages?: number; schedules?: number }
): Promise<void> {
  const folderCount = opts?.folders ?? DEFAULT_FOLDERS;
  const pageCount = opts?.pages ?? DEFAULT_PAGES;
  const schedCount = opts?.schedules ?? DEFAULT_SCHEDULES;

  // Check idempotency
  const { results } = await adapter.searchPages(MARKER);
  if (results.some((r) => r.title.includes(MARKER))) return;

  faker.seed(42);

  const now = new Date().toISOString().replace("Z", "").slice(0, 19);

  // ── Folders ──────────────────────────────────────────────────────────────

  const folderIds: string[] = [];
  for (let i = 0; i < folderCount; i++) {
    const name = `${faker.commerce.department()} \u00b7 ${faker.word.noun()}`;
    const folder = await adapter.createFolder({
      color: FOLDER_COLORS[i % FOLDER_COLORS.length]!,
      name,
      parentId: null,
    });
    folderIds.push(folder.id);
  }

  // ── Marker page ─────────────────────────────────────────────────────────

  await adapter.createPage({
    content: doc(p("Stress seed marker.")),
    contentText: "Stress seed marker.",
    folderId: folderIds[0] ?? null,
    priority: 0,
    status: "done",
    subtitle: "Delete this page to re-seed",
    tags: [],
    title: MARKER,
  });

  // ── Pages ───────────────────────────────────────────────────────────────

  const pages: PageRecord[] = [];
  const inboxCount = Math.max(1, Math.round(pageCount * 0.05));
  const folderPageCount = pageCount - inboxCount;

  async function createSeededPage(folderId: string | null): Promise<PageRecord> {
    const status = randStatus();
    const { content, contentText } = richContent();
    // Spread creation dates across the last 12 weeks
    const createdAt = daysAgo(faker.number.int({ max: 84, min: 0 }));
    const page = await adapter.createPage({
      content,
      contentText,
      folderId,
      priority: randPriority(),
      status,
      subtitle: faker.lorem.sentence({ max: 15, min: 5 }),
      tags: randTags(),
      title: faker.lorem.sentence({ max: 10, min: 3 }).replace(/\.$/, ""),
    });
    return { createdAt, id: page.id, status };
  }

  // Inbox pages
  for (let i = 0; i < inboxCount; i++) {
    pages.push(await createSeededPage(null));
  }

  // Folder pages
  for (let i = 0; i < folderPageCount; i++) {
    const folderId = folderIds[i % folderIds.length]!;
    pages.push(await createSeededPage(folderId));
  }

  // ── Backdate timestamps ─────────────────────────────────────────────────
  // Spread created_at across last 12 weeks, set updated_at for ~40% of pages,
  // and completed_at for done pages.

  for (const pg of pages) {
    const wasEdited = Math.random() < 0.4;
    const updatedAt = wasEdited ? dateBetween(pg.createdAt, now) : pg.createdAt;
    const completedAt = pg.status === "done" ? dateBetween(pg.createdAt, updatedAt) : undefined;

    await invoke("backdate_page", {
      params: {
        completed_at: completedAt ?? null,
        created_at: pg.createdAt,
        id: pg.id,
        updated_at: updatedAt,
      },
    });
  }

  // ── Schedules ───────────────────────────────────────────────────────────

  const durations = [15, 30, 45, 60, 90, 120];
  for (let i = 0; i < schedCount; i++) {
    const pageId = pages[Math.floor(Math.random() * pages.length)]!.id;
    const start = randScheduledStart();
    const dur = faker.helpers.arrayElement(durations);
    const end = randScheduledEnd(start, dur);
    await adapter.createPageSchedule({
      pageId,
      scheduledEnd: end,
      scheduledStart: start,
      timezone: "America/Los_Angeles",
    });
  }
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

function code(language: string, content: string): Node {
  return {
    attrs: { language },
    content: [{ text: content, type: "text" }],
    type: "codeBlock",
  };
}
