/**
 * Every screen, dialog, popover, menu and panel of the desktop app, screenshotted for design
 * review beside the iPhone tour (apps/ios/PikosUITests/Sources/ScreenTour.swift).
 *
 * Not part of the e2e gate: playwright.tour.config.ts runs it once per theme, and
 * scripts/desktop-screen-tour.sh lays the result out as a PDF. Each screenshot is named
 * `section|order|title`, which is what the PDF script sorts and captions by. A surface the tour
 * cannot reach goes on a missed list instead of failing the run, so one moved label does not
 * cost the other hundred shots.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, mod, test } from "./fixtures";

// A Tuesday late morning, so Today has overdue and upcoming rows and the now line sits inside a block.
const NOW = new Date("2026-09-15T11:20:00");

const VIEW = "pikos:lastActiveViewId";
const PANEL = "pikos:rightPanel";
const TODAY = { "pikos:overdueCollapsed": false, [VIEW]: "today" };
const CALENDAR = { ...TODAY, [PANEL]: "calendar", "pikos:calendarScrollHour": 7 };
const MODIFIER = mod("Mod") as "Control" | "Meta";

const WINDOW = { height: 900, width: 1440 };
const MEDIUM = { height: 900, width: 960 };
const SMALL = { height: 900, width: 720 };

type Prefs = Record<string, unknown>;

class Tour {
  private readonly missed: string[] = [];

  private constructor(
    readonly page: Page,
    private readonly section: string,
    private readonly dir: string,
    private readonly theme: string
  ) {}

  static async start(page: Page, section: string): Promise<Tour> {
    const info = test.info();
    const theme = String(info.project.metadata["theme"]);
    const dir = join(String(info.config.metadata["tourOut"]), theme);
    mkdirSync(dir, { recursive: true });
    await page.clock.install({ time: NOW });
    await page.clock.resume();
    return new Tour(page, section, dir, theme);
  }

  /** A fresh workspace: the in-memory store reseeds on every load, and preferences start from `prefs`. */
  async launch(prefs: Prefs = {}, origin = ""): Promise<void> {
    await this.page.goto(`${origin}/pikos-symbol.svg`);
    await this.page.evaluate(
      ({ entries, theme }) => {
        localStorage.clear();
        localStorage.setItem("pikos-theme", theme);
        for (const [key, value] of entries) localStorage.setItem(key, JSON.stringify(value));
      },
      { entries: Object.entries(prefs), theme: this.theme }
    );
    await this.page.goto(`${origin}/`);
    await expect(this.page.getByRole("main", { name: "Workspace" })).toBeVisible({
      timeout: 30_000,
    });
    await this.page.waitForLoadState("networkidle");
    await this.page.waitForTimeout(700);
  }

  /** Rest the pointer on the empty title bar, where it lights up nothing and opens no tooltip. */
  async park(): Promise<void> {
    const width = this.page.viewportSize()?.width ?? 1440;
    await this.page.mouse.move(width / 2, 8);
  }

  async shot(order: number, title: string, pointer: "keep" | "park" = "park"): Promise<void> {
    if (pointer === "park") await this.park();
    await this.page.waitForTimeout(500);
    const name = `${this.section}|${String(order).padStart(2, "0")}|${title}`;
    await this.page.screenshot({ animations: "disabled", path: join(this.dir, `${name}.png`) });
  }

  async capture(
    order: number,
    title: string,
    reach: () => Promise<unknown>,
    pointer: "keep" | "park" = "park"
  ): Promise<void> {
    try {
      await reach();
      await this.shot(order, title, pointer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-control-regex -- Playwright colours its messages with ANSI escapes
      const reason = (message.split("\n")[0] ?? "").replace(/\u001b\[\d+m/g, "");
      this.missed.push(`${this.section}: ${title} (${reason})`);
    }
  }

  finish(): void {
    writeFileSync(join(this.dir, `missed-${this.section}.txt`), this.missed.join("\n"));
  }
}

async function tour(page: Page, section: string, walk: (t: Tour) => Promise<void>) {
  const t = await Tour.start(page, section);
  try {
    await walk(t);
  } finally {
    t.finish();
  }
}

function sidebar(page: Page): Locator {
  return page.getByRole("group", { name: "Views and folders" });
}

async function openView(page: Page, name: RegExp | string): Promise<void> {
  const entry =
    typeof name === "string"
      ? sidebar(page).getByRole("button", { exact: true, name })
      : sidebar(page).getByRole("button", { name });
  await entry.first().click();
  await page.waitForTimeout(400);
}

function row(page: Page, title: string): Locator {
  return page.locator(`[data-page-list-item][aria-label=${JSON.stringify(title)}]`);
}

async function rightClick(locator: Locator): Promise<void> {
  await locator.click({ button: "right" });
  await expect(locator.page().getByRole("menu").first()).toBeVisible();
}

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dragTo(page: Page, from: Locator, to: { x: number; y: number }): Promise<void> {
  const box = await from.boundingBox();
  if (!box) throw new Error("element has no box");
  const start = { x: box.x + 24, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 16, start.y, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 16 });
  await page.waitForTimeout(300);
}

