import { expect, test } from "@playwright/test";

import {
  clearMessages,
  docWithLink,
  docWithText,
  installFakeHost,
  messagesOfType,
  sendToEditor,
} from "./harness";

/** The debounce in main.ts, plus headroom for a loaded CI machine. */
const DEBOUNCE_SETTLE_MS = 600;

test.beforeEach(async ({ page }) => {
  await installFakeHost(page);
  await page.goto("/");
  // Wait on `ready`, not a selector, so tests never race startup.
  await expect
    .poll(async () => (await messagesOfType(page, "ready")).length)
    .toBeGreaterThan(0);
});

test.describe("startup", () => {
  test("announces the protocol version it was built against", async ({ page }) => {
    const [ready] = await messagesOfType(page, "ready");
    expect(ready?.v).toBe(1);
    expect(ready?.payload["protocolVersion"]).toBe(1);
  });

  test("mounts an editable surface", async ({ page }) => {
    await expect(page.locator(".ProseMirror")).toBeVisible();
    await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "true");
  });
});

test.describe("loading a document", () => {
  test("shows the document the host sends", async ({ page }) => {
    await sendToEditor(page, "load", { doc: docWithText("Hello from the host"), pageId: "p1" });
    await expect(page.locator(".ProseMirror")).toContainText("Hello from the host");
  });

  test("does not report the host's own load back as a change", async ({ page }) => {
    // Otherwise every page open looks like an edit, and with sync a write.
    await clearMessages(page);
    await sendToEditor(page, "load", { doc: docWithText("Untouched"), pageId: "p1" });
    await page.waitForTimeout(DEBOUNCE_SETTLE_MS);
    expect(await messagesOfType(page, "docChanged")).toEqual([]);
  });

  test("recovers from a document that will not parse", async ({ page }) => {
    await sendToEditor(page, "load", { doc: docWithText("Previous page"), pageId: "p1" });
    await expect(page.locator(".ProseMirror")).toContainText("Previous page");

    // Stale content would leave the user editing one page believing it is another.
    await sendToEditor(page, "load", { doc: "{ not json", pageId: "p2" });
    await expect(page.locator(".ProseMirror")).not.toContainText("Previous page");
  });
});

test.describe("reporting changes", () => {
  test("sends the document, its page id and its plain text", async ({ page }) => {
    await sendToEditor(page, "load", { doc: docWithText(""), pageId: "page-42" });
    await clearMessages(page);

    await page.locator(".ProseMirror").click();
    await page.keyboard.type("Buy milk");

    await expect.poll(async () => (await messagesOfType(page, "docChanged")).length).toBeGreaterThan(0);
    const [change] = await messagesOfType(page, "docChanged");
    expect(change?.payload["pageId"]).toBe("page-42");
    expect(change?.payload["plainText"]).toContain("Buy milk");
    expect(JSON.parse(change?.payload["doc"] as string)).toMatchObject({ type: "doc" });
  });

  test("coalesces a burst of typing into one message", async ({ page }) => {
    await sendToEditor(page, "load", { doc: docWithText(""), pageId: "p1" });
    await clearMessages(page);

    await page.locator(".ProseMirror").click();
    await page.keyboard.type("abcdefghij", { delay: 10 });
    await page.waitForTimeout(DEBOUNCE_SETTLE_MS);

    const changes = await messagesOfType(page, "docChanged");
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.length).toBeLessThan(4);
    expect(changes.at(-1)?.payload["plainText"]).toContain("abcdefghij");
  });

  test("flushes pending changes when the page is hidden", async ({ page }) => {
    // iOS can suspend the process after backgrounding, losing a pending debounce.
    await sendToEditor(page, "load", { doc: docWithText(""), pageId: "p1" });
    await clearMessages(page);

    await page.locator(".ProseMirror").click();
    await page.keyboard.type("unsaved");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await expect
      .poll(async () => (await messagesOfType(page, "docChanged")).length)
      .toBeGreaterThan(0);
    expect((await messagesOfType(page, "docChanged")).at(-1)?.payload["plainText"]).toContain(
      "unsaved"
    );
  });

  test("reports the selection when it moves", async ({ page }) => {
    await sendToEditor(page, "load", { doc: docWithText("Some text here"), pageId: "p1" });
    await page.locator(".ProseMirror").click();
    await clearMessages(page);

    // Move the caret: ProseMirror fires a selection update only on a change, and after a load
    // the caret already sits at the end.
    await page.keyboard.press("Home");

    await expect
      .poll(async () => (await messagesOfType(page, "selectionChanged")).length)
      .toBeGreaterThan(0);
    const latest = (await messagesOfType(page, "selectionChanged")).at(-1);
    expect(latest?.payload["nodeType"]).toBe("paragraph");
    expect(latest?.payload["isEmpty"]).toBe(true);
    expect(Array.isArray(latest?.payload["marks"])).toBe(true);
  });

  test("reports the selection on focus, even when the caret has not moved", async ({ page }) => {
    // Tapping where the caret already sits moves nothing, so the toolbar would keep the
    // previous page's state.
    await sendToEditor(page, "load", { doc: docWithText("Some text"), pageId: "p1" });
    await sendToEditor(page, "blur", {});
    await clearMessages(page);

    await sendToEditor(page, "focus", {});

    await expect
      .poll(async () => (await messagesOfType(page, "selectionChanged")).length)
      .toBeGreaterThan(0);
  });

  test("reports active marks so the toolbar can show them", async ({ page }) => {
    await sendToEditor(page, "load", {
      doc: JSON.stringify({
        content: [
          {
            content: [{ marks: [{ type: "bold" }], text: "bold text", type: "text" }],
            type: "paragraph",
          },
        ],
        type: "doc",
      }),
      pageId: "p1",
    });
    await page.locator(".ProseMirror").click();
    await clearMessages(page);
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");

    await expect
      .poll(async () => {
        const latest = (await messagesOfType(page, "selectionChanged")).at(-1);
        return (latest?.payload["marks"] as string[] | undefined) ?? [];
      })
      .toContain("bold");
  });
});

