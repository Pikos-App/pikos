// Reloads the workspace when another process (the CLI, or a second app instance)
// writes the DB. The Rust watcher emits "workspace:external-change"; we ignore the
// echo of our own writes via the suppression window, then reload. Mount once at the
// app shell.

import { useReloadOnEvent } from "@/shared/hooks/useReloadOnEvent";
import { externalChangeSuppressed } from "@/shared/lib/externalChange";

export function useExternalChangeReload(): void {
  useReloadOnEvent({
    event: "workspace:external-change",
    logMessage: "external workspace change detected — reloading",
    logScope: "external-change",
    suppressed: externalChangeSuppressed,
  });
}