function settingsRegion(page: Page): Locator {
  return page.getByRole("region", { name: "Settings" });
}

function settingsScroller(page: Page): Locator {
  return settingsRegion(page).locator("div.overflow-y-auto").first();
}

/** Whether a settings tab runs past the window, so a second, scrolled shot shows anything new. */
async function settingsOverflow(page: Page): Promise<boolean> {
  return settingsScroller(page)
    .evaluate((el) => el.scrollHeight > el.clientHeight + 40)
    .catch(() => false);
}

async function scrollSettingsToEnd(page: Page): Promise<void> {
  await settingsScroller(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
}

function calendarRegion(page: Page): Locator {
  return page.getByRole("region", { name: "Week calendar" });
}

async function openPageFromToday(t: Tour, title: string): Promise<void> {
  await t.launch(TODAY);
  await row(t.page, title).click();
  await expect(t.page.getByRole("textbox", { name: "Page content" })).toBeVisible();
  await t.page.waitForTimeout(400);
}

async function selectEditorText(page: Page, text: string): Promise<void> {
  await page
    .getByRole("textbox", { name: "Page content" })
    .getByText(text)
    .click({ clickCount: 3 });
}

test("1 Lists @tour", async ({ page }) => {
  await tour(page, "1 Lists", async (t) => {
    await t.capture(1, "Today", () => t.launch(TODAY));
    await t.capture(2, "Today, overdue folded", () =>
      page.getByRole("button", { name: /^Overdue/ }).click()
    );
    await t.capture(3, "Upcoming", () => t.launch({ [VIEW]: "upcoming" }));
    await t.capture(4, "Inbox", () => t.launch());
    await t.capture(5, "A folder", async () => {
      await t.launch();
      await openView(page, "Projects");
    });
    await t.capture(6, "A folder with its completed pages open", () =>
      page.getByRole("button", { exact: true, name: "Completed" }).click()
    );
    await t.capture(7, "Sort menu", () => page.getByRole("button", { name: /^Sort:/ }).click());

    await t.capture(8, "Page menu (right-click a row)", async () => {
      await t.launch(TODAY);
      await rightClick(row(page, "Order FlexiSpot E7 frame"));
    });
    await t.capture(
      9,
      "Page menu: Move to Folder",
      () => page.getByRole("menuitem", { name: "Move to Folder" }).hover(),
      "keep"
    );
    await t.capture(10, "Rename, in place", async () => {
      await t.launch(TODAY);
      await rightClick(row(page, "Order FlexiSpot E7 frame"));
      await page.getByRole("menuitem", { name: "Rename" }).click();
      await row(page, "Order FlexiSpot E7 frame").getByRole("textbox").selectText();
    });

    await t.capture(11, "Two pages selected", async () => {
      await t.launch(TODAY);
      await row(page, "Order FlexiSpot E7 frame").click({ modifiers: [MODIFIER] });
      await row(page, "Call mom").click({ modifiers: [MODIFIER] });
    });
    await t.capture(12, "Page menu on a selection", () => rightClick(row(page, "Call mom")));

    await t.capture(13, "Relative dates", async () => {
      await t.launch(TODAY);
      await row(page, "Call mom")
        .getByRole("button", { name: /^Toggle date format/ })
        .click();
    });

    await t.capture(
      14,
      "Dragging a page onto a folder",
      async () => {
        await t.launch();
        const target = await center(
          sidebar(page).getByRole("button", { exact: true, name: "Projects" })
        );
        await dragTo(page, row(page, "Book the car in for a service"), target);
      },
      "keep"
    );
    await page.mouse.up();

    await t.capture(15, "Deleted, with Undo", async () => {
      await t.launch(TODAY);
      await rightClick(row(page, "Dinner with Sam"));
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await expect(page.getByRole("alert")).toBeVisible();
    });
    await t.capture(16, "Overdue moved to today, with Undo", async () => {
      await t.launch(TODAY);
      await page.getByRole("button", { name: "Move to today" }).click();
      await expect(page.getByRole("alert")).toBeVisible();
    });
  });
});

test("2 Quick add @tour", async ({ page }) => {
  await tour(page, "2 Quick add", async (t) => {
    const dialog = page.getByRole("dialog", { name: "Quick add" });
    const input = page.getByRole("textbox", { name: "Quick add input" });
    const sentence = "Call the dentist tomorrow at 3pm !high #health ~Personal";

    async function open(text = "") {
      await page.getByRole("button", { name: "New Page" }).click();
      await expect(input).toBeVisible();
      if (text) {
        await input.fill(text);
        await page.waitForTimeout(500);
      }
    }

    async function closePopover() {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      await expect(dialog).toBeVisible();
    }

    await t.capture(1, "Quick add", async () => {
      await t.launch();
      await open();
    });
    await t.capture(2, "Quick add, a sentence read", async () => {
      await input.fill(sentence);
      await expect(dialog.getByRole("button", { name: "Priority: High" })).toBeVisible();
    });
    await t.capture(3, "Folder menu", () =>
      dialog.getByRole("button", { name: /^Folder:/ }).click()
    );
    await t.capture(4, "Date and time picker", async () => {
      await closePopover();
      await dialog.getByRole("button", { name: /^Scheduled:/ }).click();
    });
    await t.capture(5, "Repeat menu", async () => {
      await closePopover();
      await dialog.getByRole("button", { name: /^Set recurrence|^Recurrence:/ }).click();
    });
    await t.capture(6, "Repeat menu, custom", () =>
      page.getByRole("button", { name: "Custom…" }).click()
    );
    await t.capture(7, "Priority menu", async () => {
      await closePopover();
      await dialog.getByRole("button", { name: /^Priority:/ }).click();
    });
    await t.capture(8, "Tags menu", async () => {
      await closePopover();
      await dialog.getByRole("button", { name: /^Tags:/ }).click();
    });

    await t.capture(9, "A repeating sentence", async () => {
      await t.launch();
      await open("Water the ferns every Saturday at 9am for 8 weeks #home");
      await expect(dialog.getByRole("button", { name: /^Recurrence:/ })).toBeVisible();
    });
    await t.capture(10, "Opened from Today", async () => {
      await t.launch(TODAY);
      await open();
    });
    await t.capture(11, "Opened from a folder", async () => {
      await t.launch();
      await openView(page, "Projects");
      await open();
    });
    await t.capture(12, "Added, ready for the next one", async () => {
      await input.fill("Pick up the dry cleaning");
      await page.waitForTimeout(300);
      await input.press(`${MODIFIER}+Enter`);
      await expect(dialog.getByText("Pick up the dry cleaning")).toBeVisible();
    });
  });
});

test("3 Calendar @tour", async ({ page }) => {
  await tour(page, "3 Calendar", async (t) => {
    const calendar = calendarRegion(page);

    await t.capture(1, "Week", () => t.launch(CALENDAR));
    await t.capture(2, "Five days", () => t.launch({ ...CALENDAR, "pikos:calendarDayCount": 5 }));
    await t.capture(3, "Weekdays", () => t.launch({ ...CALENDAR, "pikos:calendarDayCount": "mf" }));
    await t.capture(4, "Three days", () => t.launch({ ...CALENDAR, "pikos:calendarDayCount": 3 }));
    await t.capture(5, "One day", () => t.launch({ ...CALENDAR, "pikos:calendarDayCount": 1 }));
    await t.capture(6, "Month", async () => {
      await t.launch({ ...CALENDAR, "pikos:calendarViewMode": "month" });
      await expect(page.getByRole("region", { name: "Month calendar" })).toBeVisible();
    });
    await t.capture(7, "Next week", async () => {
      await t.launch(CALENDAR);
      await page.getByRole("button", { name: "Next week" }).click();
    });
    await t.capture(8, "Early hours expanded", async () => {
      await t.launch(CALENDAR);
      await page
        .getByRole("button", { name: /^Expand 12 AM/ })
        .first()
        .click();
      await page.locator('[aria-label="Time grid"]').evaluate((el) => {
        el.scrollTop = 0;
      });
    });
    await t.capture(
      9,
      "Header tooltip",
      async () => {
        await t.launch(CALENDAR);
        await page.getByRole("button", { name: "Month view" }).hover();
        await expect(page.getByRole("tooltip").first()).toBeVisible();
      },
      "keep"
    );

    await t.capture(10, "Block popover", async () => {
      await t.launch(CALENDAR);
      await calendar.getByRole("button", { name: /^Design recipe data model,/ }).click();
      await expect(page.getByRole("button", { name: "Open page" })).toBeVisible();
    });
    await t.capture(11, "Block popover, date picker", () =>
      page
        .getByRole("dialog")
        .getByRole("button", { name: /^Scheduled:/ })
        .click()
    );
    await t.capture(12, "Repeating block popover", async () => {
      await t.launch(CALENDAR);
      await calendar
        .getByRole("button", { name: /^Daily standup,/ })
        .filter({ has: page.getByLabel("Recurring") })
        .last()
        .click();
      await expect(page.getByRole("button", { name: "Delete this occurrence" })).toBeVisible();
    });
    await t.capture(13, "Drag to create", async () => {
      await t.launch(CALENDAR);
      const column = await calendar
        .locator('[aria-label^="All-day events, Thursday"]')
        .boundingBox();
      const two = await center(calendar.getByText("2 PM", { exact: true }).first());
      const four = await center(calendar.getByText("4 PM", { exact: true }).first());
      if (!column) throw new Error("no Thursday column");
      const x = column.x + column.width / 2;
      await page.mouse.move(x, two.y + 6);
      await page.mouse.down();
      await page.mouse.move(x, two.y + 40, { steps: 4 });
      await page.mouse.move(x, four.y - 30, { steps: 8 });
      await page.mouse.up();
      await expect(page.getByPlaceholder("Untitled")).toBeFocused();
    });
    await t.capture(14, "Click to create an all-day page", async () => {
      await t.launch(CALENDAR);
      await calendar.locator('[aria-label^="All-day events, Friday"]').click();
      await expect(page.getByPlaceholder("Untitled")).toBeFocused();
    });
    await t.capture(
      15,
      "Dragging a page onto the calendar",
      async () => {
        await t.launch(CALENDAR);
        const column = await calendar
          .locator('[aria-label^="All-day events, Wednesday"]')
          .boundingBox();
        const three = await center(calendar.getByText("3 PM", { exact: true }).first());
        if (!column) throw new Error("no Wednesday column");
        await dragTo(page, row(page, "Transfer $1,200 to HYSA"), {
          x: column.x + column.width / 2,
          y: three.y + 8,
        });
      },
      "keep"
    );
    await page.mouse.up();

    await t.capture(16, "Missed repeat: ticking a page with days behind it", async () => {
      await t.launch(CALENDAR);
      await row(page, "Water the plants")
        .getByRole("checkbox", { name: /Mark done/ })
        .click();
      await expect(page.getByText(/earlier days? (are|is) still open/)).toBeVisible();
    });
    await t.capture(17, "Missed repeat: deleting a past occurrence", async () => {
      await t.launch(CALENDAR);
      await calendar
        .getByRole("button", { name: /^Water the plants,/ })
        .filter({ has: page.getByLabel("Recurring") })
        .first()
        .click();
      await page.getByRole("button", { name: "Delete this occurrence" }).click();
      await expect(page.getByText(/earlier days? (are|is) still open/)).toBeVisible();
    });
  });
});

test("4 Search @tour", async ({ page }) => {
  await tour(page, "4 Search", async (t) => {
    const search = page.getByPlaceholder("Search pages, or > for commands…");

    await t.capture(1, "Search, nothing typed", async () => {
      await t.launch(TODAY);
      await page.getByRole("button", { name: "Search" }).click();
      await expect(search).toBeFocused();
    });
    await t.capture(2, "Results", async () => {
      await search.fill("desk");
      await expect(page.getByRole("button", { name: /^Show completed/ })).toBeVisible();
    });
    await t.capture(3, "Results with completed pages", () =>
      page.getByRole("button", { name: /^Show completed/ }).click()
    );
    await t.capture(4, "Filtered by tag", async () => {
      await search.fill("tag:home");
      await page.waitForTimeout(400);
    });
    await t.capture(5, "Nothing found", async () => {
      await search.fill("snorkel");
      await expect(page.getByText("No pages found")).toBeVisible();
    });
    await t.capture(6, "Command mode", async () => {
      await search.fill("> ");
      await page.waitForTimeout(300);
    });
    await t.capture(7, "Commands, filtered", async () => {
      await search.fill("> cal");
      await page.waitForTimeout(300);
    });
  });
});

test("5 Editor @tour", async ({ page }) => {
  await tour(page, "5 Editor", async (t) => {
    const flexispot = "Order FlexiSpot E7 frame";
    const editor = page.getByRole("textbox", { name: "Page content" });

    await t.capture(1, "Page", () => openPageFromToday(t, flexispot));
    await t.capture(2, "Folder menu", () => page.getByRole("button", { name: /^Folder:/ }).click());
    await t.capture(3, "Date and time picker", async () => {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /^Scheduled:/ }).click();
    });
    await t.capture(4, "Reminder menu", async () => {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Page reminders" }).click();
    });
    await t.capture(5, "Priority menu", async () => {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /^Priority:/ }).click();
    });
    await t.capture(6, "Tags menu", async () => {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /^Tags:/ }).click();
    });
    await t.capture(7, "Repeat presets", async () => {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Set recurrence" }).click();
    });
    await t.capture(8, "Repeat, custom", () =>
      page.getByRole("button", { name: "Custom…" }).click()
    );
    await t.capture(9, "A repeating page's repeat menu", async () => {
      await openPageFromToday(t, "Daily standup");
      await page.getByRole("button", { name: /^Recurrence:/ }).click();
      await expect(page.getByRole("button", { name: "Stop repeating" })).toBeVisible();
    });

    await t.capture(10, "Formatting toolbar", async () => {
      await openPageFromToday(t, flexispot);
      await selectEditorText(page, "FlexiSpot E7 motorized frame");
      await expect(page.getByRole("button", { name: "Bold" })).toBeVisible();
    });
    await t.capture(11, "Link", async () => {
      await page.getByRole("button", { name: "Link" }).click();
      await page.waitForTimeout(300);
    });
    await t.capture(12, "Slash commands", async () => {
      await openPageFromToday(t, flexispot);
      await editor.click();
      await page.keyboard.press(`${MODIFIER}+ArrowDown`);
      await page.keyboard.press("Enter");
      await page.keyboard.type("/");
      await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
    });
    await t.capture(13, "Table, with its toolbar", async () => {
      await page.keyboard.type("table");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Add row below" })).toBeVisible();
    });
    await t.capture(14, "Find in page", async () => {
      await openPageFromToday(t, flexispot);
      await editor.click();
      await page.keyboard.press(`${MODIFIER}+f`);
      await expect(page.getByPlaceholder("Find…")).toBeFocused();
      await page.keyboard.type("desk");
      await expect(page.getByRole("button", { name: "Next match" })).toBeVisible();
    });
    await t.capture(15, "Page info", async () => {
      await openPageFromToday(t, flexispot);
      await page.getByRole("button", { name: "Page info" }).click();
    });
    await t.capture(16, "Focus timer running", async () => {
      await openPageFromToday(t, flexispot);
      await page.getByRole("button", { name: "Start focus timer" }).click();
      await page.waitForTimeout(2_500);
    });
    await t.capture(17, "A completed page", async () => {
      await openPageFromToday(t, flexispot);
      await page.getByRole("button", { name: "Mark done" }).first().click();
    });
  });
});

