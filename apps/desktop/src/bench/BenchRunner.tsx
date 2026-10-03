import { addDays, format, parseISO, subDays } from "date-fns";
import { useEffect, useRef } from "react";

import { STORAGE_KEYS } from "@/shared/constants/storage";
import { useUI } from "@/shared/context/UIContext";

import {
  benchFinish,
  benchMemory,
  benchOptions,
  benchPlan,
  launchStages,
  nextPaint,
  whenShown,
} from "./session";

/** Samples per launch for each action, unless the script asks for a fixed number. */
const COUNTS = {
  coldFolders: 10,
  completes: 10,
  directOpens: 20,
  listOpens: 20,
  renames: 10,
  scrollSteps: 20,
  searches: 20,
  warmSwitches: 26,
  weeks: 10,
};
/** Where a click lands after the pointer arrives, by the large-workspace spec's measure. */
const HOVER_MS = 250;
/** Longer than the editor's and the search's typing bursts, so each open and each search is a
 *  fresh one rather than the tail of the last, as it is when a person does them. */
const PAUSE_MS = 300;
/** `pikos stress seed` puts this word in the same fifty pages whatever the workspace size. */
const SEARCH_WORD = "zephyr";
/** Each launch starts on Inbox with no page open and the calendar on this week, whatever the
 *  last one left, because sizes share the bench build's settings and a page from one corpus
 *  isn't in the next. */
const RESTORED_STATE_KEYS = [
  STORAGE_KEYS.calendarReferenceDate,
  STORAGE_KEYS.calendarViewMode,
  STORAGE_KEYS.lastActivePageId,
  STORAGE_KEYS.lastActiveViewId,
  STORAGE_KEYS.lastEditorPageId,
  STORAGE_KEYS.rightPanel,
];
const SMART_VIEWS = ["Today", "Upcoming"];
const DAY_LABEL = /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, /;

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** React keeps its own copy of a field's value, so a script has to go through the native setter. */
function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/** A fixed seed, so every launch makes the same choices. */
function seeded() {
  let state = 0x5eed;
  return (n: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % n;
  };
}

/** The pointer arriving, as React's enter and over handlers see it. */
function hover(el: Element) {
  for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter"]) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: type.endsWith("over") }));
  }
}

/** Hover, wait as a person would, click, and time from the click to the next paint after `done`. */
async function hoverAndClick(el: HTMLElement, done: () => boolean, what: string) {
  hover(el);
  await sleep(HOVER_MS);
  const start = performance.now();
  el.click();
  await whenShown(done, what);
  await nextPaint();
  return performance.now() - start;
}

const editorShows = (id: string) =>
  document.querySelector<HTMLElement>('[contenteditable="true"][data-page-id]')?.dataset[
    "pageId"
  ] === id;

const listGroup = (name: string) =>
  document.querySelector<HTMLElement>(`[role="group"][aria-label="${CSS.escape(name)}"]`);
const listRows = (name: string) => [
  ...(listGroup(name)?.querySelectorAll<HTMLElement>("[data-page-list-item]") ?? []),
];
const rowById = (id: string) =>
  document.querySelector<HTMLElement>(
    `[role="group"] [data-page-list-item][data-page-id="${CSS.escape(id)}"]`
  );

/** A sidebar entry by its visible name. */
function sidebarEntry(name: string): HTMLElement {
  const nav = document.querySelector('nav[aria-label="Workspace navigation"]');
  const entry = [...(nav?.querySelectorAll<HTMLElement>("button, [role='button']") ?? [])].find(
    (el) => el.textContent?.trim().startsWith(name)
  );
  if (!entry) throw new Error(`no sidebar entry for ${name}`);
  return entry;
}

/**
 * Switch views through the sidebar. A folder is drawn at its first page row. Today and Upcoming
 * can open on a collapsed section or the empty state, so for them any drawn row counts.
 */
function switchTo(name: string) {
  const drawn = SMART_VIEWS.includes(name)
    ? () => listGroup(name)?.querySelector("[data-index]") != null
    : () => listRows(name).length > 0;
  return hoverAndClick(sidebarEntry(name), drawn, `the ${name} list`);
}

function rowInView(list: HTMLElement) {
  const box = list.getBoundingClientRect();
  return [...list.querySelectorAll("[data-page-list-item]")].some((row) => {
    const r = row.getBoundingClientRect();
    return r.bottom > box.top && r.top < box.bottom;
  });
}

