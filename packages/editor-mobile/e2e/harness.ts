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
 * Install a stand-in for the WKWebView host before the page loads, so the `ready` the editor
 * sends during startup is not missed.
 */
export async function installFakeHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__pikosMessages = [];
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

export async function messages(page: Page): Promise<HostMessage[]> {
  return page.evaluate(() => window.__pikosMessages ?? []);
}

export async function messagesOfType(page: Page, type: string): Promise<HostMessage[]> {
  return (await messages(page)).filter((m) => m.type === type);
}

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

export async function clearMessages(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__pikosMessages = [];
  });
}

export function docWithText(text: string): string {
  return JSON.stringify({
    content: [{ content: [{ text, type: "text" }], type: "paragraph" }],
    type: "doc",
  });
}

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
