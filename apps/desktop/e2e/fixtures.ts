import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

export const test = base.extend<{ app: Page }>({
  app: async ({ page }, use) => {
    await page.goto("/");
    // Workspace auto-creates on first launch — wait for it to be ready
    await expect(page.getByRole("main", { name: "Workspace" })).toBeVisible();
    await use(page);
  },
});

/** Press a shortcut like "Mod+n", replacing Mod with the platform modifier. */
export function mod(combo: string): string {
  return combo.replace("Mod", MOD);
}

/** Create a page via Quick Add and wait for dialog to close. */
export async function quickAdd(page: Page, input: string) {
  await page.keyboard.press(mod("Mod+n"));
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("textbox", { name: "Quick add input" }).fill(input);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

export { expect };
