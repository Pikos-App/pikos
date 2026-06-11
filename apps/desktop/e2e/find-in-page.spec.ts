import { expect } from "@playwright/test";

import { mod, quickAdd, test as appTest } from "./fixtures";

// ─── Find in page (Cmd+F) ──────────────────────────────────────────────────

appTest("find in page highlights matches @tier2", async ({ app }) => {
  await quickAdd(app, "search test page");

  await app.locator("[data-page-list-item]").getByText("search test page").click();
  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();
  await app.keyboard.type("The quick brown fox jumps over the lazy fox");

  await app.keyboard.press(mod("Mod+f"));

  const findInput = app.getByPlaceholder("Find…");
  await expect(findInput).toBeVisible();
  await expect(findInput).toBeFocused();

  await findInput.fill("fox");

  await expect(app.getByText("1 of 2")).toBeVisible();

  const highlights = editor.locator(".find-match");
  await expect(highlights).toHaveCount(2);

  const activeHighlight = editor.locator(".find-match-active");
  await expect(activeHighlight).toHaveCount(1);

  await app.keyboard.press("Enter");
  await expect(app.getByText("2 of 2")).toBeVisible();

  await app.keyboard.press("Shift+Enter");
  await expect(app.getByText("1 of 2")).toBeVisible();

  await app.keyboard.press("Escape");
  await expect(findInput).not.toBeVisible();
  await expect(editor.locator(".find-match")).toHaveCount(0);
});

// ─── Zero matches ──────────────────────────────────────────────────────────

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

// ─── Prefill selected text ─────────────────────────────────────────────────

appTest("find in page prefills selected text @tier2", async ({ app }) => {
  await quickAdd(app, "prefill test page");

  await app.locator("[data-page-list-item]").getByText("prefill test page").click();
  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();
  await app.keyboard.type("hello world");

  // Select "world" (5 chars) via Shift+ArrowLeft from end of line
  for (let i = 0; i < 5; i++) await app.keyboard.press("Shift+ArrowLeft");

  await app.keyboard.press(mod("Mod+f"));
  const findInput = app.getByPlaceholder("Find…");
  await expect(findInput).toHaveValue("world");
  await expect(app.getByText("1 of 1")).toBeVisible();
});
