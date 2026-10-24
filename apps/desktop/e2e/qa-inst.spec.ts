import { test as appTest, expect, openEditorForPage } from "./fixtures";

appTest.use({ firstRun: true });

appTest(
  "a first launch plants the tutorial and opens its welcome page",
  { tag: ["@INST-05"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "the first-launch path runs against the real writer");
    const startHere = app
      .getByRole("group", { name: "Views and folders" })
      .getByRole("button", { exact: true, name: "Start here" });

    await appTest.step("INST-05 the Start here folder is there, and open", async () => {
      await expect(startHere).toBeVisible();
      await expect(startHere).toHaveAttribute("aria-current", "true");
    });

    await appTest.step("INST-05 the welcome page is open in the editor", async () => {
      await expect(app.getByRole("button", { name: "Page title" })).toHaveText("Welcome to Pikos 👋");
    });

    await appTest.step("INST-05 How it works shows a tag, a priority and its Quick Add line", async () => {
      const editor = await openEditorForPage(app, "How it works");

      await expect(app.getByRole("button", { name: "Priority: High" })).toBeVisible();
      await expect(editor).toContainText("How it works tomorrow 9am for 1h #tutorial !high");
    });
  }
);
