/** Local wall-clock ISO datetime string ('YYYY-MM-DDTHH:MM:SS').
 *  Same format used for scheduledStart timed events — no Z suffix, no UTC conversion. */
export function nowLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
