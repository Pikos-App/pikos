// The webview half of the editor bridge. Outside a WKWebView, where the host's message
// handler is absent, it logs instead of throwing, so the editor runs in a plain DOM.

import type { WebviewToHostPayload, WebviewToHostType } from "./protocol";
import { envelope } from "./protocol";

interface WebKitMessageHandler {
  postMessage: (message: unknown) => void;
}

interface WebKitWindow {
  webkit?: { messageHandlers?: Record<string, WebKitMessageHandler | undefined> };
}

const HANDLER_NAME = "pikos";

function handler(): WebKitMessageHandler | null {
  const w = window as unknown as WebKitWindow;
  return w.webkit?.messageHandlers?.[HANDLER_NAME] ?? null;
}

/**
 * Fire-and-forget: the host replies, when it needs to, with a message of its own. A
 * request/response shape would need correlation ids and timeouts for a webview reloaded
 * mid-flight.
 */
export function send<T extends WebviewToHostType>(
  type: T,
  payload: WebviewToHostPayload<T>
): void {
  const post = handler();
  const message = envelope(type, payload);
  if (post) {
    post.postMessage(message);
    return;
  }
  // eslint-disable-next-line no-console
  console.debug("[pikos-bridge] no host; would send", message);
}

export function hasHost(): boolean {
  return handler() !== null;
}

/**
 * Trailing-edge debounce. Each document change carries the full document and its plain text
 * across the bridge, which is felt at typing speed, so the editor coalesces before sending.
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number
): ((...args: A) => void) & { flush: () => void; cancel: () => void; isPending: () => boolean } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const run = () => {
    timer = null;
    if (pending) {
      const args = pending;
      pending = null;
      fn(...args);
    }
  };

  const wrapped = (...args: A) => {
    pending = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };

  // Flush on backgrounding: iOS may suspend the process, taking a pending debounce with it.
  wrapped.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      run();
    }
  };
  wrapped.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  wrapped.isPending = () => timer !== null;

  return wrapped;
}
