// How a focus session's length is written, and the floor below which one is not
// worth recording.
//
// Here rather than in the editor's hook because the phone runs the same timer
// and has to say the same things: "24 minutes" on one device and "24 min" on the
// other is the kind of drift nobody notices until both are on screen at once.
// `crates/pikos-core/src/focus.rs` is the Rust half and is graded against this.
//
// The timing itself stays with each app. A running session is never persisted —
// a session whose end the app did not see is a guess, and a guess in a total is
// worse than a missing session — so what is shared is only what happens when one
// stops.

/** Shortest session worth recording, in seconds.
 *
 *  Opening a page, tapping play and moving on is not focus time. Without the
 *  floor the card fills with one-second rows that inflate the session count
 *  while adding nothing to the minutes. */
export const MIN_SESSION_S = 30;

/** Whole units for the end-of-session notice: a session is worth reporting as
 *  "24 minutes", never as "24:07" — the seconds are precision nobody asked for
 *  once the thing being measured is over. */
export function formatSessionLength(totalSeconds: number): string {
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourPart = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rest === 0 ? hourPart : `${hourPart} ${rest} min`;
}

/** `M:SS`, or `H:MM:SS` once an hour is up — read at a glance while the session
 *  runs, and monospaced by the caller so the digits don't shuffle as they
 *  tick. */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