test("6 Settings @tour", async ({ page }) => {
  await tour(page, "6 Settings", async (t) => {
    const settings = settingsRegion(page);

    async function openSection(name: string) {
      await t.launch(TODAY);
      await page.getByRole("button", { name: "Open settings" }).click();
      await settings.getByRole("button", { exact: true, name }).click();
      await page.waitForTimeout(400);
    }

    async function further(order: number, title: string) {
      if (await settingsOverflow(page))
        await t.capture(order, title, () => scrollSettingsToEnd(page));
    }

    await t.capture(1, "General", () => openSection("General"));
    await further(2, "General, further down");
    await t.capture(3, "Default folder menu", async () => {
      await openSection("General");
      await settings.getByRole("button", { name: /Inbox$/ }).click();
    });
    await t.capture(4, "Notifications", () => openSection("Notifications"));
    await further(5, "Notifications, further down");
    await t.capture(6, "Calendar Sync", () => openSection("Calendar Sync"));
    await t.capture(7, "Add a calendar account", () =>
      settings.getByRole("button", { name: "Add account" }).click()
    );
    await t.capture(8, "Add a CalDAV account", () =>
      page
        .getByRole("dialog")
        .getByRole("button", { name: /CalDAV/ })
        .click()
    );
    await t.capture(9, "A connected account", async () => {
      await openSection("Calendar Sync");
      await settings.getByRole("button", { name: "Add account" }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /Google Calendar/ })
        .click();
      await expect(settings.getByRole("button", { name: /^Account actions for/ })).toBeVisible();
    });
    await t.capture(10, "Account actions", () =>
      settings.getByRole("button", { name: /^Account actions for/ }).click()
    );
    await t.capture(11, "Data", () => openSection("Data"));
    await further(12, "Data, further down");
    await t.capture(13, "Delete all data", async () => {
      await settings.getByRole("button", { exact: true, name: "Delete" }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    });
    await t.capture(14, "Delete all data, confirmation typed", () =>
      page.getByRole("alertdialog").getByRole("textbox").fill("delete")
    );
    await t.capture(15, "Shortcuts", () => openSection("Shortcuts"));
    await further(16, "Shortcuts, further down");
  });
});

