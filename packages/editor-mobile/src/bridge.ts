// The webview half of the editor bridge.
//
// Isolates every assumption about the host so the editor itself stays testable
// in a plain DOM. In a WKWebView the host installs
// `window.webkit.messageHandlers.pikos`; outside one — a browser, a test — that
// object is absent, and this falls back to logging rather than throwing, so the
// editor can be opened and poked at without a native shell.

import type { WebviewToHostPayload, WebviewToHostType } from "./protocol";
import { envelope } from "./protocol";

interface WebKitMessageHandler {
  postMessage: (message: unknown) => void;
}

interface WebKitWindow {
  webkit?: { messageHandlers?: Record<string, WebKitMessageHandler | undefined> };
}

/** Name the host registers its handler under. */
const HANDLER_NAME = "pikos";

function handler(): WebKitMessageHandler | null {
  const w = window as unknown as WebKitWindow;
  return w.webkit?.messageHandlers?.[HANDLER_NAME] ?? null;
}

/**
 * Send a message to the host.
 *
 * Fire-and-forget by design. The bridge is one-way per message and the host
 * replies, when it needs to, with a message of its own — a request/response
 * shape would need correlation ids and timeouts to handle a webview that is
 * reloaded mid-flight, and nothing here needs an answer.
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
  // Running outside a WKWebView. Useful during development, and harmless.
  // eslint-disable-next-line no-console
  console.debug("[pikos-bridge] no host; would send", message);
}

/** True when running inside the native shell. */
export function hasHost(): boolean {
  return handler() !== null;
}

/**
 * Debounce a function on a trailing edge.
 *
 * Document changes fire on every keystroke, and each one carries the full
 * document plus its extracted plain text across the bridge. At typing speed
 * that is enough serialisation to be felt, which is the thing the M0 spike is
 * measuring, so the editor coalesces before sending.
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number
): ((...args: A) => void) & { flush: () => void; cancel: () => void } {
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

  // Flush exists for the moment the app is backgrounded: iOS can suspend a
  // process shortly after, and a pending debounce would take the user's last
  // few keystrokes with it.
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

  return wrapped;
}
