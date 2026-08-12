import type { CalendarSyncResult, SyncCalendar } from "@pikos/core";

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
