import type { PageSummary } from "@pikos/core";
import { useEffect, useState } from "react";

import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { createLogger } from "@/shared/logger";

const log = createLogger("useBacklinks");

export function useBacklinks(pageId: string): PageSummary[] {
  const { storage } = useWorkspace();
  const [backlinks, setBacklinks] = useState<PageSummary[]>([]);

  useEffect(() => {
    if (!storage) return;

    let cancelled = false;
    storage
      .listBacklinks(pageId)
      .then((rows) => {
        if (!cancelled) setBacklinks(rows);
      })
      .catch((e: unknown) => {
        log.warn(`listing backlinks to page ${pageId} failed`, e);
      });
    return () => {
      cancelled = true;
    };
  }, [storage, pageId]);

  return backlinks;
}
