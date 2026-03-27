import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

export const test = base.extend<{ app: Page }>({
  app: async ({ page }, use) => {
    await page.goto("/");
    await page.getByRole("button", { name: /get started/i }).click();
    await expect(page.locator("[data-testid=three-panel-layout]")).toBeVisible();
    await use(page);
  },
});

/** Create a page via Quick Add and wait for dialog to close. */
export async function quickAdd(page: Page, input: string) {
  await page.keyboard.press("Meta+n");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByPlaceholder(/what's on your mind/i).fill(input);
  await page.keyboard.press("Enter");
  // Wait for dialog to close before continuing
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

export { expect };
