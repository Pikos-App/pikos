// Loads the active page at once, but holds off while activePageId keeps changing (holding an arrow
// key through a list) so only the page the burst stops on is fetched.

import type { Page } from "@pikos/core";
import { useEffect, useRef, useState } from "react";

import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

/** A change this soon after the last one is part of a burst, and waits for the burst to end. */
const BURST_MS = 80;

interface EditorPageState {
  /** Full page with content, or null if no page selected / still loading. */
  page: Page | null;
  /** True while getPage() is in flight. */
  isLoading: boolean;
}

export function useEditorPage(): EditorPageState {
  const { activePageId } = useUI();
  const { getPage, pages } = usePages();
  const { on } = useWorkspace();
  const [loadedPage, setLoadedPage] = useState<Page | null>(null);

  // Track the ID we're currently loading to avoid race conditions
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
        // Only apply if this is still the page we want
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
  const summary = pages.find((p) => p.id === activePageId);

  // Derive: page is only valid when it matches the active selection.
  // When activePageId changes to null or a different ID, page becomes null
  // automatically — no setState needed.
  const page: Page | null = (() => {
    if (activePageId === null || !loadedPage || loadedPage.id !== activePageId) return null;
    if (!summary) return loadedPage;
    return { ...loadedPage, ...summary };
  })();
  const isLoading = activePageId !== null && page === null;

  return { isLoading, page };
}
