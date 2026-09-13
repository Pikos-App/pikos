import { expect, test } from "@playwright/test";

import {
  clearMessages,
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
  // `ready` is the editor's own signal that it can accept messages; waiting on
  // it rather than on a selector means the tests never race startup.
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
    // Otherwise every page open looks like an edit, and with sync that is a
    // write per open rather than per edit.
    await clearMessages(page);
    await sendToEditor(page, "load", { doc: docWithText("Untouched"), pageId: "p1" });
    await page.waitForTimeout(DEBOUNCE_SETTLE_MS);
    expect(await messagesOfType(page, "docChanged")).toEqual([]);
  });

  test("recovers from a document that will not parse", async ({ page }) => {
    await sendToEditor(page, "load", { doc: docWithText("Previous page"), pageId: "p1" });
    await expect(page.locator(".ProseMirror")).toContainText("Previous page");

    // A corrupt document must not leave the previous page's content on screen —
    // the user would be editing one page believing it is another.
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
    // Extracted in the webview with the same function the desktop app uses for
    // its search index, so search behaves the same for a page typed on a phone.
    expect(change?.payload["plainText"]).toContain("Buy milk");
    expect(JSON.parse(change?.payload["doc"] as string)).toMatchObject({ type: "doc" });
  });

  test("coalesces a burst of typing into one message", async ({ page }) => {
    // Each message carries the whole document plus its extracted text. At
    // typing speed, sending per keystroke is enough serialisation to feel.
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
    // iOS can suspend the process shortly after backgrounding, and a pending
    // debounce would take the user's last keystrokes with it.
    await sendToEditor(page, "load", { doc: docWithText(""), pageId: "p1" });
    await clearMessages(page);

    await page.locator(".ProseMirror").click();
    await page.keyboard.type("unsaved");
    // Hide immediately, well inside the debounce window.
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

    // Moving the caret, not merely clicking where it already is: ProseMirror
    // fires a selection update only on an actual change, and after a load the
    // caret already sits at the end of the document.
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
    // A native toolbar needs the caret's context the moment the user taps in.
    // Without this the toolbar shows whatever the previous page left behind,
    // because tapping where the caret already sits moves nothing.
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

test.describe("document fidelity", () => {
  // The M0 pass bar asks that a document round-trips desktop ↔ iOS with zero
  // diff. The device half needs a device; the editor half is testable here, and
  // it is the half most likely to be wrong.
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
          // A document cannot end on a task list in an editable doc, so Tiptap
          // appends a trailing paragraph. Both platforms share the schema, so
          // both do it — which is exactly why it belongs in a fidelity fixture
          // rather than being trimmed to make the test pass.
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

      // Type and undo, so a save is triggered without the document changing.
      await page.locator(".ProseMirror").click();
      await page.keyboard.type("x");
      await page.keyboard.press("Control+z");
      await page.waitForTimeout(DEBOUNCE_SETTLE_MS);

      const changes = await messagesOfType(page, "docChanged");
      expect(changes.length).toBeGreaterThan(0);
      expect(JSON.parse(changes.at(-1)!.payload["doc"] as string)).toEqual(doc);
    });
  }

  test("never writes a platform-specific URL into the document", async ({ page }) => {
    // `src` is derived from `data-asset-path` at render time. If a resolved
    // pikos-asset:// URL ever reached the stored document, that document would
    // only resolve on the device that wrote it.
    await sendToEditor(page, "load", {
      doc: JSON.stringify({
        content: [
          { attrs: { "data-asset-path": "assets/photo.png" }, type: "image" },
          // A paragraph to type into. Loading a document whose only node is an
          // image leaves that image selected, and typing then replaces it —
          // correct editor behaviour, and not what this test is about.
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
    // Resolved for display through the custom scheme the host serves.
    await expect(page.locator(".ProseMirror img")).toHaveAttribute(
      "src",
      /pikos-asset:\/\/asset\/assets\/inserted\.png/
    );
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
