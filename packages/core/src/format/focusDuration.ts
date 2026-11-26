// Here and not in the editor's hook because the phone runs the same timer and must say the same
// things ("24 minutes" on one device, "24 min" on the other). `crates/pikos-core/src/focus.rs` is
// the Rust half and is graded against this.
//
// Timing stays with each app. A running session is never persisted: a session whose end the app
// didn't see is a guess, and a guess in a total is worse than a missing session.

/** Shortest session worth recording, in seconds. Without the floor, opening a page and tapping
 *  play fills the card with one-second rows that inflate the count and add no minutes. */
export const MIN_SESSION_S = 30;

/** Whole units for the end-of-session notice: "24 minutes", never "24:07". */
export function formatSessionLength(totalSeconds: number): string {
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourPart = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rest === 0 ? hourPart : `${hourPart} ${rest} min`;
}

/** `M:SS`, or `H:MM:SS` once an hour is up. The caller sets it monospaced so digits don't shuffle. */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
