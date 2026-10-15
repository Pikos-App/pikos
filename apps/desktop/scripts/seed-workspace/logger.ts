// Stands in for `@/shared/logger` in the seed-workspace bundle. A seed writes
// far faster than a render loop could, so the adapter's IPC watchdog would
// otherwise report every burst as a runaway component.

import type { Logger } from "@/shared/logger";

const silent = (): void => {};

export function createLogger(): Logger {
  return { debug: silent, error: silent, info: silent, warn: silent };
}