test("7 Folders and trash @tour", async ({ page }) => {
  await tour(page, "7 Folders and trash", async (t) => {
    const folder = (name: string) => sidebar(page).getByRole("button", { exact: true, name });

    async function trashTwo() {
      await t.launch(TODAY);
      for (const title of ["Get 3 contractor quotes — kitchen", "Dinner with Sam"]) {
        await rightClick(row(page, title));
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await page.waitForTimeout(300);
      }
      await openView(page, "Trash");
    }

    await t.capture(
      1,
      "Sidebar, with folder actions on hover",
      async () => {
        await t.launch(TODAY);
        await sidebar(page).getByText("Folders", { exact: true }).hover();
      },
      "keep"
    );
    await t.capture(2, "Folder sort menu", () =>
      sidebar(page).getByRole("button", { name: "Sort folders" }).click()
    );
    await t.capture(3, "Folder menu", async () => {
      await t.launch(TODAY);
      await rightClick(folder("Projects"));
    });
    await t.capture(
      4,
      "Folder menu: Color",
      () => page.getByRole("menuitem", { name: "Color" }).hover(),
      "keep"
    );
    await t.capture(5, "Rename folder, in place", async () => {
      await t.launch(TODAY);
      await rightClick(folder("Projects"));
      await page.getByRole("menuitem", { name: "Rename" }).click();
      const name = page.getByRole("textbox", { name: "Rename Projects" });
      await expect(name).toBeFocused();
      await name.selectText();
    });
    await t.capture(6, "New folder, named in place", async () => {
      await t.launch(TODAY);
      await sidebar(page).getByRole("button", { name: "New Folder" }).click();
      await expect(sidebar(page).getByRole("textbox")).toBeFocused();
      await page.keyboard.type("Errands");
    });
    await t.capture(7, "Folder deleted, with Undo", async () => {
      await t.launch(TODAY);
      await rightClick(folder("Reading"));
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await expect(page.getByRole("alert")).toBeVisible();
    });
    await t.capture(8, "Trash", trashTwo);
    await t.capture(9, "Trash: delete forever", () =>
      page.getByRole("button", { name: /^Delete Get 3 contractor quotes.* forever$/ }).click()
    );
    await t.capture(10, "Trash: empty the trash", async () => {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Empty Trash" }).click();
    });
    await t.capture(11, "Trash, empty", async () => {
      await t.launch(TODAY);
      await openView(page, "Trash");
      await expect(page.getByText("The trash is empty.")).toBeVisible();
    });
  });
});

