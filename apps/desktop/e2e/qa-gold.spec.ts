import { test as appTest, expect, quickAdd } from "./fixtures";

// The golden flow is one journey, so it is one test with a step per row
// (PKOS-0120): each row starts from the state the one before it left.

const TITLE = "Draft agenda for the offsite";
const BODY = ["Open with the numbers", "Then the hiring plan", "Close on the roadmap"];

appTest(
  "the golden flow survives a relaunch: create, schedule, see it, complete it @smoke",
  { tag: ["@GOLD-01", "@GOLD-02", "@GOLD-03", "@GOLD-04", "@GOLD-05"] },
  async ({ app, storage }) => {
    appTest.skip(
      storage !== "bridge",
      "GOLD-05 reloads, and the mock keeps nothing across a reload"
    );
    const list = app.locator("[data-page-list-item]");
    const row = list.filter({ hasText: TITLE });
    const body = app.getByRole("textbox", { name: "Page content" });
    const schedule = app.getByRole("button", { name: /^Scheduled: Today 2(:00)?\s?PM/i });

    await appTest.step(
      "GOLD-01 a page with a title and a few lines of body keeps its body",
      async () => {
        await quickAdd(app, TITLE);
        await row.click();
        await body.click();
        await app.keyboard.type(BODY.join("\n"));

        // Away and back, so the body is read from the writer, not the open editor.
        await app.getByRole("button", { name: /^Today/ }).click();
        await app.getByRole("button", { name: /^Inbox/ }).click();
        await row.click();
        await expect(body.locator("p")).toHaveText(BODY);
      }
    );

    await appTest.step("GOLD-02 a date set in the byline shows on the page", async () => {
      await app.getByRole("button", { name: "Set schedule" }).click();
      const picker = app.getByRole("dialog", { name: "Schedule picker" });
      await picker.getByRole("button", { exact: true, name: "Today" }).click();
      await picker.getByPlaceholder("or type a time…").fill("2pm");
      await app.keyboard.press("Enter");
      await app.keyboard.press("Escape");
      await expect(schedule).toBeVisible();
    });

    await appTest.step("GOLD-03 the calendar shows it on today, at 2 PM", async () => {
      await app.getByRole("button", { name: "Calendar view" }).click();
      const calendar = app.getByRole("region", { name: "Week calendar" });
      const block = calendar.getByRole("button", {
        name: new RegExp(`^${TITLE}, 2–\\d{1,2}(:\\d{2})? PM$`),
      });
      await block.scrollIntoViewIfNeeded();
      await expect(block).toBeVisible();

      // Under today's column header, read the way the header labels itself.
      const today = await app.evaluate(() =>
        new Date().toLocaleDateString("en-US", { day: "numeric", month: "long", weekday: "long" })
      );
      const header = await calendar.getByLabel(today, { exact: true }).boundingBox();
      const placed = await block.boundingBox();
      if (!header || !placed) throw new Error("today's header or the block has no box");
      const centre = placed.x + placed.width / 2;
      expect(centre).toBeGreaterThan(header.x);
      expect(centre).toBeLessThan(header.x + header.width);

      await app.getByRole("button", { name: "Editor view" }).click();
    });

    await appTest.step("GOLD-04 completing it moves it to Completed and out of Today", async () => {
      await app.getByRole("button", { name: /^Today/ }).click();
      await row.getByRole("checkbox", { name: "Mark done" }).click();
      await expect(row).not.toBeVisible();
      await app.getByRole("button", { name: /^Completed/ }).click();
      await expect(row.getByRole("checkbox", { name: /Mark not done/i })).toBeVisible();
    });

    await appTest.step(
      "GOLD-05 after a relaunch the page, its schedule and its completion hold",
      async () => {
        await app.reload();
        await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();

        await app.getByRole("button", { name: /^Today/ }).click();
        await expect(row).not.toBeVisible();
        await app.getByRole("button", { name: /^Completed/ }).click();
        await expect(row.getByRole("checkbox", { name: /Mark not done/i })).toBeVisible();

        await row.click();
        await expect(body.locator("p")).toHaveText(BODY);
        await expect(schedule).toBeVisible();
      }
    );
  }
);