test.describe("links", () => {
  // The schema sets `openOnClick: false`, so the editor reports the tap and the host acts: a
  // webview that followed the href would replace the editor with a web page.
  test("reports a tapped link to the host", async ({ page }) => {
    await sendToEditor(page, "load", {
      doc: docWithLink("the docs", "https://example.com/a b"),
      pageId: "p1",
    });
    await clearMessages(page);

    await page.locator(".ProseMirror a").click();

    await expect.poll(async () => (await messagesOfType(page, "linkTapped")).length).toBe(1);
    const [tapped] = await messagesOfType(page, "linkTapped");
    // Verbatim: the host escapes, and escaping twice breaks a URL with a space.
    expect(tapped?.payload["url"]).toBe("https://example.com/a b");
  });

  test("a tap on ordinary text reports nothing", async ({ page }) => {
    await sendToEditor(page, "load", { doc: docWithText("no links here"), pageId: "p1" });
    await clearMessages(page);

    await page.locator(".ProseMirror").click();

    await expect
      .poll(async () => (await messagesOfType(page, "selectionChanged")).length)
      .toBeGreaterThan(0);
    expect(await messagesOfType(page, "linkTapped")).toHaveLength(0);
  });

  test("tapping a link still moves the caret into it", async ({ page }) => {
    // Refusing the navigation must not stop the user editing the link text.
    await sendToEditor(page, "load", {
      doc: docWithLink("the docs", "https://example.com"),
      pageId: "p1",
    });
    await clearMessages(page);

    await page.locator(".ProseMirror a").click();

    await expect
      .poll(async () => {
        const latest = (await messagesOfType(page, "selectionChanged")).at(-1);
        return (latest?.payload["marks"] as string[] | undefined) ?? [];
      })
      .toContain("link");
  });
});

