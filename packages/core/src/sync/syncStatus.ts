import type { AccountWithCalendars, CalendarSyncResult, SyncCalendar } from "../types";

// Four-state calendar health, derived not persisted: the read model only has
// `enabled` + `lastSyncedAt`, so a resync result (when in hand) sharpens the
// verdict — offline/reconnect aren't otherwise visible.
export type SyncDotState = "active" | "off" | "stale" | "error";

// Enabled but no successful poll within this window → stale. Poll interval is
// ~5 min, so this gives a few intervals' grace (e.g. after the app was asleep)
// absent a fresher resync result.
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

// An account is "Reconnect needed" the moment any calendar's last resync surfaced
// a credential failure — an account-wide auth problem, not per-calendar.
//
// `persisted` is the account's stored flag, and it carries the case a resync result
// cannot: a background pass hit the rejection, so nothing in this session has a
// result to report, and the scheduler has since dropped the account from the poll
// loop. Without it a dead credential reads as "Connected" until someone resyncs by
// hand.
export function accountConnectionState(
  statuses: readonly (CalendarSyncResult["status"] | undefined)[],
  persisted = false
): AccountConnectionState {
  const rejected = persisted || statuses.some((s) => s === "reconnectNeeded");
  return rejected ? "reconnectNeeded" : "connected";
}

// A calendar that hasn't synced for this long may be showing events that have since
// moved or gone, so the app says so where the calendar is, not only in Settings. The
// scheduler's reminder note uses the same hour (`CALENDAR_OUT_OF_DATE_AFTER`).
export const NOT_SYNCING_AFTER_MS = 60 * 60 * 1000;

// A pass this long after a calendar's last stamp has had its chance to update it. The
// stamp lands during the pass and the pass event after every account, so a calendar
// the pass did reach sits within a few seconds of it.
const PASS_GRACE_MS = 60 * 1000;

export interface AccountNotSyncing {
  account: AccountWithCalendars;
  reason: "reconnectNeeded" | "unreachable";
  /** The oldest last sync among its enabled calendars, when one ever synced. */
  lastSyncedAt: string | null;
}

/**
 * Accounts whose events may be out of date: one that needs reconnecting, which the
 * background pass has stopped polling, or one with an enabled calendar a sync pass
 * failed to update for over an hour.
 *
 * `lastPassAt` is when the latest sync pass ended, read together with `accounts`.
 * Only a pass can show a calendar is unreachable: after the Mac sleeps every
 * calendar's last sync is hours old until the first pass after waking, and that
 * pass usually succeeds. An account with no enabled calendar shows no events, so
 * it has nothing to warn about.
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
