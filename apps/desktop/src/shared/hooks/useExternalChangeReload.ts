// Reloads when another process (the CLI, a second app instance) writes the DB. Our own writes'
// echo is ignored via the suppression window.

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