test.describe("document fidelity", () => {
  // A document must round-trip desktop and iOS with zero diff; the editor half is testable here.
  const documents: [name: string, doc: unknown][] = [
    [
      "headings and paragraphs",
      {
        content: [
          { attrs: { indent: 0, level: 1 }, content: [{ text: "Title", type: "text" }], type: "heading" },
          { attrs: { indent: 0 }, content: [{ text: "Body", type: "text" }], type: "paragraph" },
        ],
        type: "doc",
      },
    ],
    [
      "task list",
      {
        content: [
          {
            content: [
              {
                attrs: { checked: true },
                content: [
                  { attrs: { indent: 0 }, content: [{ text: "done", type: "text" }], type: "paragraph" },
                ],
                type: "taskItem",
              },
            ],
            type: "taskList",
          },
          // Tiptap appends a trailing paragraph after a final task list; both platforms do, so
          // the fixture keeps it.
          { attrs: { indent: 0 }, type: "paragraph" },
        ],
        type: "doc",
      },
    ],
    [
      "marks",
      {
        content: [
          {
            attrs: { indent: 0 },
            content: [
              { text: "plain ", type: "text" },
              { marks: [{ type: "bold" }], text: "bold", type: "text" },
              { marks: [{ type: "italic" }], text: " italic", type: "text" },
            ],
            type: "paragraph",
          },
        ],
        type: "doc",
      },
    ],
    [
      "image with a durable asset path",
      {
        content: [
          {
            attrs: { alt: null, "data-asset-path": "assets/photo.png", height: null, src: null, title: null, width: null },
            type: "image",
          },
          { attrs: { indent: 0 }, type: "paragraph" },
        ],
        type: "doc",
      },
    ],
  ];

  for (const [name, doc] of documents) {
    test(`${name} survives a load and save unchanged`, async ({ page }) => {
      await sendToEditor(page, "load", { doc: JSON.stringify(doc), pageId: "p1" });
      await clearMessages(page);

      await page.locator(".ProseMirror").click();
      await page.keyboard.type("x");
      await page.keyboard.press("ControlOrMeta+z");
      await page.waitForTimeout(DEBOUNCE_SETTLE_MS);

      const changes = await messagesOfType(page, "docChanged");
      expect(changes.length).toBeGreaterThan(0);
      expect(JSON.parse(changes.at(-1)!.payload["doc"] as string)).toEqual(doc);
    });
  }

  test("never writes a platform-specific URL into the document", async ({ page }) => {
    // A resolved pikos-asset:// URL in the stored document would only resolve on the device that wrote it.
    await sendToEditor(page, "load", {
      doc: JSON.stringify({
        content: [
          { attrs: { "data-asset-path": "assets/photo.png" }, type: "image" },
          // A paragraph to type into: with an image as the only node it is selected, and typing replaces it.
          { attrs: { indent: 0 }, type: "paragraph" },
        ],
        type: "doc",
      }),
      pageId: "p1",
    });
    await clearMessages(page);

    await page.locator(".ProseMirror").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("x");
    await page.waitForTimeout(DEBOUNCE_SETTLE_MS);

    const latest = (await messagesOfType(page, "docChanged")).at(-1);
    expect(latest?.payload["doc"]).not.toContain("pikos-asset://");
    expect(latest?.payload["doc"]).toContain("assets/photo.png");
  });
});

