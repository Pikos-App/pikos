import type { SearchResponse, StorageAdapter } from "@pikos/core";
import type { Editor } from "@tiptap/react";
import { useEffect } from "react";

import { usePages } from "@/shared/context/PagesContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import type { FindLinkTargets, LinkTarget } from "../components/PageLinkPicker";

const PICKER_LIMIT = 8;

/** Recent pages before anything is typed, then the pages whose titles match. The open page is
 *  never offered as its own link. */
export function linkTargetFinder(
  storage: Pick<StorageAdapter, "listRecentPages">,
  searchPages: (query: string, includeCompleted?: boolean) => Promise<SearchResponse>,
  pageId: string | null
): FindLinkTargets {
  return async (query) => {
    if (!query) {
      const recent = await storage.listRecentPages(pageId, PICKER_LIMIT);
      return recent.map(({ id, title }): LinkTarget => ({ id, title }));
    }

    const { results } = await searchPages(query, true);
    return results
      .filter((r) => r.id !== pageId && (r.matchSource === "title" || r.matchSource === "both"))
      .slice(0, PICKER_LIMIT)
      .map(({ id, title }) => ({ id, title }));
  };
}

/** Points the editor's `[[` picker at this workspace. */
export function usePageLinkTargets(editor: Editor | null, pageId: string | null): void {
  const { searchPages } = usePages();
  const { storage } = useWorkspace();

  useEffect(() => {
    if (!editor || editor.isDestroyed || !storage) return;

    editor.commands.setLinkTargetFinder(linkTargetFinder(storage, searchPages, pageId));
  }, [editor, pageId, searchPages, storage]);
}
