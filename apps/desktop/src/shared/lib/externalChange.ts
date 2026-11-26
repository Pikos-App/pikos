// The Rust watcher emits "workspace:external-change" on ANY change to the workspace file,
// including the app's own writes, which the UI already applied optimistically. Each local mutation
// opens a short suppression window and a change event inside it is ignored as our own echo; an
// external write (the CLI, another instance) has no recent local write and triggers a reload.

const SUPPRESS_WINDOW_MS = 1500;

let suppressUntil = 0;

export function markLocalWrite(): void {
  suppressUntil = Date.now() + SUPPRESS_WINDOW_MS;
}

export function externalChangeSuppressed(): boolean {
  return Date.now() < suppressUntil;
}
