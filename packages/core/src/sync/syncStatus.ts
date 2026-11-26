import type { AccountWithCalendars, CalendarSyncResult, SyncCalendar } from "../types";

// Calendar health is derived, not persisted: the read model has only `enabled` and
// `lastSyncedAt`, so a resync result, when in hand, sharpens the verdict (offline and reconnect
// aren't otherwise visible).
export type SyncDotState = "active" | "off" | "stale" | "error";

// Enabled with no successful poll in this window is stale. Polling is every ~5 min, so this
// leaves a few intervals' grace (after the app slept) absent a fresher resync result.
export const STALE_AFTER_MS = 15 * 60 * 1000;

export interface SyncDotMeta {
  state: SyncDotState;
  label: string;
}

const DOT_LABEL: Record<SyncDotState, string> = {
  active: "Synced",
  error: "Reconnect needed",
  off: "Off",
  stale: "Stale",
};

export function calendarSyncDot(
  cal: Pick<SyncCalendar, "enabled" | "lastSyncedAt">,
  lastResult?: CalendarSyncResult["status"],
  now: Date = new Date()
): SyncDotMeta {
  const state = calendarSyncState(cal, lastResult, now);
  return { label: DOT_LABEL[state], state };
}

function calendarSyncState(
  cal: Pick<SyncCalendar, "enabled" | "lastSyncedAt">,
  lastResult: CalendarSyncResult["status"] | undefined,
  now: Date
): SyncDotState {
  if (!cal.enabled) return "off";
  if (lastResult === "reconnectNeeded") return "error";
  if (lastResult === "offline") return "stale";
  if (lastResult === "synced") return "active";
  if (cal.lastSyncedAt && now.getTime() - new Date(cal.lastSyncedAt).getTime() < STALE_AFTER_MS) {
    return "active";
  }
  return "stale";
}

export type AccountConnectionState = "connected" | "reconnectNeeded";

// An account needs reconnecting the moment any calendar's last resync surfaced a credential
// failure, an account-wide problem. `persisted` is the stored flag, carrying the case a resync
// result can't: a background pass hit the rejection and the scheduler dropped the account from
// polling, so nothing this session has a result. Without it a dead credential reads "Connected"
// until someone resyncs by hand.
export function accountConnectionState(
  statuses: readonly (CalendarSyncResult["status"] | undefined)[],
  persisted = false
): AccountConnectionState {
  const rejected = persisted || statuses.some((s) => s === "reconnectNeeded");
  return rejected ? "reconnectNeeded" : "connected";
}

// A calendar unsynced this long may show events that have moved or gone, so the app says so where
// the calendar is. The scheduler's reminder note uses the same hour (`CALENDAR_OUT_OF_DATE_AFTER`).
export const NOT_SYNCING_AFTER_MS = 60 * 60 * 1000;

// A pass this long after a calendar's last stamp has had its chance to update it: the stamp lands
// during the pass and the pass event after every account, so a reached calendar sits within
// seconds of it.
const PASS_GRACE_MS = 60 * 1000;

export interface AccountNotSyncing {
  account: AccountWithCalendars;
  reason: "reconnectNeeded" | "unreachable";
  /** The oldest last sync among its enabled calendars, when one ever synced. */
  lastSyncedAt: string | null;
}

/**
 * Accounts whose events may be out of date: one needing reconnect, which the background pass
 * stopped polling, or one with an enabled calendar a pass failed to update for over an hour.
 *
 * `lastPassAt` is when the latest pass ended, read with `accounts`: only a pass shows a calendar
 * is unreachable, since after the Mac sleeps every last sync is hours old until the first pass
 * after waking. An account with no enabled calendar shows no events, so has nothing to warn about.
 */
export function accountsNotSyncing(
  accounts: readonly AccountWithCalendars[],
  lastPassAt: Date | null,
  now: Date = new Date()
): AccountNotSyncing[] {
  const out: AccountNotSyncing[] = [];
  for (const account of accounts) {
    const enabled = account.calendars.filter((c) => c.enabled);
    if (enabled.length === 0) continue;
    const oldest = oldestSync(enabled);
    if (account.reconnectNeeded) {
      out.push({ account, lastSyncedAt: oldest, reason: "reconnectNeeded" });
      continue;
    }
    if (!lastPassAt) continue;
    const missed = enabled.some((c) => {
      if (!c.lastSyncedAt) return false;
      const at = new Date(c.lastSyncedAt).getTime();
      return at < lastPassAt.getTime() - PASS_GRACE_MS && now.getTime() - at > NOT_SYNCING_AFTER_MS;
    });
    if (missed) out.push({ account, lastSyncedAt: oldest, reason: "unreachable" });
  }
  return out;
}

function oldestSync(calendars: readonly SyncCalendar[]): string | null {
  let oldest: string | null = null;
  for (const c of calendars) {
    if (c.lastSyncedAt && (!oldest || new Date(c.lastSyncedAt) < new Date(oldest))) {
      oldest = c.lastSyncedAt;
    }
  }
  return oldest;
}
