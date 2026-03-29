import { expect } from "@playwright/test";

import { mod, quickAdd, test as appTest } from "./fixtures";

// ─── T2-1: Find in page (Cmd+F) ────────────────────────────────────────────

appTest("find in page highlights matches @tier2", async ({ app }) => {
  await quickAdd(app, "search test page");

  // Open the page and type some content
  await app.locator("[data-page-list-item]").getByText("search test page").click();
  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();
  await app.keyboard.type("The quick brown fox jumps over the lazy fox");

  // Open find popover
  await app.keyboard.press(mod("Mod+f"));

  // Find bar should appear with input focused
  const findInput = app.getByPlaceholder("Find…");
  await expect(findInput).toBeVisible();
  await expect(findInput).toBeFocused();

  // Type a search query
  await findInput.fill("fox");

  // Match count should show 2 matches
  await expect(app.getByText("1 of 2")).toBeVisible();

  // Highlight decorations should be present in the editor
  const highlights = editor.locator(".find-match");
  await expect(highlights).toHaveCount(2);

  // Active highlight should be on the first match
  const activeHighlight = editor.locator(".find-match-active");
  await expect(activeHighlight).toHaveCount(1);

  // Navigate to next match via Enter
  await app.keyboard.press("Enter");
  await expect(app.getByText("2 of 2")).toBeVisible();

  // Navigate back via Shift+Enter
  await app.keyboard.press("Shift+Enter");
  await expect(app.getByText("1 of 2")).toBeVisible();

  // Close via Escape — highlights should clear
  await app.keyboard.press("Escape");
  await expect(findInput).not.toBeVisible();
  await expect(editor.locator(".find-match")).toHaveCount(0);
});

// ─── T2-2: Find in page with no matches ─────────────────────────────────────

appTest("find in page shows zero matches @tier2", async ({ app }) => {
  await quickAdd(app, "empty search page");

  await app.locator("[data-page-list-item]").getByText("empty search page").click();
  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();
  await app.keyboard.type("Hello world");

  await app.keyboard.press(mod("Mod+f"));
  const findInput = app.getByPlaceholder("Find…");
  await findInput.fill("xyz");

  await expect(app.getByText("0 of 0")).toBeVisible();
  await expect(editor.locator(".find-match")).toHaveCount(0);
});

// ─── T2-3: Find in page prefills selected text ──────────────────────────────

appTest("find in page prefills selected text @tier2", async ({ app }) => {
  await quickAdd(app, "prefill test page");

  await app.locator("[data-page-list-item]").getByText("prefill test page").click();
  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();
  await app.keyboard.type("hello world");

  // Select "world" via keyboard: Option+Shift+Left selects the previous word on macOS
  await app.keyboard.press("Alt+Shift+ArrowLeft");

  // Open find — should prefill with selected text
  await app.keyboard.press(mod("Mod+f"));
  const findInput = app.getByPlaceholder("Find…");
  await expect(findInput).toHaveValue("world");
  await expect(app.getByText("1 of 1")).toBeVisible();
});
