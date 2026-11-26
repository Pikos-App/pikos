import { listen } from "@tauri-apps/api/event";

import { IS_TEST_MODE } from "@/shared/constants/testMode";

/**
 * Listen for an event Rust emits to the window, such as an outside change to the database. Test
 * builds have no Tauri event channel, so they listen on an in-page emitter fired with
 * `window.__PIKOS_E2E_EMIT__(event)`: a test can write through the bridge and ring the bell sync
 * and the CLI ring, instead of a page reload, which empties every cache and proves nothing.
 */
export function listenAppEvent(event: string, handler: () => void): Promise<() => void> {
  if (!IS_TEST_MODE) return listen(event, handler);
  const handlers = testHandlers.get(event) ?? new Set<() => void>();
  testHandlers.set(event, handlers);
  handlers.add(handler);
  return Promise.resolve(() => handlers.delete(handler));
}

const testHandlers = new Map<string, Set<() => void>>();

if (IS_TEST_MODE) {
  (globalThis as { __PIKOS_E2E_EMIT__?: (event: string) => void }).__PIKOS_E2E_EMIT__ = (event) => {
    for (const handler of testHandlers.get(event) ?? []) handler();
  };
}