test("8 First run @tour", async ({ page }) => {
  await tour(page, "8 First run", async (t) => {
    const origin = String(test.info().config.metadata["firstRunURL"]);

    await t.capture(1, "Welcome page", async () => {
      await t.launch({}, origin);
      await expect(page.getByRole("textbox", { name: "Page content" })).toBeVisible();
    });
    await t.capture(2, "Today in a new workspace", () => openView(page, /^Today/));
    await t.capture(3, "Inbox in a new workspace", () => openView(page, /^Inbox/));
    await t.capture(4, "Calendar in a new workspace", () =>
      page.getByRole("button", { name: "Calendar view" }).click()
    );
  });
});

test("9 Window sizes @tour", async ({ page }) => {
  await tour(page, "9 Window sizes", async (t) => {
    await t.capture(1, "Sidebar collapsed", async () => {
      await openPageFromToday(t, "Order FlexiSpot E7 frame");
      await page.getByRole("button", { name: "Collapse sidebar" }).click();
      await page.waitForTimeout(500);
    });

    await page.setViewportSize(MEDIUM);
    await t.capture(2, "Medium window, view switcher in the list", () =>
      openPageFromToday(t, "Order FlexiSpot E7 frame")
    );
    await t.capture(3, "View switcher", () =>
      page.getByRole("button", { name: "Switch view" }).click()
    );
    await t.capture(4, "View switcher, new folder", async () => {
      await page.getByRole("button", { exact: true, name: "New folder" }).click();
      await expect(page.getByPlaceholder("Folder name")).toBeFocused();
      await page.keyboard.type("Errands");
    });
    await t.capture(5, "Medium window, calendar", () => t.launch(CALENDAR));

    // The list lives in a drawer at this width, so the page is opened before the window narrows.
    await t.capture(6, "Small window, list tucked away", async () => {
      await page.setViewportSize(WINDOW);
      await openPageFromToday(t, "Order FlexiSpot E7 frame");
      await page.setViewportSize(SMALL);
      await page.waitForTimeout(600);
    });
    await t.capture(7, "Small window, list drawer open", async () => {
      await page.setViewportSize(SMALL);
      await page.getByRole("button", { name: "Expand sidebar" }).click();
      await page.waitForTimeout(500);
    });
    await t.capture(8, "Small window, calendar", async () => {
      await page.setViewportSize(SMALL);
      await t.launch(CALENDAR);
    });
  });
});

