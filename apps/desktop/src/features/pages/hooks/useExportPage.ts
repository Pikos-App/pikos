import type { PageSummary } from "@pikos/core";
import { storageErrorUserMessage, toStorageError } from "@pikos/core";

import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { createLogger } from "@/shared/logger";
import { getPlatform } from "@/shared/platform";

const log = createLogger("exportPage");

/** Writes one page to Downloads as Markdown and shows it in Finder, where it can be dragged
 *  into a chat or a mail. */
export function useExportPage() {
  const { storage } = useWorkspace();
  const { showNotice } = useUndoDelete();

  async function exportPage(page: Pick<PageSummary, "id">): Promise<void> {
    if (!storage) return;

    let path: string;
    try {
      path = await storage.exportPageMarkdown(page.id);
    } catch (e: unknown) {
      showNotice(storageErrorUserMessage(toStorageError(e), "exporting the page"), 6000);
      return;
    }

    showNotice("Exported to Downloads");
    try {
      await getPlatform().revealInDir(path);
    } catch (e: unknown) {
      log.warn("revealInDir failed after a page export", e);
    }
  }

  return { exportPage };
}
