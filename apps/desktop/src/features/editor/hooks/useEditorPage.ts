// useEditorPage — loads full page content when activePageId changes.
// Returns the full Page (with content) for the Tiptap editor.

import { useEffect, useRef, useState } from "react";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import type { Page } from "@pikos/core";

interface EditorPageState {
  /** Full page with content, or null if no page selected / still loading. */
  page: Page | null;
  /** True while getPage() is in flight. */
  isLoading: boolean;
}

/**
 * Watches activePageId and fetches the full Page (with content) for the editor.
 * Page is derived: only valid when loadedPage.id matches activePageId.
 * No synchronous setState in effects — null state is derived automatically.
 */
export function useEditorPage(): EditorPageState {
  const { activePageId } = useUI();
  const { getPage, on, pages } = useWorkspace();
  const [loadedPage, setLoadedPage] = useState<Page | null>(null);

  // Track the ID we're currently loading to avoid race conditions
  const loadingIdRef = useRef<string | null>(null);

  // Load full page when activePageId changes
  useEffect(() => {
    if (activePageId === null) {
      loadingIdRef.current = null;
      return;
    }

    loadingIdRef.current = activePageId;

    void getPage(activePageId).then((loaded) => {
      // Only apply if this is still the page we want
      if (loadingIdRef.current === activePageId) {
        setLoadedPage(loaded);
      }
    });
  }, [activePageId, getPage]);

  // Listen for external updates to the active page (e.g. from other contexts)
  useEffect(() => {
    return on("page:updated", (updated) => {
      if (updated.id === loadingIdRef.current) {
        setLoadedPage(updated);
      }
    });
  }, [on]);

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
    return {
      ...loadedPage,
      scheduledStart: summary.scheduledStart,
      scheduledEnd: summary.scheduledEnd,
      status: summary.status,
      priority: summary.priority,
      durationMinutes: summary.durationMinutes,
      title: summary.title,
      subtitle: summary.subtitle,
      tags: summary.tags,
      folderId: summary.folderId,
    };
  })();
  const isLoading = activePageId !== null && page === null;

  return { page, isLoading };
}
