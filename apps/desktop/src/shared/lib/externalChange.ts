// Live-refresh suppression for the cross-process DB watcher.
//
// The Rust watcher emits "workspace:external-change" on ANY change to the
// workspace SQLite file — including the app's own writes. We don't want to
// refetch on our own writes (the UI already updated optimistically), so each
// local mutation opens a short suppression window; a change event inside that
// window is treated as our own echo and ignored. An external write (the CLI,
// or another app instance) has no recent local write, so it triggers a reload.

const SUPPRESS_WINDOW_MS = 1500;

let suppressUntil = 0;

/** Call right before/after issuing a local write command. */
export function markLocalWrite(): void {
  suppressUntil = Date.now() + SUPPRESS_WINDOW_MS;
}

/** True when a change event should be ignored as the echo of a local write. */
export function externalChangeSuppressed(): boolean {
  return Date.now() < suppressUntil;
}
