import type { AccountWithCalendars, CalendarSyncResult, NewCaldavConnection } from "@pikos/core";
import { useEffect, useState } from "react";

import { useWorkspace } from "@/shared/context/WorkspaceContext";

// Last resync outcome keyed by sync_calendar ROW id (not the provider
// calendarId, which can repeat across two accounts). Sharpens the status dot
// beyond what the persisted read model (enabled + lastSyncedAt) can show.
type ResultMap = Record<string, CalendarSyncResult["status"]>;

function prune(results: ResultMap, rowIds: string[]): ResultMap {
  if (!rowIds.some((id) => id in results)) return results;
  const next = { ...results };
  for (const id of rowIds) delete next[id];
  return next;
}

export interface CalendarSyncState {
  accounts: AccountWithCalendars[];
  results: ResultMap;
  loading: boolean;
  busyAccountId: string | null;
  connect: (data: NewCaldavConnection) => Promise<void>;
  disconnect: (accountId: string) => Promise<void>;
  toggleCalendar: (calendarRowId: string, enabled: boolean, color: string | null) => Promise<void>;
  recolorCalendar: (calendarRowId: string, enabled: boolean, color: string) => Promise<void>;
  resync: (accountId: string) => Promise<void>;
}

export function useCalendarSync(): CalendarSyncState {
  const { storage } = useWorkspace();
  const [accounts, setAccounts] = useState<AccountWithCalendars[]>([]);
  const [results, setResults] = useState<ResultMap>({});
  const [loading, setLoading] = useState(true);
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);

  useEffect(() => {
    if (!storage) return;
    let cancelled = false;
    void storage.getSyncStatus().then((next) => {
      if (cancelled) return;
      setAccounts(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [storage]);

  async function refresh() {
    if (!storage) return;
    setAccounts(await storage.getSyncStatus());
  }

  async function connect(data: NewCaldavConnection) {
    if (!storage) return;
    await storage.connectCaldavAccount(data);
    await refresh();
  }

  async function disconnect(accountId: string) {
    if (!storage) return;
    const rowIds = accounts.find((a) => a.id === accountId)?.calendars.map((c) => c.id) ?? [];
    await storage.disconnectSyncAccount(accountId);
    setResults((prev) => prune(prev, rowIds));
    await refresh();
  }

  // Toggling clears any stale result for this calendar so its dot falls back to
  // the derived (off/stale) state until the next resync, rather than showing a
  // dead verdict from before it was disabled.
  async function toggleCalendar(calendarRowId: string, enabled: boolean, color: string | null) {
    if (!storage) return;
    await storage.toggleSyncCalendar(calendarRowId, enabled, color);
    setResults((prev) => prune(prev, [calendarRowId]));
    await refresh();
  }

  async function recolorCalendar(calendarRowId: string, enabled: boolean, color: string) {
    if (!storage) return;
    await storage.toggleSyncCalendar(calendarRowId, enabled, color);
    await refresh();
  }

  async function resync(accountId: string) {
    if (!storage) return;
    setBusyAccountId(accountId);
    try {
      const outcomes = await storage.resyncSyncAccount(accountId);
      const byCalendarId = new Map(
        accounts.find((a) => a.id === accountId)?.calendars.map((c) => [c.calendarId, c.id]) ?? []
      );
      setResults((prev) => {
        const next = { ...prev };
        for (const o of outcomes) {
          const rowId = byCalendarId.get(o.calendarId);
          if (rowId) next[rowId] = o.status;
        }
        return next;
      });
      await refresh();
    } finally {
      setBusyAccountId(null);
    }
  }

  return {
    accounts,
    busyAccountId,
    connect,
    disconnect,
    loading,
    recolorCalendar,
    results,
    resync,
    toggleCalendar,
  };
}
