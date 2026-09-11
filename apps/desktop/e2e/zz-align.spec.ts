import { expect, test } from "@playwright/test";

test("measure block title vs time alignment @tier1", async ({ page }) => {
  await page.goto("/");
  await page.locator("#nav-inbox").waitFor();
  await page.keyboard.press("Meta+n");
  await page.waitForTimeout(300);
  await page.keyboard.type("Fix calendar timezone offset today 2pm-4pm");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  await page.evaluate(() => localStorage.setItem("pikos:rightPanel", JSON.stringify("calendar")));
  await page.reload();
  await page.waitForTimeout(900);

  const out = await page.evaluate(() => {
    const block = document.querySelector("[data-cal-page-id]") as HTMLElement;
    if (!block) return { error: "no block" };
    const ps = block.querySelectorAll("p");
    const title = ps[0] as HTMLElement;
    const time = ps[1] as HTMLElement;
    const box = (el: HTMLElement) => el.getBoundingClientRect().left;
    const cb = block.querySelector("[class*='task-checkbox'], span.task-checkbox") as HTMLElement;
    return {
      blockLeft: block.getBoundingClientRect().left,
      checkboxWidth: cb ? cb.getBoundingClientRect().width : null,
      timeLeft: time ? box(time) : null,
      timePadding: time ? getComputedStyle(time).paddingLeft : null,
      titleLeft: title ? box(title) : null,
    };
  });
  console.log("MEASURED " + JSON.stringify(out, null, 1));
  expect(true).toBe(true);
});
