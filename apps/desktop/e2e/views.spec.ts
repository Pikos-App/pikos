import { expect } from "@playwright/test";

import { mod, quickAdd, test as appTest } from "./fixtures";

// ─── Today view shows scheduled pages ──────────────────────────────────────

appTest("today view shows scheduled pages @tier1", async ({ app }) => {
  await quickAdd(app, "my scheduled task @today");
  await quickAdd(app, "unscheduled task");

  await app.getByRole("button", { name: /Today/ }).click();

  await expect(app.locator("[data-page-list-item]").getByText("my scheduled task")).toBeVisible();
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "unscheduled task" })
  ).not.toBeVisible();
});

// ─── Toggle editor ↔ calendar (Cmd+Shift+C) ────────────────────────────────

appTest("toggle editor and calendar view @tier1", async ({ app }) => {
  const editorBtn = app.getByRole("button", { name: "Editor view" });
  const calendarBtn = app.getByRole("button", { name: "Calendar view" });

  await expect(editorBtn).toHaveAttribute("aria-pressed", "true");
  await expect(calendarBtn).toHaveAttribute("aria-pressed", "false");

  await app.keyboard.press(mod("Mod+Shift+c"));
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
  await expect(calendarBtn).toHaveAttribute("aria-pressed", "true");
  await expect(editorBtn).toHaveAttribute("aria-pressed", "false");

  await app.keyboard.press(mod("Mod+Shift+c"));
  await expect(app.getByRole("region", { name: "Week calendar" })).not.toBeVisible();
  await expect(editorBtn).toHaveAttribute("aria-pressed", "true");
});

// ─── Sidebar collapse and expand ───────────────────────────────────────────

appTest("sidebar collapse and expand @tier1", async ({ app }) => {
  await expect(app.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();

  await app.getByRole("button", { name: "Collapse sidebar" }).click();

  await expect(app.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

  await app.getByRole("button", { name: "Expand sidebar" }).click();

  await expect(app.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  await expect(app.getByRole("button", { name: /Inbox/ })).toBeVisible();
});
