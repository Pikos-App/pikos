import type { AccountWithCalendars, Folder } from "@pikos/core";
import { useEffect, useState } from "react";

import { useWorkspace } from "@/shared/context/WorkspaceContext";

export interface CalendarAccountGroup {
  accountId: string | null;
  /** Null for folders with no live account row — the frame before the read resolves, or a dormant account. */
  accountName: string | null;
  folders: Folder[];
}

/**
 * Groups synced-calendar folders by owning account, preserving the given folder
 * order. One group means there is nothing to disambiguate, so the caller renders
 * it without a heading — as it does for the unnamed group, which would otherwise
 * flash an empty heading before the account read resolves.
 */
export function useCalendarAccountGroups(externalFolders: Folder[]): CalendarAccountGroup[] {
  const { storage } = useWorkspace();
  const [accounts, setAccounts] = useState<AccountWithCalendars[]>([]);

  // Re-read on the folder set rather than on a sync event: every account change
  // that matters here — connect, disconnect, calendar toggle — adds or removes
  // an external folder, and nothing else moves a folder between accounts.
  const folderKey = externalFolders.map((f) => f.id).join(",");
  useEffect(() => {
    if (!storage || !folderKey) return;
    let cancelled = false;
    void storage.getSyncStatus().then((next) => {
      if (!cancelled) setAccounts(next);
    });
    return () => {
      cancelled = true;
    };
  }, [storage, folderKey]);

  const accountByFolderId = new Map<string, AccountWithCalendars>();
  for (const account of accounts) {
    for (const calendar of account.calendars) {
      if (calendar.folderId) accountByFolderId.set(calendar.folderId, account);
    }
  }

  const groups: CalendarAccountGroup[] = [];
  const byAccountId = new Map<string, CalendarAccountGroup>();
  const unlinked: Folder[] = [];

  for (const folder of externalFolders) {
    const account = accountByFolderId.get(folder.id);
    if (!account) {
      unlinked.push(folder);
      continue;
    }
    let group = byAccountId.get(account.id);
    if (!group) {
      group = { accountId: account.id, accountName: account.displayName, folders: [] };
      byAccountId.set(account.id, group);
      groups.push(group);
    }
    group.folders.push(folder);
  }
  if (unlinked.length > 0) groups.push({ accountId: null, accountName: null, folders: unlinked });

  return groups;
}