test.describe("host commands", () => {
  test("applies the host's theme", async ({ page }) => {
    await sendToEditor(page, "setTheme", { accent: "#00ff00", scheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--pikos-accent").trim()
    );
    expect(accent).toBe("#00ff00");
  });

  test("inserts an image by its asset path", async ({ page }) => {
    await sendToEditor(page, "load", { doc: docWithText("Before"), pageId: "p1" });
    await page.locator(".ProseMirror").click();
    await sendToEditor(page, "insertImage", { assetPath: "assets/inserted.png" });

    await expect(page.locator(".ProseMirror img")).toHaveCount(1);
    await expect(page.locator(".ProseMirror img")).toHaveAttribute(
      "src",
      /pikos-asset:\/\/asset\/inserted\.png/
    );
  });

  test("toggles a mark over a selected range", async ({ page }) => {
    await sendToEditor(page, "load", { doc: docWithText("make me bold"), pageId: "p1" });
    // Triple-click rather than a select-all shortcut, which may not reach the webview.
    await page.locator(".ProseMirror p").first().click({ clickCount: 3 });
    await clearMessages(page);

    await sendToEditor(page, "toggleMark", { mark: "bold" });
    await page.waitForTimeout(DEBOUNCE_SETTLE_MS);

    const doc = (await messagesOfType(page, "docChanged")).at(-1)?.payload["doc"] as string;
    expect(doc).toContain('"type":"bold"');
  });

  test("a mark toggled with no selection applies to what is typed next", async ({ page }) => {
    // Tap bold, then type, as the toolbar is used: with a collapsed caret the mark stays
    // pending until a character arrives.
    await sendToEditor(page, "load", { doc: docWithText(""), pageId: "p1" });
    await page.locator(".ProseMirror").click();
    await clearMessages(page);

    await sendToEditor(page, "toggleMark", { mark: "italic" });
    await page.keyboard.type("emphasised");
    await page.waitForTimeout(DEBOUNCE_SETTLE_MS);

    const doc = (await messagesOfType(page, "docChanged")).at(-1)?.payload["doc"] as string;
    expect(doc).toContain('"type":"italic"');
    expect(doc).toContain("emphasised");
  });

  test("toggles a block type", async ({ page }) => {
    await sendToEditor(page, "load", { doc: docWithText("make me a heading"), pageId: "p1" });
    await page.locator(".ProseMirror").click();
    await clearMessages(page);

    await sendToEditor(page, "toggleBlock", { headingLevel: 2, nodeType: "heading" });
    await page.waitForTimeout(DEBOUNCE_SETTLE_MS);

    const doc = (await messagesOfType(page, "docChanged")).at(-1)?.payload["doc"] as string;
    expect(doc).toContain('"type":"heading"');
    expect(doc).toContain('"level":2');
  });

  test("clamps a heading level the schema does not declare", async ({ page }) => {
    // The schema declares levels 1-3; others are dropped on the next parse.
    await sendToEditor(page, "load", { doc: docWithText("heading"), pageId: "p1" });
    await page.locator(".ProseMirror").click();
    await clearMessages(page);

    await sendToEditor(page, "toggleBlock", { headingLevel: 9, nodeType: "heading" });
    await page.waitForTimeout(DEBOUNCE_SETTLE_MS);

    const doc = (await messagesOfType(page, "docChanged")).at(-1)?.payload["doc"] as string;
    expect(doc).toContain('"level":3');
  });

  test("ignores a mark it does not know", async ({ page }) => {
    // Unknown names are refused rather than forwarded to the editor's chain.
    await sendToEditor(page, "load", { doc: docWithText("unchanged"), pageId: "p1" });
    await page.locator(".ProseMirror").click();
    await clearMessages(page);

    await sendToEditor(page, "toggleMark", { mark: "destroyEverything" });
    await page.waitForTimeout(300);

    expect(await messagesOfType(page, "docChanged")).toEqual([]);
    await expect(page.locator(".ProseMirror")).toContainText("unchanged");
  });

  test("toggling a list keeps the text", async ({ page }) => {
    await sendToEditor(page, "load", { doc: docWithText("a list item"), pageId: "p1" });
    await page.locator(".ProseMirror").click();
    await clearMessages(page);

    await sendToEditor(page, "toggleBlock", { headingLevel: 0, nodeType: "taskList" });
    await page.waitForTimeout(DEBOUNCE_SETTLE_MS);

    const doc = (await messagesOfType(page, "docChanged")).at(-1)?.payload["doc"] as string;
    expect(doc).toContain('"type":"taskList"');
    expect(doc).toContain("a list item");
  });

  test("focus and blur move the caret in and out", async ({ page }) => {
    await sendToEditor(page, "focus", {});
    await expect.poll(async () =>
      page.evaluate(() => document.activeElement?.classList.contains("ProseMirror") ?? false)
    ).toBe(true);

    await sendToEditor(page, "blur", {});
    await expect.poll(async () =>
      page.evaluate(() => document.activeElement?.classList.contains("ProseMirror") ?? false)
    ).toBe(false);
  });
});

test.describe("refusing bad messages", () => {
  test("ignores a message from another protocol version", async ({ page }) => {
    await sendToEditor(page, "load", { doc: docWithText("Original"), pageId: "p1" });
    await expect(page.locator(".ProseMirror")).toContainText("Original");

    await sendToEditor(page, "load", { doc: docWithText("From the future"), pageId: "p2" }, 99);
    await page.waitForTimeout(200);
    await expect(page.locator(".ProseMirror")).toContainText("Original");
  });

  test("ignores an unknown message type", async ({ page }) => {
    await sendToEditor(page, "selfDestruct", {});
    await expect(page.locator(".ProseMirror")).toBeVisible();
  });

  test("ignores a message whose payload is the wrong shape", async ({ page }) => {
    await sendToEditor(page, "load", { doc: docWithText("Original"), pageId: "p1" });
    // `doc` missing entirely.
    await sendToEditor(page, "load", { pageId: "p2" });
    await page.waitForTimeout(200);
    await expect(page.locator(".ProseMirror")).toContainText("Original");
  });
});