/**
 * What a calendar owns, and what it does not.
 *
 * Its own seed and its own server: `synced` plants the mirrors, the locked series, the detached
 * pages and the two provider rule shapes. Most of what the QA pass asks about a synced page is
 * whether an affordance is *absent*, which is a question a picture answers.
 */
test("10 A calendar's pages @tour", async ({ page }) => {
  await tour(page, "10 A calendar's pages", async (t) => {
    const origin = String(test.info().config.metadata["syncedURL"]);
    const calendar = calendarRegion(page);
    const mirror = "Team standup";
    const detached = "Old planning (detached)";

    // The seed spreads the calendar over two folders: the mirrors sit in Personal, the detached
    // pages in Work.
    async function openCalendarFolder(name: string, prefs: Prefs = TODAY): Promise<void> {
      await t.launch(prefs, origin);
      await openView(page, name);
    }

    await t.capture(1, "A calendar's folder in the list", () => openCalendarFolder("Personal"));
    await t.capture(2, "A mirror's menu, without the actions the calendar owns", () =>
      rightClick(row(page, mirror))
    );
    await t.capture(3, "A detached page's menu, with every action back", async () => {
      await openCalendarFolder("Work");
      await rightClick(row(page, detached));
    });
    await t.capture(4, "A calendar's folder menu", async () => {
      await page.keyboard.press("Escape");
      await rightClick(sidebar(page).getByRole("button", { exact: true, name: "Personal" }));
    });
    await t.capture(5, "A mirror in the editor", async () => {
      await openCalendarFolder("Personal");
      await row(page, mirror).click();
      await expect(page.getByRole("textbox", { name: "Page content" })).toBeVisible();
      await page.waitForTimeout(400);
    });
    await t.capture(6, "A mirror's block on the calendar", async () => {
      await t.launch(CALENDAR, origin);
      await calendar
        .getByRole("button", { name: new RegExp(`^${mirror},`) })
        .first()
        .click();
      await expect(page.getByRole("button", { name: "Open page" })).toBeVisible();
    });
    await t.capture(7, "A detached page in the editor", async () => {
      await openCalendarFolder("Work");
      await row(page, detached).click();
      await expect(page.getByRole("textbox", { name: "Page content" })).toBeVisible();
      await page.waitForTimeout(400);
    });
    await t.capture(8, "Settings, with the calendar connected", async () => {
      await t.launch(TODAY, origin);
      await page.keyboard.press(`${MODIFIER}+,`);
      await page.getByRole("button", { exact: true, name: "Calendar Sync" }).click();
      await page.waitForTimeout(500);
    });
  });
});

