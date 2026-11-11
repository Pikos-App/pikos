// What every scenario writes with: dates in the device's own wall clock, one
// call per page (schedule, repeat, reminders and history included), and the
// once-only guard a scenario is wrapped in.

import type { Folder, Page, PagePriority, StorageAdapter } from "@pikos/core";
import { formatDateOnly, formatLocalISO, getLocalTimezone } from "@pikos/core";
import { addDays, addMinutes, startOfDay } from "date-fns";

import { STORAGE_BACKEND } from "@/shared/constants/testMode";

import { doc, EMPTY_DOC, p } from "./doc";

/** `YYYY-MM-DD`, `offset` days from today. */
export function day(offset: number, from: Date = new Date()): string {
  return formatDateOnly(addDays(startOfDay(from), offset));
}

/** Local `YYYY-MM-DDTHH:MM:SS`, `offset` days from today at `hour:minute`. */
export function at(offset: number, hour: number, minute = 0, from: Date = new Date()): string {
  return formatLocalISO(addMinutes(addDays(startOfDay(from), offset), hour * 60 + minute));
}

/**
 * The UTC instant a local wall-clock time names. `createdAt` and `updatedAt`
 * are instants, unlike schedules and `completedAt`, which stay wall-clock.
 */
export function instant(localIso: string): string {
  return new Date(localIso).toISOString();
}

/** `iso` moved by `minutes`, keeping its local wall-clock shape. */
export function shift(iso: string, minutes: number): string {
  return formatLocalISO(addMinutes(new Date(iso), minutes));
}

export interface PageSpec {
  title: string;
  folderId?: string | null;
  parentId?: string | null;
  subtitle?: string | null;
  /** A `doc(...)` string. Omitted, the body is empty. */
  content?: string;
  tags?: string[];
  priority?: PagePriority;
  /** `true` completes it now; a local timestamp completes it then. */
  done?: boolean | string;
  /** UTC instants (see `instant`). `updatedAt` defaults to `createdAt`. */
  createdAt?: string;
  updatedAt?: string;
  /** Timed (`at`) or all-day (`day`). With `repeat`, the series anchor. */
  start?: string;
  end?: string;
  /** More blocks on the same page, beyond `start`/`end`. */
  blocks?: { start: string; end?: string }[];
  repeat?: { rrule: string; exdates?: string[] };
  /** Lead times in minutes; `[-1]` is the "no reminders" sentinel. */
  reminders?: number[];
}

export interface Planted {
  page: Page;
  /** Set when the spec repeats. */
  ruleId: string | null;
}

export async function plantPage(adapter: StorageAdapter, spec: PageSpec): Promise<Planted> {
  const content = spec.content ?? EMPTY_DOC;
  const completedAt =
    typeof spec.done === "string" ? spec.done : spec.done ? formatLocalISO(new Date()) : null;
  const updatedAt = spec.updatedAt ?? spec.createdAt;
  const page = await adapter.createPage({
    completedAt,
    content,
    folderId: spec.folderId ?? null,
    parentId: spec.parentId ?? null,
    priority: spec.priority ?? 0,
    status: completedAt ? "done" : "not_started",
    subtitle: spec.subtitle ?? null,
    tags: spec.tags ?? [],
    title: spec.title,
    ...(spec.createdAt !== undefined && { createdAt: spec.createdAt }),
    ...(updatedAt !== undefined && { updatedAt }),
  });

  let ruleId: string | null = null;
  if (spec.start && spec.repeat) {
    const rule = await adapter.createRecurrenceRule({
      pageId: page.id,
      rrule: spec.repeat.rrule,
      scheduledStart: spec.start,
      timezone: getLocalTimezone(),
      ...(spec.end !== undefined && { scheduledEnd: spec.end }),
      ...(spec.repeat.exdates && { rruleExdates: spec.repeat.exdates }),
    });
    ruleId = rule.id;
  } else if (spec.start) {
    await schedule(adapter, page.id, spec.start, spec.end);
  }
  for (const block of spec.blocks ?? []) {
    await schedule(adapter, page.id, block.start, block.end);
  }
  for (const minutesBefore of spec.reminders ?? []) {
    await adapter.createPageReminder({ minutesBefore, pageId: page.id });
  }
  return { page, ruleId };
}

