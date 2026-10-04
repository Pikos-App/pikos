import type { Page } from "@playwright/test";

import {
  test as appTest,
  createFolder,
  expect,
  gutterLabel,
  hourLineY,
  mod,
  openCalendarMode,
  openEditorForPage,
  quickAdd,
  WRITE_QUEUE_DEBOUNCE_MS,
} from "./fixtures";

appTest("every settings panel opens without an error", { tag: ["@SET-01"] }, async ({ app }) => {
  const errors: string[] = [];
  app.on("pageerror", (e) => errors.push(e.message));
  await app.getByRole("button", { name: "Open settings" }).click();

  const panels: [string, string][] = [
    ["General", "About"],
    ["Notifications", "Notifications"],
    ["Calendar sync", "Calendar sync"],
    ["Data", "Your Workspace"],
    ["Shortcuts", "Keyboard Shortcuts"],
  ];
  for (const [tab, heading] of panels) {
    await appTest.step(`SET-01 ${tab} opens`, async () => {
      await app.getByRole("button", { exact: true, name: tab }).click();
      await expect(app.getByRole("heading", { exact: true, name: heading })).toBeVisible();
    });
  }

  expect(errors).toEqual([]);
});

function settingsOf(app: Page) {
  return app.getByRole("region", { name: "Settings" });
}

async function openSettings(app: Page, tab = "General") {
  await app.getByRole("button", { name: "Open settings" }).click();
  await settingsOf(app).getByRole("button", { exact: true, name: tab }).click();
  return settingsOf(app);
}

