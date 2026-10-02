import { useEffect, useRef } from "react";

import { STORAGE_KEYS } from "@/shared/constants/storage";
import { useUI } from "@/shared/context/UIContext";

import { benchFinish, benchMemory, benchPlan, launchStages, nextPaint, whenShown } from "./session";

const LIST_OPENS = 20;
const DIRECT_OPENS = 20;
const SEARCHES = 20;
const COLD_FOLDERS = 10;
const WARM_SWITCHES = 20;
/** Where a click lands after the pointer arrives, by the large-workspace spec's measure. */
const HOVER_MS = 250;
/** `pikos stress seed` puts this word in the same fifty pages whatever the workspace size. */
const SEARCH_WORD = "zephyr";
/** Each launch starts on Inbox with no page open, whatever the last one left, because sizes
 *  share the bench build's settings and a page from one corpus isn't in the next. */
const RESTORED_STATE_KEYS = [
  STORAGE_KEYS.lastActivePageId,
  STORAGE_KEYS.lastActiveViewId,
  STORAGE_KEYS.lastEditorPageId,
];

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** React keeps its own copy of an input's value, so a script has to go through the native setter. */
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
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

const listShows = (name: string) =>
  document.querySelector(`[role="group"][aria-label="${CSS.escape(name)}"]`) != null;
const listRows = (name: string) => [
  ...document.querySelectorAll<HTMLElement>(
    `[role="group"][aria-label="${CSS.escape(name)}"] [data-page-list-item]`
  ),
];

/** A sidebar entry by its visible name. */
function sidebarEntry(name: string): HTMLElement {
  const nav = document.querySelector('nav[aria-label="Workspace navigation"]');
  const entry = [...(nav?.querySelectorAll<HTMLElement>("button, [role='button']") ?? [])].find(
    (el) => el.textContent?.trim().startsWith(name)
  );
  if (!entry) throw new Error(`no sidebar entry for ${name}`);
  return entry;
}

/** Switch views through the sidebar; done once the list names the view and draws its first row. */
function switchTo(name: string) {
  return hoverAndClick(
    sidebarEntry(name),
    () => listShows(name) && listRows(name).length > 0,
    `the ${name} list`
  );
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
      try {
        results["launch"] = await launchStages();
        const plan = await benchPlan(DIRECT_OPENS);
        results["openPages"] = plan.openPages;

        // First visits: each folder once, in a seeded order.
        const folders = [...plan.folders];
        const coldFolders: string[] = [];
        while (folders.length > 0 && coldFolders.length < COLD_FOLDERS) {
          coldFolders.push(folders.splice(pick(folders.length), 1)[0]!.name);
        }
        const switchCold: number[] = [];
        for (const name of coldFolders) switchCold.push(await switchTo(name));
        results["switchColdMs"] = switchCold;

        // Opening from the list: a row of the folder on screen, hovered and then clicked.
        const openHovered: number[] = [];
        for (let i = 0; i < LIST_OPENS && coldFolders.length > 0; i++) {
          const folder = coldFolders[i % coldFolders.length]!;
          if (!listShows(folder)) await switchTo(folder);
          const rows = listRows(folder).filter((row) => row.dataset["active"] !== "true");
          const row = rows[pick(Math.min(rows.length, 12))];
          if (!row) continue;
          const id = row.dataset["pageId"]!;
          openHovered.push(await hoverAndClick(row, () => editorShows(id), `page ${id}`));
        }
        results["openHoveredMs"] = openHovered;

        // Opening without a hover first, as a search result or a link does: pages anywhere in
        // the workspace, most of them in no list on screen.
        const openDirect: number[] = [];
        for (const id of plan.pages) {
          if (editorShows(id)) continue;
          const start = performance.now();
          uiRef.current.openPage(id);
          await whenShown(() => editorShows(id), `page ${id} in the editor`);
          await nextPaint();
          openDirect.push(performance.now() - start);
        }
        results["openDirectMs"] = openDirect;

        uiRef.current.setOpenDialog("search");
        const dialog = () => document.querySelector('[aria-label="Search pages"]');
        await whenShown(() => dialog()?.querySelector("input") != null, "the search palette");
        const palette = dialog()!;
        const input = palette.querySelector("input")!;
        // A result row highlights the word it matched, so a <mark> appearing is the results arriving.
        const showsMatches = () => palette.querySelector("mark") != null;
        const searches: number[] = [];
        for (let i = 0; i < SEARCHES; i++) {
          typeInto(input, "");
          await whenShown(() => !showsMatches(), "the search to clear");
          const start = performance.now();
          typeInto(input, SEARCH_WORD);
          await whenShown(showsMatches, "search results");
          await nextPaint();
          searches.push(performance.now() - start);
        }
        results["searchMs"] = searches;
        uiRef.current.setOpenDialog(null);
        await nextPaint();

        // Returns: views already visited this launch.
        const visited = ["Inbox", ...coldFolders];
        const switchWarm: number[] = [];
        for (let i = 0; i < WARM_SWITCHES; i++) {
          const name = visited[i % visited.length]!;
          if (listShows(name)) continue;
          switchWarm.push(await switchTo(name));
        }
        results["switchWarmMs"] = switchWarm;

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