async function schedule(adapter: StorageAdapter, pageId: string, start: string, end?: string) {
  await adapter.createPageSchedule({
    pageId,
    scheduledStart: start,
    ...(end !== undefined && { scheduledEnd: end }),
    ...(start.includes("T") && { timezone: getLocalTimezone() }),
  });
}

/**
 * Reuse a folder a sibling part already made under the same name, so parts
 * composed into one scenario share their sidebar instead of doubling it.
 */
export async function ensureFolder(
  adapter: StorageAdapter,
  name: string,
  options: { color?: string | null; parentId?: string | null } = {}
): Promise<Folder> {
  const parentId = options.parentId ?? null;
  const existing = (await adapter.listFolders()).find(
    (f) => f.name === name && f.parentId === parentId && !f.isExternalCalendar
  );
  if (existing) return existing;
  return adapter.createFolder({ color: options.color ?? null, name, parentId });
}

/**
 * Run `plant` unless this scenario's marker page already exists. The marker is
 * written last, so a seed that fails part-way can simply be run again.
 */
export async function plantOnce(
  adapter: StorageAdapter,
  marker: string,
  plant: () => Promise<void>
): Promise<void> {
  const { results } = await adapter.searchPages(marker, true);
  if (results.some((r) => r.title === marker)) return;
  await plant();
  await plantPage(adapter, {
    content: doc(p("Planted by a developer seed. Delete this page to plant it again.")),
    done: true,
    title: marker,
  });
}

export interface Stamps {
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
}

/**
 * Date a page the writer stamped with "now", such as a completed occurrence's
 * clone. Only the dev command can rewrite created/updated; the in-memory test
 * adapter has no such command, so there only the completion moves.
 */
export async function backdate(
  adapter: StorageAdapter,
  pageId: string,
  stamps: Stamps
): Promise<void> {
  if (import.meta.env["VITE_TEST_MODE"] === "true") {
    if (stamps.completedAt) await adapter.updatePage(pageId, { completedAt: stamps.completedAt });
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("backdate_page", {
    params: {
      completed_at: stamps.completedAt ?? null,
      created_at: stamps.createdAt ?? null,
      id: pageId,
      updated_at: stamps.updatedAt ?? null,
    },
  });
}

/** The mock calendar sync: the TS twin in test mode, the Rust seed otherwise. */
export async function plantSyncedLayer(adapter: StorageAdapter): Promise<void> {
  // Only the mock needs its own copy of the synced rows. Both other backends
  // reach the real writer's dev command, which is the point of the bridge
  // lane: the same seed a person QAs against, planted by the same code.
  if (STORAGE_BACKEND === "mock") {
    const { seedSyncedCalendar } = await import("./syncedCalendar");
    await seedSyncedCalendar(adapter);
  } else if (STORAGE_BACKEND === "bridge") {
    const { bridgeInvoke } = await import("@bridge/transport");
    await bridgeInvoke("dev_seed_synced_calendar");
  } else {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("dev_seed_synced_calendar");
  }
}

/** A small seeded generator, so a scenario plants the same workspace every run. */
export function random(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    chance: (probability: number): boolean => next() < probability,
    int: (min: number, max: number): number => min + Math.floor(next() * (max - min + 1)),
    next,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    sample: <T>(items: readonly T[], count: number): T[] => {
      const pool = [...items];
      const out: T[] = [];
      while (out.length < count && pool.length > 0) {
        out.push(pool.splice(Math.floor(next() * pool.length), 1)[0]!);
      }
      return out;
    },
  };
}

export type Random = ReturnType<typeof random>;
