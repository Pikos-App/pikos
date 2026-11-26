// Loads the active page at once, but holds off while activePageId keeps changing (holding an arrow
// key through a list) so only the page the burst stops on is fetched.

import type { Page, PageSummary } from "@pikos/core";
import { useEffect, useRef, useState } from "react";

import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { usePageSummary } from "@/shared/hooks/usePageSummary";

/** A change this soon after the last one is part of a burst, and waits for the burst to end. */
const BURST_MS = 80;

/** The last merge per loaded page. The view cache rebuilds a page with unsaved edits on every read,
 *  so without this any change to the cache would hand the editor a new page with nothing changed. */
const merges = new WeakMap<Page, { summary: PageSummary; page: Page }>();

function sameFields(a: PageSummary, b: PageSummary): boolean {
  const keys = Object.keys(b) as (keyof PageSummary)[];
  return keys.length === Object.keys(a).length && keys.every((k) => Object.is(a[k], b[k]));
}

function withSummary(loaded: Page, summary: PageSummary): Page {
  const last = merges.get(loaded);
  if (last && sameFields(last.summary, summary)) return last.page;
  const page = { ...loaded, ...summary };
  merges.set(loaded, { page, summary });
  return page;
}

interface EditorPageState {
  page: Page | null;
  isLoading: boolean;
}

export function useEditorPage(): EditorPageState {
  const { activePageId } = useUI();
  const { getPage } = usePages();
  const { on } = useWorkspace();
  const [loadedPage, setLoadedPage] = useState<Page | null>(null);

  const loadingIdRef = useRef<string | null>(null);
  const lastChangeAtRef = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    if (activePageId === null) {
      loadingIdRef.current = null;
      return;
    }

    loadingIdRef.current = activePageId;
    const now = performance.now();
    const inBurst = now - lastChangeAtRef.current < BURST_MS;
    lastChangeAtRef.current = now;

    function load(id: string) {
      if (loadingIdRef.current !== id) return;
      void getPage(id).then((loaded) => {
        if (loadingIdRef.current === id) {
          setLoadedPage(loaded);
        }
      });
    }

    if (!inBurst) {
      load(activePageId);
      return;
    }
    const timer = setTimeout(() => load(activePageId), BURST_MS);
    return () => clearTimeout(timer);
  }, [activePageId]);

  useEffect(() => {
    return on("page:updated", (updated) => {
      if (updated.id === loadingIdRef.current) {
        setLoadedPage(updated);
      }
    });
  }, []);

  // Merge context summary (optimistic state) into loadedPage so that schedule,
  // status, priority and other metadata changes from scheduleOnce/updatePage
  // are reflected immediately without waiting for page:updated events.
  const summary = usePageSummary(activePageId);

  const page: Page | null = (() => {
    if (activePageId === null || !loadedPage || loadedPage.id !== activePageId) return null;
    if (!summary) return loadedPage;
    return withSummary(loadedPage, summary);
  })();
  const isLoading = activePageId !== null && page === null;

  return { isLoading, page };
}
