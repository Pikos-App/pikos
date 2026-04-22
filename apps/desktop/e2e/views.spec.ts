import { expect } from "@playwright/test";

import { mod, quickAdd, test as appTest } from "./fixtures";

// ─── Today view shows scheduled pages ──────────────────────────────────────

appTest("today view shows scheduled pages @tier1", async ({ app }) => {
  await quickAdd(app, "my scheduled task @today");
  await quickAdd(app, "unscheduled task");

  // Navigate to Today view
  await app.getByRole("button", { name: /Today/ }).click();

  // Scheduled page appears
  await expect(app.locator("[data-page-list-item]").getByText("my scheduled task")).toBeVisible();

  // Unscheduled page does not
  await expect(
    app.locator("[data-page-list-item]").filter({ hasText: "unscheduled task" })
  ).not.toBeVisible();
});

// ─── Toggle editor ↔ calendar (Cmd+Shift+C) ────────────────────────────────

appTest("toggle editor and calendar view @tier1", async ({ app }) => {
  const editorBtn = app.getByRole("button", { name: "Editor view" });
  const calendarBtn = app.getByRole("button", { name: "Calendar view" });

  // Editor is active by default
  await expect(editorBtn).toHaveAttribute("aria-pressed", "true");
  await expect(calendarBtn).toHaveAttribute("aria-pressed", "false");

  // Toggle to calendar
  await app.keyboard.press(mod("Mod+Shift+c"));
  await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
  await expect(calendarBtn).toHaveAttribute("aria-pressed", "true");
  await expect(editorBtn).toHaveAttribute("aria-pressed", "false");

  // Toggle back to editor
  await app.keyboard.press(mod("Mod+Shift+c"));
  await expect(app.getByRole("region", { name: "Week calendar" })).not.toBeVisible();
  await expect(editorBtn).toHaveAttribute("aria-pressed", "true");
});

// ─── Sidebar collapse and expand ───────────────────────────────────────────

appTest("sidebar collapse and expand @tier1", async ({ app }) => {
  // Sidebar should be visible by default
  await expect(app.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();

  // Collapse sidebar
  await app.getByRole("button", { name: "Collapse sidebar" }).click();

  // Button label changes to "Expand sidebar" — proves state toggled
  await expect(app.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

  // Expand sidebar back
  await app.getByRole("button", { name: "Expand sidebar" }).click();

  // Button label returns and Inbox reappears — proves the round-trip works
  await expect(app.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  await expect(app.getByRole("button", { name: /Inbox/ })).toBeVisible();
});
