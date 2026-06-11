// E2E tests for the Tiptap editor — formatting, slash commands, keyboard
// shortcuts, and content structure. All run against MockStorageAdapter
// (VITE_TEST_MODE=true) so no Tauri backend is needed.

import type { Page } from "@playwright/test";

import { expect, mod, quickAdd, test as appTest } from "./fixtures";

async function openEditorForPage(app: Page, title: string) {
  await app.locator("[data-page-list-item]").getByText(title).click();
  const editor = app.getByRole("textbox", { name: "Page content" });
  await editor.click();
  return editor;
}

// ─── Formatting via keyboard shortcuts ──────────────────────────────────────

appTest("bold formatting via Cmd+B @tier2", async ({ app }) => {
  await quickAdd(app, "bold test");
  const editor = await openEditorForPage(app, "bold test");

  await app.keyboard.type("normal ");
  await app.keyboard.press(mod("Mod+b"));
  await app.keyboard.type("bold text");
  await app.keyboard.press(mod("Mod+b"));

  await expect(editor.locator("strong")).toHaveText("bold text");
});

appTest("italic formatting via Cmd+I @tier2", async ({ app }) => {
  await quickAdd(app, "italic test");
  const editor = await openEditorForPage(app, "italic test");

  await app.keyboard.type("normal ");
  await app.keyboard.press(mod("Mod+i"));
  await app.keyboard.type("italic text");
  await app.keyboard.press(mod("Mod+i"));

  await expect(editor.locator("em")).toHaveText("italic text");
});

appTest("strikethrough formatting via Cmd+Shift+S @tier2", async ({ app }) => {
  await quickAdd(app, "strike test");
  const editor = await openEditorForPage(app, "strike test");

  await app.keyboard.press(mod("Mod+Shift+s"));
  await app.keyboard.type("struck");
  await app.keyboard.press(mod("Mod+Shift+s"));

  await expect(editor.locator("s")).toHaveText("struck");
});

appTest("inline code via Cmd+E @tier2", async ({ app }) => {
  await quickAdd(app, "code test");
  const editor = await openEditorForPage(app, "code test");

  await app.keyboard.press(mod("Mod+e"));
  await app.keyboard.type("const x = 1");
  await app.keyboard.press(mod("Mod+e"));

  await expect(editor.locator("code")).toHaveText("const x = 1");
});

// ─── Slash commands ─────────────────────────────────────────────────────────