/**
 * The text ladder, which is the half of the accessibility rows a screenshot can answer: whether
 * the layout holds at each rung. Whether WKWebView rasterises it crisply, and whether the gesture
 * that gets there feels smooth, are the packaged app's to answer and stay in the manual pass.
 */
test("11 Text size @tour", async ({ page }) => {
  await tour(page, "11 Text size", async (t) => {
    const scale = (value: number) => ({ ...TODAY, "pikos:interfaceTextScale": value });

    await t.capture(1, "Interface text at 115%", () => t.launch(scale(1.15)));
    await t.capture(2, "Interface text at 150%", () => t.launch(scale(1.5)));
    await t.capture(3, "Interface text at 200%", () => t.launch(scale(2)));
    await t.capture(4, "A page at 200%", async () => {
      await row(page, "Order FlexiSpot E7 frame").click();
      await expect(page.getByRole("textbox", { name: "Page content" })).toBeVisible();
      await page.waitForTimeout(400);
    });
    await t.capture(5, "Settings at 200%", async () => {
      await page.keyboard.press(`${MODIFIER}+,`);
      await expect(settingsRegion(page)).toBeVisible();
      await page.waitForTimeout(400);
    });
    await t.capture(6, "The calendar at 200%", () =>
      t.launch({ ...CALENDAR, "pikos:interfaceTextScale": 2 })
    );
    await t.capture(7, "Calendar text at its smallest, 10px", () =>
      t.launch({ ...CALENDAR, "pikos:calendarTextSize": 10 })
    );
  });
});
