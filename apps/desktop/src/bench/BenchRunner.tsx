import { useEffect, useRef } from "react";

import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";

import { benchFinish, benchSession } from "./session";

const PAGE_OPENS = 30;
const SEARCHES = 20;
const VIEW_SWITCHES = 20;
const TIMEOUT_MS = 30_000;
/** `pikos stress seed` puts this word in the same fifty pages whatever the workspace size. */
const SEARCH_WORD = "zephyr";

/** Resolve the moment `check` holds, re-checking on every change to the page rather than once a
 *  frame, so the waiting adds no frames of its own to what it times. */
function whenShown(check: () => boolean, what: string): Promise<void> {
  if (check()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (!check()) return;
      stop();
      resolve();
    });
    const timer = window.setTimeout(() => {
      stop();
      reject(new Error(`timed out waiting for ${what}`));
    }, TIMEOUT_MS);
    function stop() {
      observer.disconnect();
      window.clearTimeout(timer);
    }
    observer.observe(document.body, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  });
}

/** The next paint: frame callbacks run just before it, and a task queued from one runs just after. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));
}

/** React keeps its own copy of an input's value, so a script has to go through the native setter. */
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** A fixed seed, so every run opens the same pages in the same order. */
function seededPicks<T>(items: T[], count: number): T[] {
  let state = 0x5eed;
  const picks: T[] = [];
  for (let i = 0; i < Math.min(count, items.length); i++) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    picks.push(items[state % items.length]!);
  }
  return picks;
}

/** Times what a person waits for in the real window, then hands the numbers to the bench build's Rust side. */
export default function BenchRunner() {
  const ui = useUI();
  const { pages } = usePages();
  const uiRef = useRef(ui);
  const pagesRef = useRef(pages);
  const started = useRef(false);
  useEffect(() => {
    uiRef.current = ui;
    pagesRef.current = pages;
  });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();

    async function run() {
      const results: Record<string, unknown> = {};
      try {
        await nextPaint();
        results["launchMs"] = (await benchSession()).uptimeMs;
        results["openPages"] = pagesRef.current.length;

        const editorShows = (id: string) =>
          document.querySelector<HTMLElement>('[contenteditable="true"][data-page-id]')?.dataset[
            "pageId"
          ] === id;
        const opens: number[] = [];
        for (const page of seededPicks(pagesRef.current, PAGE_OPENS)) {
          if (editorShows(page.id)) continue;
          const start = performance.now();
          uiRef.current.openPage(page.id);
          await whenShown(() => editorShows(page.id), `page ${page.id} in the editor`);
          await nextPaint();
          opens.push(performance.now() - start);
        }
        results["openPageMs"] = opens;

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

        // The list panel is labelled with the view it shows.
        const listShows = (label: string) =>
          document.querySelector(`[role="group"][aria-label="${label}"]`) != null;
        const switches: number[] = [];
        for (let i = 0; i < VIEW_SWITCHES; i++) {
          const [view, label] =
            i % 2 === 0 ? (["today", "Today"] as const) : (["inbox", "Inbox"] as const);
          const start = performance.now();
          uiRef.current.setActiveViewId(view);
          await whenShown(() => listShows(label), `the ${label} list`);
          await nextPaint();
          switches.push(performance.now() - start);
        }
        results["switchViewMs"] = switches;
      } catch (e) {
        results["error"] = e instanceof Error ? e.message : String(e);
      }
      await benchFinish(results);
    }
  }, []);

  return null;
}
