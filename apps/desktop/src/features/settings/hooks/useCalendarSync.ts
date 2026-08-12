import type { AccountWithCalendars, CalendarSyncResult, NewCaldavConnection } from "@pikos/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

import { usePages } from "@/shared/context/PagesContext";
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

// Connect shows its own inline error in AddAccountDialog. Other actions (menu
// items, toggles) have no local error path, so a rejection would otherwise look
// like nothing happened — the hook catches it and exposes `error` for the panel.
function actionError(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export interface CalendarSyncState {
  accounts: AccountWithCalendars[];
  results: ResultMap;
  loading: boolean;
  busyAccountId: string | null;
  error: string | null;
  connect: (data: NewCaldavConnection) => Promise<void>;
  connectGoogle: () => Promise<void>;
  reconnect: (accountId: string, password: string) => Promise<void>;
  reconnectGoogle: (accountId: string) => Promise<void>;
  /** False in a build without the Google OAuth client — the picker disables it. */
  googleAvailable: boolean;
  disconnect: (accountId: string) => Promise<void>;
  toggleCalendar: (calendarRowId: string, enabled: boolean, color: string | null) => Promise<void>;
  recolorCalendar: (calendarRowId: string, enabled: boolean, color: string) => Promise<void>;
  resync: (accountId: string) => Promise<void>;
}

export function useCalendarSync(): CalendarSyncState {
  const { reload, storage } = useWorkspace();
  const { patchFolderColor } = usePages();
  const [accounts, setAccounts] = useState<AccountWithCalendars[]>([]);
  const [results, setResults] = useState<ResultMap>({});
  const [loading, setLoading] = useState(true);
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [googleAvailable, setGoogleAvailable] = useState(false);

  useEffect(() => {
    if (!storage) return;
    let cancelled = false;
    void storage.getSyncStatus().then((next) => {
      if (cancelled) return;
      setAccounts(next);
      setLoading(false);
    });
    void storage.googleSyncAvailable().then((next) => {
      if (!cancelled) setGoogleAvailable(next);
    });
    return () => {
      cancelled = true;
    };
  }, [storage]);

  async function refresh() {
    if (!storage) return;
    setAccounts(await storage.getSyncStatus());
  }

  // The dot and "synced N ago" read `lastSyncedAt`, which the *backfill* stamps —
  // and enabling a calendar only pokes that backfill, so it lands after this hook's
  // own post-toggle read. Without this the row keeps showing a pre-sync snapshot
  // (stale dot, no timestamp) until some other panel action happens to re-read.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen("calendar-sync:pass", () => void refreshRef.current())
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch(() => {
        /* listener failed to attach; the panel just stays on its last read */
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  async function connect(data: NewCaldavConnection) {
    if (!storage) return;
    setError(null);
    await storage.connectCaldavAccount(data);
    await refresh();
  }

  // Rejections propagate to AddAccountDialog, which owns the inline error for
  // both connect paths — same contract as `connect`.
  async function connectGoogle() {
    if (!storage) return;
    setError(null);
    await storage.connectGoogleAccount();
    await refresh();
  }

  // Both reconnect paths resync straight away: the account has been out of the
  // background pass since the flag was set (`load_accounts` filters on it), so
  // without this its calendars sit stale until the next interval tick.
  // Rejections propagate to the dialog, which owns the inline error.
  async function reconnect(accountId: string, password: string) {
    if (!storage) return;
    setError(null);
    await storage.reconnectCaldavAccount(accountId, password);
    await refresh();
    await resync(accountId);
  }

  async function reconnectGoogle(accountId: string) {
    if (!storage) return;
    setError(null);
    await storage.connectGoogleAccount();
    await refresh();
    await resync(accountId);
  }

  async function disconnect(accountId: string) {
    if (!storage) return;
    setError(null);
    const rowIds = accounts.find((a) => a.id === accountId)?.calendars.map((c) => c.id) ?? [];
    try {
      await storage.disconnectSyncAccount(accountId);
    } catch (e) {
      setError(actionError(e, "Couldn't disconnect the account. Try again."));
      return;
    }
    setResults((prev) => prune(prev, rowIds));
    await refresh();
    // Sidebar folders/pages live in PagesContext, not this hook — reload so the
    // removed external folders disappear without a manual refresh.
    await reload();
  }

  // Clears any stale result for this calendar on toggle, so its dot falls back to
  // the derived (off/stale) state instead of showing a dead verdict from before.
  async function toggleCalendar(calendarRowId: string, enabled: boolean, color: string | null) {
    if (!storage) return;
    setError(null);
    try {
      await storage.toggleSyncCalendar(calendarRowId, enabled, color);
    } catch (e) {
      setError(actionError(e, "Couldn't update the calendar. Try again."));
      return;
    }
    setResults((prev) => prune(prev, [calendarRowId]));
    await refresh();
    // Enabling creates the external folder; disabling removes/de-flags it —
    // reload PagesContext so the sidebar reflects the change immediately.
    await reload();
  }

  // An enabled calendar's folder already exists; a disabled one has none to repaint.
  async function recolorCalendar(calendarRowId: string, enabled: boolean, color: string) {
    if (!storage) return;
    setError(null);
    const folderId = accounts
      .flatMap((a) => a.calendars)
      .find((c) => c.id === calendarRowId)?.folderId;
    try {
      await storage.toggleSyncCalendar(calendarRowId, enabled, color);
    } catch (e) {
      setError(actionError(e, "Couldn't update the calendar colour. Try again."));
      return;
    }
    await refresh();
    if (folderId) patchFolderColor(folderId, color);
  }

  async function resync(accountId: string) {
    if (!storage) return;
    setError(null);
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
      // A resync can upsert/remove pages — reload PagesContext so the calendar
      // reflects the result without waiting for the next background pass.
      await reload();
    } catch (e) {
      setError(actionError(e, "Couldn't sync right now. Check your connection and try again."));
    } finally {
      setBusyAccountId(null);
    }
  }

  return {
    accounts,
    busyAccountId,
    connect,
    connectGoogle,
    disconnect,
    error,
    googleAvailable,
    loading,
    recolorCalendar,
    reconnect,
    reconnectGoogle,
    results,
    resync,
    toggleCalendar,
  };
}