appTest("slash command inserts heading @tier2", async ({ app }) => {
  await quickAdd(app, "slash heading test");
  const editor = await openEditorForPage(app, "slash heading test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();

  await app.keyboard.type("h1");
  await app.keyboard.press("Enter");

  await expect(app.locator(".slash-menu")).not.toBeVisible();

  await app.keyboard.type("My Heading");
  await expect(editor.locator("h1")).toHaveText("My Heading");
});

appTest("slash command inserts bullet list @tier2", async ({ app }) => {
  await quickAdd(app, "slash list test");
  const editor = await openEditorForPage(app, "slash list test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("bullet");
  await app.keyboard.press("Enter");

  await app.keyboard.type("First item");
  await app.keyboard.press("Enter");
  await app.keyboard.type("Second item");

  const items = editor.locator("ul:not([data-type]) li");
  await expect(items).toHaveCount(2);
});

appTest("slash command inserts task list @tier2", async ({ app }) => {
  await quickAdd(app, "slash task test");
  const editor = await openEditorForPage(app, "slash task test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("task");
  await app.keyboard.press("Enter");

  await app.keyboard.type("My task");

  const taskList = editor.locator("ul[data-type='taskList']");
  await expect(taskList).toBeVisible();
  await expect(taskList.locator("li")).toHaveCount(1);
});

appTest("slash command inserts code block @tier2", async ({ app }) => {
  await quickAdd(app, "slash code test");
  const editor = await openEditorForPage(app, "slash code test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("code");
  await app.keyboard.press("Enter");

  await app.keyboard.type("console.log('hello')");

  await expect(editor.locator("pre code")).toContainText("console.log");
});

appTest("slash command inserts blockquote @tier2", async ({ app }) => {
  await quickAdd(app, "slash quote test");
  const editor = await openEditorForPage(app, "slash quote test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("quote");
  await app.keyboard.press("Enter");

  await app.keyboard.type("Wise words");

  await expect(editor.locator("blockquote")).toContainText("Wise words");
});

appTest("slash command inserts horizontal rule @tier2", async ({ app }) => {
  await quickAdd(app, "slash hr test");
  const editor = await openEditorForPage(app, "slash hr test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("hr");
  await app.keyboard.press("Enter");

  await expect(editor.locator("hr")).toBeVisible();
});

appTest("slash command inserts table @tier2", async ({ app }) => {
  await quickAdd(app, "slash table test");
  const editor = await openEditorForPage(app, "slash table test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("table");
  await app.keyboard.press("Enter");

  // Default 3x3 table with header row
  await expect(editor.locator("table")).toBeVisible();
  await expect(editor.locator("th")).toHaveCount(3);
  await expect(editor.locator("tr")).toHaveCount(3);
});

appTest("escape closes slash menu without inserting @tier2", async ({ app }) => {
  await quickAdd(app, "slash escape test");
  await openEditorForPage(app, "slash escape test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.press("Escape");
  await expect(app.locator(".slash-menu")).not.toBeVisible();
});

// ─── Task list interaction ──────────────────────────────────────────────────

appTest("task checkbox toggles checked state @tier2", async ({ app }) => {
  await quickAdd(app, "checkbox test");
  const editor = await openEditorForPage(app, "checkbox test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("task");
  await app.keyboard.press("Enter");
  await app.keyboard.type("Toggle me");

  const checkbox = editor.locator("ul[data-type='taskList'] input[type='checkbox']");
  await expect(checkbox).not.toBeChecked();

  await checkbox.click();
  await expect(checkbox).toBeChecked();

  await checkbox.click();
  await expect(checkbox).not.toBeChecked();
});

// ─── Content persistence ────────────────────────────────────────────────────

appTest("formatted content persists across page switches @tier1", async ({ app }) => {
  await quickAdd(app, "persist-fmt-1");
  await quickAdd(app, "persist-fmt-2");

  const editor = await openEditorForPage(app, "persist-fmt-1");

  await app.keyboard.press(mod("Mod+b"));
  await app.keyboard.type("bold");
  await app.keyboard.press(mod("Mod+b"));
  await app.keyboard.type(" and ");
  await app.keyboard.press(mod("Mod+i"));
  await app.keyboard.type("italic");

  await app.locator("[data-page-list-item]").getByText("persist-fmt-2").click();
  await app.locator("[data-page-list-item]").getByText("persist-fmt-1").click();

  await expect(editor.locator("strong")).toHaveText("bold");
  await expect(editor.locator("em")).toHaveText("italic");
});

// ─── Table toolbar ──────────────────────────────────────────────────────────

appTest("table toolbar appears when cursor is in table @tier2", async ({ app }) => {
  await quickAdd(app, "table toolbar test");
  const editor = await openEditorForPage(app, "table toolbar test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("table");
  await app.keyboard.press("Enter");

  // Toolbar should be visible (cursor is in the table after insert)
  await expect(app.locator(".table-toolbar")).toBeVisible();

  // Arrow the cursor out of the table; toolbar dismissal is not asserted here.
  await app.keyboard.press(mod("Mod+a"));
  await app.keyboard.press("ArrowDown");
  await app.keyboard.press("ArrowDown");
  await app.keyboard.press("ArrowDown");
  await app.keyboard.press("ArrowDown");
});

appTest("table toolbar adds row below @tier2", async ({ app }) => {
  await quickAdd(app, "table addrow test");
  const editor = await openEditorForPage(app, "table addrow test");

  // Insert a table (3x3 default)
  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("table");
  await app.keyboard.press("Enter");

  await expect(editor.locator("tr")).toHaveCount(3);

  await app.locator(".table-toolbar").getByRole("button", { name: "Add row below" }).click();

  await expect(editor.locator("tr")).toHaveCount(4);
});

appTest("table toolbar adds and removes column @tier2", async ({ app }) => {
  await quickAdd(app, "table col test");
  const editor = await openEditorForPage(app, "table col test");

  // Insert a table (3 cols)
  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("table");
  await app.keyboard.press("Enter");

  await expect(editor.locator("th")).toHaveCount(3);

  await app.locator(".table-toolbar").getByRole("button", { name: "Add column after" }).click();
  await expect(editor.locator("th")).toHaveCount(4);

  await app.locator(".table-toolbar").getByRole("button", { name: "Delete column" }).click();
  await expect(editor.locator("th")).toHaveCount(3);
});

appTest("table toolbar deletes table @tier2", async ({ app }) => {
  await quickAdd(app, "table delete test");
  const editor = await openEditorForPage(app, "table delete test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("table");
  await app.keyboard.press("Enter");

  await expect(editor.locator("table")).toBeVisible();

  await app.locator(".table-toolbar").getByRole("button", { name: "Delete table" }).click();

  await expect(editor.locator("table")).not.toBeVisible();
});

// ─── Link insertion via the bubble toolbar ─────────────────────────────────
//
// The format bubble toolbar appears once the user has selected text. Its
// Link button (aria-label="Link") opens the LinkPopover, which exposes a
// URL input that commits on Enter and wraps the selection in <a href>.

appTest("bubble toolbar inserts a link around the selection @tier2", async ({ app }) => {
  await quickAdd(app, "link insert test");
  const editor = await openEditorForPage(app, "link insert test");

  // Type some text and select the last word ("Pikos") so the bubble toolbar
  // has something to wrap. Five Shift+ArrowLeft keys cover the 5-char word.
  await app.keyboard.type("Visit Pikos");
  for (let i = 0; i < 5; i++) await app.keyboard.press("Shift+ArrowLeft");

  // Bubble toolbar mounts on selection. Click the Link button — it blurs
  // the editor (so the selection is preserved in editor state) and surfaces
  // the LinkPopover input.
  const bubble = app.locator(".bubble-toolbar");
  await expect(bubble).toBeVisible();
  await bubble.getByRole("button", { name: "Link" }).click();

  const urlInput = app.locator(".link-popover-input");
  await expect(urlInput).toBeVisible();
  await urlInput.fill("https://pikos.app");
  await app.keyboard.press("Enter");

  const link = editor.locator('a[href="https://pikos.app"]');
  await expect(link).toHaveText("Pikos");
});
