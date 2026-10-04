import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { BRIDGE_ORIGIN } from "../bridge/origin";
import { ensureLargeTemplate, LARGE_TOKEN_SUFFIX } from "./largeWorkspace";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

/** The page write queue's debounce (see `PagesContext`). An edit reaches the writer
 *  only after it, and a reload inside it loses the edit: a known gap, not a row's.
 *  A person relaunching takes longer than twice this. */
export const WRITE_QUEUE_DEBOUNCE_MS = 800;

/** Which writer a lane runs the specs against. The bridge lane sets it in its config. */
export type StorageLane = "bridge" | "mock";

/** Tells one run's databases from the last, since a local bridge can outlive a run. */
const RUN = Date.now().toString(36);

/** What a test's workspace starts with. `large` is a 20,000-page copy of a prebuilt template
 *  (see `largeWorkspace.ts`), real writer only. */
export type StartingWorkspace = "empty" | "large";

/** `tightCache`: three rows a window, so every list pages, and a budget that holds little more
 *  than the list on screen, so switching views evicts and refetches. Each list shown is also
 *  checked against the database, and a test fails on any difference. */
const TIGHT_CACHE = { budgetBytes: 6_000, windowSize: 3 };

export const test = base.extend<{
  app: Page;
  firstRun: boolean;
  storage: StorageLane;
  tightCache: boolean;
  workspace: StartingWorkspace;
}>({
  app: async ({ page, workspace }, use) => {
    await page.goto("/");
    // Workspace auto-creates on first launch — wait for it to be ready. A large one takes longer
    // to open over the bridge.
    await expect(page.getByRole("main", { name: "Workspace" })).toBeVisible(
      workspace === "large" ? { timeout: 120_000 } : {}
    );
    await use(page);
  },
  // On the context rather than in `app`, so specs that navigate the raw `page`
  // themselves get the token too, and a reload keeps it.
  context: async ({ context, firstRun, storage, tightCache, workspace }, use, testInfo) => {
    if (tightCache) {
      await context.addInitScript({
        content: `window.__PIKOS_VIEW_CACHE__ = ${JSON.stringify(TIGHT_CACHE)};`,
      });
    }
    if (workspace === "large" && storage !== "bridge") {
      throw new Error("A large workspace needs the real writer; tag the test @large");
    }
    if (storage === "bridge") {
      let token = `${RUN}-${testInfo.testId}-${testInfo.retry}`;
      if (workspace === "large") {
        ensureLargeTemplate(String(testInfo.project.use.timezoneId));
        token += LARGE_TOKEN_SUFFIX;
      }
      await context.addInitScript({
        content: `window.__PIKOS_E2E_DB__ = ${JSON.stringify(token)};`,
      });
      if (firstRun)
        await context.addInitScript({ content: "window.__PIKOS_E2E_FIRST_RUN__ = true;" });
    }
    await use(context);
  },
  /** Launch as on a clean profile, through the app's first-launch path. Every other test
   *  starts on an empty database, without the tutorial a first launch plants. */
  firstRun: [false, { option: true }],
  // The real writer reads the machine's clock and the zone the lane started it in,
  // so a faked browser clock or a spec's own zone splits one app across two dates
  // or zones, a state production cannot reach. A pass there proves nothing, so the
  // lane refuses rather than run it.
  page: async ({ page, storage, tightCache, timezoneId }, use, testInfo) => {
    if (storage === "bridge") {
      if (timezoneId !== testInfo.project.use.timezoneId) {
        throw new Error(
          `The real writer runs in ${String(testInfo.project.use.timezoneId)}, not ${String(timezoneId)}; tag the test @mock-only`
        );
      }
      page.clock.install = () =>
        Promise.reject(
          new Error("A pinned clock can't reach the real writer; tag the test @mock-only")
        );
    }
    await use(page);
    if (tightCache && !page.isClosed()) {
      const mismatches = await page
        .evaluate(
          () =>
            (globalThis as { __PIKOS_SHADOW_MISMATCHES__?: string[] })
              .__PIKOS_SHADOW_MISMATCHES__ ?? []
        )
        .catch(() => []);
      expect(mismatches, "a cached list differed from the database").toEqual([]);
    }
  },
  storage: ["mock", { option: true }],
  tightCache: [false, { option: true }],
  workspace: ["empty", { option: true }],
});

