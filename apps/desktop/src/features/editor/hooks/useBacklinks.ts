import type { PageSummary } from "@pikos/core";
import { useEffect, useState } from "react";

import { useWorkspace } from "@/shared/context/WorkspaceContext";

export function useBacklinks(pageId: string): PageSummary[] {
  const { storage } = useWorkspace();
  const [backlinks, setBacklinks] = useState<PageSummary[]>([]);

  useEffect(() => {
    if (!storage) return;

    let cancelled = false;
    void storage.listBacklinks(pageId).then((rows) => {
      if (!cancelled) setBacklinks(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [storage, pageId]);

  return backlinks;
}
