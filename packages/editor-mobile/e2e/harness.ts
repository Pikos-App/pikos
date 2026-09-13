import type { Page } from "@playwright/test";

/** One message the editor sent to the host. */
export interface HostMessage {
  v: number;
  type: string;
  payload: Record<string, unknown>;
}

declare global {
  interface Window {
    __pikosMessages?: HostMessage[];
  }
}

/**
 * Install a stand-in for the WKWebView host before the page loads.
 *
 * `addInitScript` runs before any page script, which matters: the editor sends
 * `ready` during startup, and a handler installed after load would miss it —
 * the one message whose timing is part of what is being tested.
 */
export async function installFakeHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__pikosMessages = [];
    // Shape matches what WKWebView injects.
    (window as unknown as Record<string, unknown>)["webkit"] = {
      messageHandlers: {
        pikos: {
          postMessage: (message: unknown) => {
            window.__pikosMessages!.push(message as HostMessage);
          },
        },
      },
    };
  });
}

/** Every message the editor has sent so far. */
export async function messages(page: Page): Promise<HostMessage[]> {
  return page.evaluate(() => window.__pikosMessages ?? []);
}

/** Messages of one type. */
export async function messagesOfType(page: Page, type: string): Promise<HostMessage[]> {
  return (await messages(page)).filter((m) => m.type === type);
}

/** Send a message to the editor, as the host would. */
export async function sendToEditor(
  page: Page,
  type: string,
  payload: Record<string, unknown>,
  version = 1
): Promise<void> {
  await page.evaluate(
    ([t, p, v]) => {
      window.pikosEditor!.receive({ payload: p, type: t, v });
    },
    [type, payload, version] as const
  );
}

/** Clear the captured messages, so an assertion is about what follows. */
export async function clearMessages(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__pikosMessages = [];
  });
}

/** A document with one paragraph of the given text. */
export function docWithText(text: string): string {
  return JSON.stringify({
    content: [{ content: [{ text, type: "text" }], type: "paragraph" }],
    type: "doc",
  });
}

/** A document with one paragraph containing a single link. */
export function docWithLink(text: string, href: string): string {
  return JSON.stringify({
    content: [
      {
        content: [{ marks: [{ attrs: { href }, type: "link" }], text, type: "text" }],
        type: "paragraph",
      },
    ],
    type: "doc",
  });
}