/** A button-group setting: click the option and see it pressed. */
async function chooseIn(app: Page, setting: string, option: string) {
  const button = settingsOf(app)
    .getByRole("group", { name: setting })
    .getByRole("button", { exact: true, name: option });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

/** A picker setting: open it by its "Name: value" trigger and pick an option. */
async function pickIn(app: Page, setting: string, option: string) {
  await settingsOf(app)
    .getByRole("button", { name: new RegExp(`^${setting}:`) })
    .click();
  await app.getByRole("button", { exact: true, name: option }).click();
  await expect(
    settingsOf(app).getByRole("button", { name: `${setting}: ${option}` })
  ).toBeVisible();
}

appTest(
  "every preference applies at once and survives a relaunch",
  { tag: ["@SET-02"] },
  async ({ app, storage }) => {
    appTest.skip(
      storage !== "bridge",
      "SET-02 reloads, and the mock keeps nothing across a reload"
    );
    await createFolder(app, "Errands");
    await quickAdd(app, "reading list");
    const editor = await openEditorForPage(app, "reading list");
    const row = app.locator("[data-page-list-item]").first();
    const html = app.locator("html");
    const calendar = app.getByRole("region", { name: "Week calendar" });
    const measure = {
      calendarLabelSize: async () => {
        await openCalendarMode(app);
        const size = await gutterLabel(app, 9).evaluate((el) => getComputedStyle(el).fontSize);
        await app.getByRole("button", { name: "Editor view" }).click();
        return size;
      },
      columns: async () => {
        await openCalendarMode(app);
        const cells = calendar.getByLabel(/^All-day events,/);
        const out = {
          count: await cells.count(),
          first: (await cells.first().getAttribute("aria-label")) ?? "",
        };
        await app.getByRole("button", { name: "Editor view" }).click();
        return out;
      },
      editorFont: () => editor.evaluate((el) => getComputedStyle(el).fontSize),
      editorWidth: async () => (await editor.boundingBox())?.width ?? 0,
      hourPitch: async () => {
        await openCalendarMode(app);
        const pitch = (await hourLineY(app, 10)) - (await hourLineY(app, 9));
        await app.getByRole("button", { name: "Editor view" }).click();
        return pitch;
      },
      rowHeight: async () => (await row.boundingBox())?.height ?? 0,
      textScale: () =>
        app.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--ui-text-scale").trim()
        ),
    };
    const before = {
      calendarLabelSize: await measure.calendarLabelSize(),
      editorWidth: await measure.editorWidth(),
      hourPitch: await measure.hourPitch(),
      rowHeight: await measure.rowHeight(),
    };
    await openSettings(app);

    await appTest.step("SET-02 theme: Dark, Light and System each apply", async () => {
      await chooseIn(app, "Theme", "Dark");
      await expect(html).toHaveClass(/\bdark\b/);
      await app.emulateMedia({ colorScheme: "light" });
      await chooseIn(app, "Theme", "System");
      await expect(html).not.toHaveClass(/\bdark\b/);
      await app.emulateMedia({ colorScheme: "dark" });
      await expect(html).toHaveClass(/\bdark\b/);
      await chooseIn(app, "Theme", "Light");
      await expect(html).not.toHaveClass(/\bdark\b/);
    });

    await appTest.step("SET-02 interface text size and density apply", async () => {
      await pickIn(app, "Interface text size", "130%");
      await expect.poll(measure.textScale).toBe("1.3");
      await chooseIn(app, "Interface density", "Spacious");
    });

    await appTest.step("SET-02 editor text size and line width apply", async () => {
      await pickIn(app, "Editor text size", "18");
      await chooseIn(app, "Editor line width", "Narrow");
    });

    await appTest.step(
      "SET-02 calendar text size, density, days and week start apply",
      async () => {
        await pickIn(app, "Calendar text size", "16");
        await chooseIn(app, "Calendar density", "Spacious");
        await chooseIn(app, "Calendar days shown", "3");
        await chooseIn(app, "Week starts on", "Sunday");
      }
    );

    await appTest.step("SET-02 default folder applies", async () => {
      await settingsOf(app)
        .getByRole("button", { name: /^Default folder for new pages:/ })
        .click();
      await app.getByPlaceholder("Search folders…").fill("Errands");
      await app
        .getByRole("dialog")
        .filter({ has: app.getByPlaceholder("Search folders…") })
        .getByRole("button", { exact: true, name: "Errands" })
        .click();
      await expect(
        settingsOf(app).getByRole("button", { name: "Default folder for new pages: Errands" })
      ).toBeVisible();
      await app.keyboard.press("Escape");
    });

    const applied = {
      calendarLabelSize: await measure.calendarLabelSize(),
      columns: await measure.columns(),
      editorFont: await measure.editorFont(),
      editorWidth: await measure.editorWidth(),
      hourPitch: await measure.hourPitch(),
      rowHeight: await measure.rowHeight(),
    };

    await appTest.step("SET-02 each shows at once", async () => {
      expect(applied.calendarLabelSize).not.toBe(before.calendarLabelSize);
      expect(applied.columns.count).toBe(3);
      expect(applied.editorFont).toBe("18px");
      expect(applied.editorWidth).toBeLessThan(before.editorWidth);
      expect(applied.hourPitch).toBeGreaterThan(before.hourPitch);
      expect(applied.rowHeight).toBeGreaterThan(before.rowHeight);
      await app.getByRole("button", { name: /^Today/ }).click();
      await quickAdd(app, "sort the post");
      await app
        .getByRole("group", { name: "Views and folders" })
        .getByRole("button", { exact: true, name: "Errands" })
        .click();
      await expect(
        app.locator("[data-page-list-item]").filter({ hasText: "sort the post" })
      ).toBeVisible();
    });

    await appTest.step("SET-02 each survives a relaunch", async () => {
      await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);
      await app.reload();
      await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();
      await expect(html).not.toHaveClass(/\bdark\b/);
      await expect.poll(measure.textScale).toBe("1.3");
      await openEditorForPage(app, "reading list");
      expect(await measure.editorFont()).toBe(applied.editorFont);
      expect(await measure.editorWidth()).toBe(applied.editorWidth);
      expect(await measure.rowHeight()).toBe(applied.rowHeight);
      expect(await measure.calendarLabelSize()).toBe(applied.calendarLabelSize);
      expect(await measure.hourPitch()).toBe(applied.hourPitch);
      const columns = await measure.columns();
      expect(columns.count).toBe(3);
      await openSettings(app);
      await expect(
        settingsOf(app).getByRole("button", { name: "Default folder for new pages: Errands" })
      ).toBeVisible();
      const weekStart = settingsOf(app).getByRole("group", { name: "Week starts on" });
      await expect(weekStart.getByRole("button", { name: "Sunday" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      await expect(weekStart.getByRole("button", { name: "Monday" })).toHaveAttribute(
        "aria-pressed",
        "false"
      );
    });
  }
);

appTest(
  "the shortcuts panel lists every group, no key does two things, and a sampling works",
  { tag: ["@SET-06"] },
  async ({ app }) => {
    const settings = await openSettings(app, "Shortcuts");
    const groups = ["Navigation", "Page list", "Editor", "Quick add", "Calendar"];

    await appTest.step("SET-06 the five groups are listed", async () => {
      for (const group of groups) {
        await expect(settings.getByRole("list", { name: group })).toBeVisible();
      }
    });

    await appTest.step("SET-06 the palette's own keys are listed under Navigation", async () => {
      const navigation = settings.getByRole("list", { name: "Navigation" });
      for (const label of ["Search pages", "Run a command"]) {
        await expect(navigation.getByText(label, { exact: true })).toBeVisible();
      }
    });

    await appTest.step("SET-06 the calendar's keys are listed under Calendar", async () => {
      const calendar = settings.getByRole("list", { name: "Calendar" });
      for (const label of ["Previous week", "Next week", "Jump to today", "Switch to month view"]) {
        await expect(calendar.getByText(label, { exact: true })).toBeVisible();
      }
    });

    await appTest.step("SET-06 no key is bound to two things", async () => {
      const byCombo = new Map<string, string[]>();
      for (const item of await settings.getByRole("listitem").all()) {
        const [label, ...keys] = (await item.innerText())
          .split("\n")
          .map((t) => t.trim())
          .filter(Boolean);
        const combo = keys.join("+");
        byCombo.set(combo, [...(byCombo.get(combo) ?? []), label!]);
      }
      // The one deliberate split: link with a selection, palette without. Why is in
      // scripts/check-shortcut-conflicts.mjs (ALLOWED_SHADOWING).
      const split = ["Insert / edit link", "Run a command"];
      const doubled = [...byCombo].filter(
        ([, labels]) => labels.length > 1 && [...labels].sort().join() !== split.join()
      );
      expect(doubled).toEqual([]);
    });

    await appTest.step("SET-06 a sampling of them works", async () => {
      await app.keyboard.press("Escape");
      await expect(settings).not.toBeVisible();
      await app.keyboard.press(mod("Mod+n"));
      await expect(app.getByRole("dialog", { name: "Quick add" })).toBeVisible();
      await app.keyboard.press("Escape");
      await app.keyboard.press(mod("Mod+\\"));
      await expect(app.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
      await app.keyboard.press(mod("Mod+\\"));
      await app.keyboard.press(mod("Mod+Shift+c"));
      await expect(app.getByRole("region", { name: "Week calendar" })).toBeVisible();
      await app.keyboard.press(mod("Mod+,"));
      await expect(settings).toBeVisible();
    });
  }
);

// SET-10 stays manual: Help → Report a Bug builds its URL in the native menu, which the lane
// can't reach. This covers the Settings half, untagged because it can't claim the row.
appTest(
  "Copy email copies the address, and Report opens the bug page with version info",
  async ({ app }) => {
    const settings = await openSettings(app);

    await appTest.step("Copy email puts the address on the clipboard and says Copied", async () => {
      // Linux WebKit refuses a page reading the clipboard back, whatever the permission, so
      // the test records what the app writes to it instead.
      await app.evaluate(() => {
        const clipboard = globalThis.navigator.clipboard;
        const write = clipboard.writeText.bind(clipboard);
        clipboard.writeText = (text: string) => {
          (globalThis as { copied?: string }).copied = text;
          return write(text);
        };
      });
      await settings.getByRole("button", { name: "Copy email" }).click();
      await expect(settings.getByRole("button", { name: "Copied" })).toBeVisible();
      expect(await app.evaluate(() => (globalThis as { copied?: string }).copied)).toBe(
        "hello@pikos.app"
      );
    });

    await appTest.step("Report opens pikos.app/bugs with os and version", async () => {
      await settings.getByRole("button", { exact: true, name: "Report" }).click();
      const opened = await app.evaluate(() =>
        (
          window as unknown as { __PIKOS_PLATFORM_CALLS__: { args: unknown[]; method: string }[] }
        ).__PIKOS_PLATFORM_CALLS__
          .filter((c) => c.method === "openExternal")
          .map((c) => String(c.args[0]))
      );
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatch(/^https:\/\/pikos\.app\/bugs\?os=\w+&version=\d+\.\d+\.\d+/);
    });
  }
);

appTest(
  "the Data panel counts this workspace and lights only the features in use",
  { tag: ["@SET-11"] },
  async ({ app }) => {
    const chip = (name: string, state: "in use" | "not used") =>
      settingsOf(app).getByRole("group", { name: `${name}: ${state}` });
    const card = (name: string) => settingsOf(app).getByRole("group", { exact: true, name });

    await appTest.step("SET-11 an empty workspace lights nothing", async () => {
      await openSettings(app, "Data");
      for (const feature of [
        "Notes",
        "Tasks",
        "Scheduling",
        "Priorities",
        "Tags",
        "Recurring",
        "Focus",
      ]) {
        await expect(chip(feature, "not used")).toBeVisible();
      }
      await app.keyboard.press("Escape");
    });

    await createFolder(app, "Work");
    await quickAdd(app, "draft report #ledger !high today");
    await quickAdd(app, "file taxes");
    await quickAdd(app, "yoga every day");
    await openEditorForPage(app, "draft report");
    await app.keyboard.type("three little words");
    const taxes = app.locator("[data-page-list-item]").filter({ hasText: "file taxes" });
    await taxes.getByRole("checkbox", { name: "Mark done" }).click();
    await expect(taxes).toHaveCount(0);
    await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);

    await appTest.step(
      "SET-11 the figures read right, counting pages not schedule rows",
      async () => {
        await openSettings(app, "Data");
        await expect(card("Pages")).toContainText("3");
        await expect(card("Words")).toContainText("3");
        await expect(card("Completed")).toContainText("1");
        await expect(card("Folders")).toContainText("1");
        await expect(card("Scheduled")).toContainText("2");
        await expect(card("Focus time")).toContainText(/^Focus time\s*0/);
      }
    );

    await appTest.step("SET-11 the chips light for what is in use and no more", async () => {
      for (const feature of ["Notes", "Tasks", "Scheduling", "Priorities", "Tags", "Recurring"]) {
        await expect(chip(feature, "in use")).toBeVisible();
      }
      await expect(chip("Focus", "not used")).toBeVisible();
      await expect(chip("Calendar sync", "not used")).toBeVisible();
    });
  }
);
