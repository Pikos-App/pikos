import type { CalendarSyncResult, SyncCalendar } from "@pikos/core";

// Per-calendar health as a four-state dot. Derived, not persisted: the read
// model only carries `enabled` + `lastSyncedAt`, so a fresh resync result (when
// one is in hand) sharpens the verdict — offline/reconnect aren't otherwise
// visible.
export type SyncDotState = "active" | "off" | "stale" | "error";

// Enabled but no successful poll within this window → stale dot. The poll
// interval is ~5 min, so this is a few intervals' grace before flagging stale
// (e.g. after the app was asleep), absent a fresher resync result.
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

// An account is "Reconnect needed" the moment any of its calendars surfaced a
// credential failure on the last resync — that's an account-wide auth problem,
// not per-calendar.
export function accountConnectionState(
  statuses: readonly (CalendarSyncResult["status"] | undefined)[]
): AccountConnectionState {
  return statuses.some((s) => s === "reconnectNeeded") ? "reconnectNeeded" : "connected";
}