/** Press a shortcut like "Mod+n", replacing Mod with the platform modifier. */
export function mod(combo: string): string {
  return combo.replace("Mod", MOD);
}

/** Create a folder from the sidebar and name it. The name field exists only once the
 *  writer has made the folder, so keys typed before it takes focus are lost. */
export async function createFolder(page: Page, name: string) {
  await page
    .getByRole("toolbar", { name: "Folder actions" })
    .getByRole("button", { name: "New Folder" })
    .click();
  await expect(
    page.getByRole("group", { name: "Views and folders" }).getByRole("textbox")
  ).toBeFocused();
  // Typed rather than filled: the row wraps the field in aria-disabled while it
  // renames, which fill() reads as a disabled field.
  await page.keyboard.press(mod("Mod+a"));
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
}

/** Show the calendar by its header button: a Mod+Shift+C pressed before the keyboard
 *  registry mounts, as after a reload, is dropped. */
export async function openCalendarMode(page: Page) {
  const calendarBtn = page.getByRole("button", { name: "Calendar view" });
  await calendarBtn.waitFor({ state: "visible" });
  if ((await calendarBtn.getAttribute("aria-pressed")) !== "true") {
    await calendarBtn.click();
  }
  await expect(page.getByRole("region", { name: "Week calendar" })).toBeVisible();
}

function hourLabel(hour: number) {
  return `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;
}

/** The week grid's gutter label for an hour. */
export function gutterLabel(page: Page, hour: number) {
  return page
    .getByRole("region", { name: "Week calendar" })
    .getByText(hourLabel(hour), { exact: true })
    .first();
}

/** The gutter label straddles its hour line, so its middle is the line. */
export async function hourLineY(page: Page, hour: number) {
  const box = await gutterLabel(page, hour).boundingBox();
  if (!box) throw new Error(`no ${hourLabel(hour)} label`);
  return box.y + box.height / 2;
}

/** Open a page from the list and put the caret in its body. */
export async function openEditorForPage(page: Page, title: string) {
  await page.locator("[data-page-list-item]").getByText(title).click();
  const editor = page.getByRole("textbox", { name: "Page content" });
  await editor.click();
  return editor;
}

/** Send one command to the real writer behind this page, as its own database. For
 *  state the app can no longer create; everything else goes through the UI. */
export async function bridgeCall<T>(
  page: Page,
  command: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const db = await page.evaluate(
    () => (globalThis as unknown as { __PIKOS_E2E_DB__?: string }).__PIKOS_E2E_DB__
  );
  const response = await fetch(`${BRIDGE_ORIGIN}/command`, {
    body: JSON.stringify({ args, command, db }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const payload = (await response.json()) as { error?: unknown; value?: T };
  if (payload.error !== undefined) throw new Error(`${command}: ${JSON.stringify(payload.error)}`);
  return payload.value as T;
}

/** Ring the bell sync and the CLI ring after writing the database, as Rust would. The test
 *  build listens on an in-page emitter for it (`appEvents.ts`). */
export async function ringDoorbell(
  page: Page,
  event: "calendar-sync:applied" | "workspace:external-change" = "workspace:external-change"
) {
  await page.evaluate((name) => {
    (globalThis as unknown as { __PIKOS_E2E_EMIT__: (event: string) => void }).__PIKOS_E2E_EMIT__(
      name
    );
  }, event);
}

/** Wipe + load the synced-calendar seed via the Developer settings tab. */
export async function seedSynced(page: Page) {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Developer" }).click();
  await page.getByRole("button", { name: "Seed Mock calendar sync" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  // The gear comes back before the seed's rows reach the page; the calendar folders arrive with them.
  await expect(page.getByRole("button", { name: "Open settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Calendars" })).toBeVisible();
}

/** A day `offset` from today, spelled the ways the app shows it, read in the
 *  browser so it's the lane's zone, not the test runner's. */
export function dayFrom(page: Page, offset: number) {
  return page.evaluate((days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return {
      header: d.toLocaleDateString("en-US", { day: "numeric", month: "short", weekday: "short" }),
      monthDay: d.toLocaleDateString("en-US", { day: "numeric", month: "short" }),
      picker: d.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" }),
      weekday: d.toLocaleDateString("en-US", { weekday: "long" }),
    };
  }, offset);
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