/** Times what a person waits for in the real window, then hands the numbers to the bench build's Rust side. */
export default function BenchRunner() {
  const ui = useUI();
  const uiRef = useRef(ui);
  const started = useRef(false);
  useEffect(() => {
    uiRef.current = ui;
  });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();

    async function run() {
      const results: Record<string, unknown> = {};
      const pick = seeded();
      const { only, samples } = benchOptions();
      const wants = (area: string) => only == null || only.includes(area);
      const n = (action: keyof typeof COUNTS) => samples ?? COUNTS[action];
      try {
        results["launch"] = await launchStages();
        const today = new Date();
        const plan = await benchPlan(
          n("directOpens"),
          format(subDays(today, 7), "yyyy-MM-dd"),
          format(addDays(today, 7 * (n("weeks") + 2)), "yyyy-MM-dd")
        );
        results["openPages"] = plan.openPages;

        const folders = [...plan.folders];
        const coldFolders: string[] = [];
        while (folders.length > 0 && coldFolders.length < n("coldFolders")) {
          coldFolders.push(folders.splice(pick(folders.length), 1)[0]!.name);
        }
        const visited = new Set(["Inbox"]);
        const goTo = async (name: string) => {
          if (listGroup(name) == null) await switchTo(name);
          visited.add(name);
        };

        if (wants("switch")) {
          const cold: number[] = [];
          for (const name of coldFolders) {
            cold.push(await switchTo(name));
            visited.add(name);
          }
          results["switchColdMs"] = cold;
          const smartCold: number[] = [];
          for (const name of SMART_VIEWS) {
            smartCold.push(await switchTo(name));
            visited.add(name);
          }
          results["switchSmartColdMs"] = smartCold;
        }

        if (wants("open")) {
          // From a list: a row of the folder on screen, hovered and then clicked.
          const hovered: number[] = [];
          for (let i = 0; i < n("listOpens") && coldFolders.length > 0; i++) {
            const folder = coldFolders[i % coldFolders.length]!;
            await goTo(folder);
            const rows = listRows(folder).filter((row) => row.dataset["active"] !== "true");
            const row = rows[pick(Math.min(rows.length, 12))];
            if (!row) continue;
            const id = row.dataset["pageId"]!;
            hovered.push(await hoverAndClick(row, () => editorShows(id), `page ${id}`));
          }
          results["openHoveredMs"] = hovered;

          // Without a hover first, as a search result or a link does: pages anywhere in the
          // workspace, most of them in no list on screen.
          const direct: number[] = [];
          for (const id of plan.pages) {
            if (editorShows(id)) continue;
            await sleep(PAUSE_MS);
            const start = performance.now();
            uiRef.current.openPage(id);
            await whenShown(() => editorShows(id), `page ${id} in the editor`);
            await nextPaint();
            direct.push(performance.now() - start);
          }
          results["openDirectMs"] = direct;
        }

        if (wants("search")) {
          uiRef.current.setOpenDialog("search");
          const dialog = () => document.querySelector('[aria-label="Search pages"]');
          await whenShown(() => dialog()?.querySelector("input") != null, "the search palette");
          const palette = dialog()!;
          const input = palette.querySelector("input")!;
          // A result row highlights the word it matched, so a <mark> appearing is the results arriving.
          const showsMatches = () => palette.querySelector("mark") != null;
          const searches: number[] = [];
          for (let i = 0; i < n("searches"); i++) {
            typeInto(input, "");
            await whenShown(() => !showsMatches(), "the search to clear");
            await sleep(PAUSE_MS);
            const start = performance.now();
            typeInto(input, SEARCH_WORD);
            await whenShown(showsMatches, "search results");
            await nextPaint();
            searches.push(performance.now() - start);
          }
          results["searchMs"] = searches;
          uiRef.current.setOpenDialog(null);
          await nextPaint();
        }

        if (wants("switch")) {
          const order = [...visited];
          const warm: number[] = [];
          const smartWarm: number[] = [];
          for (let i = 0; i < n("warmSwitches") && order.length > 1; i++) {
            const name = order[i % order.length]!;
            if (listGroup(name) != null) continue;
            (SMART_VIEWS.includes(name) ? smartWarm : warm).push(await switchTo(name));
          }
          results["switchWarmMs"] = warm;
          results["switchSmartWarmMs"] = smartWarm;
        }

        if (wants("scroll")) {
          // Down the biggest list in jumps, timed until rows at the new place are drawn.
          await goTo("Inbox");
          const list = listGroup("Inbox")!;
          const steps = n("scrollSteps");
          const scroll: number[] = [];
          for (let step = 1; step <= steps; step++) {
            const target = Math.round(((list.scrollHeight - list.clientHeight) * step) / steps);
            if (target <= list.scrollTop + 1) continue;
            const start = performance.now();
            list.scrollTop = target;
            await whenShown(
              () => Math.abs(list.scrollTop - target) < 2 && rowInView(list),
              `rows at ${target}px`
            );
            await nextPaint();
            scroll.push(performance.now() - start);
          }
          results["scrollMs"] = scroll;
          list.scrollTop = 0;
          await nextPaint();
        }

        if (wants("edit") && coldFolders.length > 0) {
          const folder = coldFolders[0]!;
          await goTo(folder);
          const candidates = () =>
            listRows(folder).filter((row) => row.dataset["active"] !== "true");

          // Renaming in the editor, timed until the list row shows the new title.
          const renames: number[] = [];
          for (let i = 0; i < n("renames"); i++) {
            const row = candidates()[pick(Math.min(candidates().length, 12))];
            if (!row) break;
            const id = row.dataset["pageId"]!;
            row.click();
            await whenShown(() => editorShows(id), `page ${id}`);
            const title = document.querySelector<HTMLElement>(
              '[role="button"][aria-label="Page title"]'
            );
            if (!title) continue;
            title.click();
            const field = () =>
              document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Page title"]');
            await whenShown(() => field() != null, "the title field");
            const renamed = `${row.getAttribute("aria-label") ?? ""} r${i}`;
            const start = performance.now();
            typeInto(field()!, renamed);
            await whenShown(
              () => rowById(id)?.getAttribute("aria-label") === renamed,
              `the row renamed to ${renamed}`
            );
            await nextPaint();
            renames.push(performance.now() - start);
            field()?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
          }
          results["renameMs"] = renames;

          // Completing from the list, timed until the row shows it done or leaves.
          const completes: number[] = [];
          for (let i = 0; i < n("completes"); i++) {
            const row = candidates()[pick(Math.min(candidates().length, 12))];
            const box = row?.querySelector<HTMLElement>(
              '[role="checkbox"][aria-label="Mark done"]'
            );
            if (!row || !box) break;
            const id = row.dataset["pageId"]!;
            const start = performance.now();
            box.click();
            await whenShown(() => {
              const now = rowById(id);
              return (
                now == null ||
                now.querySelector('[role="checkbox"]')?.getAttribute("aria-checked") === "true"
              );
            }, `page ${id} done`);
            await nextPaint();
            completes.push(performance.now() - start);
          }
          results["completeMs"] = completes;
        }

        if (wants("calendar")) {
          uiRef.current.setRightPanel("calendar");
          const heading = () =>
            document.querySelector('h2[aria-label="Visible week"]')?.textContent ?? null;
          await whenShown(() => heading() != null, "the week calendar");
          await nextPaint();
          const busyDays = new Set(
            plan.busyDays.map((day) => format(parseISO(day), "EEEE, MMMM d"))
          );
          const labels = () =>
            [
              ...(document
                .querySelector('[aria-label="Week calendar"]')
                ?.querySelectorAll("[aria-label]") ?? []),
            ].map((el) => el.getAttribute("aria-label")!);
          const blocks = () =>
            labels()
              .filter((label) => !DAY_LABEL.test(label))
              .join("\n");
          // A week is drawn once the heading moves on and, when a seeded page falls in it, its
          // blocks have replaced the last week's. On a busy day most fold into a "+N more" pill,
          // so the test is that the blocks changed, not that a given page is showing.
          const weekDrawn = (before: { heading: string | null; blocks: string }) => () => {
            if (heading() === before.heading) return false;
            const busy = labels().some((label) => busyDays.has(label));
            return !busy || (blocks() !== "" && blocks() !== before.blocks);
          };
          const move = async (direction: "Next" | "Previous") => {
            const button = document.querySelector<HTMLElement>(
              `button[aria-label="${direction} week"]`
            )!;
            const before = { blocks: blocks(), heading: heading() };
            return hoverAndClick(button, weekDrawn(before), `the ${direction} week`);
          };
          const forward: number[] = [];
          for (let i = 0; i < n("weeks"); i++) forward.push(await move("Next"));
          results["weekColdMs"] = forward;
          const back: number[] = [];
          for (let i = 0; i < n("weeks"); i++) back.push(await move("Previous"));
          results["weekWarmMs"] = back;
          uiRef.current.setRightPanel("editor");
          await nextPaint();
        }

        results["memory"] = await benchMemory();
      } catch (e) {
        results["error"] = e instanceof Error ? e.message : String(e);
      }
      for (const key of RESTORED_STATE_KEYS) localStorage.removeItem(key);
      await benchFinish(results);
    }
  }, []);

  return null;
}
