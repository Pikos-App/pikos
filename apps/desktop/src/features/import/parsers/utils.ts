// Shared import utilities — used by both hooks and preview components.

/** Strip markdown formatting from titles before storing in DB or displaying in preview. */
export function cleanTitle(title: string): string {
  return title
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [text](url) → text
    .replace(/\*\*(.+?)\*\*/g, "$1") // **bold** → bold
    .replace(/\*(.+?)\*/g, "$1") // *italic* → italic
    .replace(/__(.+?)__/g, "$1") // __bold__ → bold
    .replace(/_(.+?)_/g, "$1") // _italic_ → italic
    .trim();
}

/** Format a scheduled date for compact display: "Apr 8" or "Apr 8, 2pm" */
export function formatSchedule(scheduledStart: string): string {
  const hasTime = scheduledStart.includes("T");
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

/** Format an ISO timestamp as a relative time string (e.g. "just now", "5m ago", "2h ago"). */
export function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
