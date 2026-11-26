import { isTimedIso } from "../utils/dates";

/** Strips markdown formatting from titles before storing or previewing. */
export function cleanTitle(title: string): string {
  return title
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .trim();
}

export function formatSchedule(scheduledStart: string): string {
  const hasTime = isTimedIso(scheduledStart);
  const d = new Date(hasTime ? scheduledStart : `${scheduledStart}T00:00:00`);
  if (isNaN(d.getTime())) return scheduledStart;

  const month = d.toLocaleDateString(undefined, { month: "short" });
  const day = d.getDate();

  if (!hasTime) return `${month} ${day}`;

  const time = d
    .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    .toLowerCase();
  return `${month} ${day}, ${time}`;
}

export function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
