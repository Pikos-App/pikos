// E2E tests for the Tiptap editor — formatting, slash commands, keyboard
// shortcuts, and content structure. All run against MockStorageAdapter
// (VITE_TEST_MODE=true) so no Tauri backend is needed.

import {
  test as appTest,
  expect,
  mod,
  openEditorForPage,
  quickAdd,
  WRITE_QUEUE_DEBOUNCE_MS,
} from "./fixtures";

// ─── Formatting via keyboard shortcuts ──────────────────────────────────────

appTest("bold formatting via Cmd+B", async ({ app }) => {
  await quickAdd(app, "bold test");
  const editor = await openEditorForPage(app, "bold test");

  await app.keyboard.type("normal ");
  await app.keyboard.press(mod("Mod+b"));
  await app.keyboard.type("bold text");
  await app.keyboard.press(mod("Mod+b"));

  await expect(editor.locator("strong")).toHaveText("bold text");
});

appTest("italic formatting via Cmd+I", async ({ app }) => {
  await quickAdd(app, "italic test");
  const editor = await openEditorForPage(app, "italic test");

  await app.keyboard.type("normal ");
  await app.keyboard.press(mod("Mod+i"));
  await app.keyboard.type("italic text");
  await app.keyboard.press(mod("Mod+i"));

  await expect(editor.locator("em")).toHaveText("italic text");
});

appTest("strikethrough formatting via Cmd+Shift+S", async ({ app }) => {
  await quickAdd(app, "strike test");
  const editor = await openEditorForPage(app, "strike test");

  await app.keyboard.press(mod("Mod+Shift+s"));
  await app.keyboard.type("struck");
  await app.keyboard.press(mod("Mod+Shift+s"));

  await expect(editor.locator("s")).toHaveText("struck");
});

appTest("inline code via Cmd+E", async ({ app }) => {
  await quickAdd(app, "code test");
  const editor = await openEditorForPage(app, "code test");

  await app.keyboard.press(mod("Mod+e"));
  await app.keyboard.type("const x = 1");
  await app.keyboard.press(mod("Mod+e"));

  await expect(editor.locator("code")).toHaveText("const x = 1");
});

// ─── Slash commands ─────────────────────────────────────────────────────────

appTest("slash command inserts heading", async ({ app }) => {
  await quickAdd(app, "slash heading test");
  const editor = await openEditorForPage(app, "slash heading test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();

  await app.keyboard.type("h1");
  await app.keyboard.press("Enter");

  await expect(app.locator(".slash-menu")).not.toBeVisible();

  await app.keyboard.type("My Heading");
  await expect(editor.locator("h1")).toHaveText("My Heading");
});

appTest("slash command inserts bullet list", async ({ app }) => {
  await quickAdd(app, "slash list test");
  const editor = await openEditorForPage(app, "slash list test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("bullet");
  await app.keyboard.press("Enter");

  await app.keyboard.type("First item");
  await app.keyboard.press("Enter");
  await app.keyboard.type("Second item");

  const items = editor.locator("ul:not([data-type]) li");
  await expect(items).toHaveCount(2);
});

appTest("slash command inserts task list", async ({ app }) => {
  await quickAdd(app, "slash task test");
  const editor = await openEditorForPage(app, "slash task test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("task");
  await app.keyboard.press("Enter");

  await app.keyboard.type("My task");

  const taskList = editor.locator("ul[data-type='taskList']");
  await expect(taskList).toBeVisible();
  await expect(taskList.locator("li")).toHaveCount(1);
});

appTest("slash command inserts code block", async ({ app }) => {
  await quickAdd(app, "slash code test");
  const editor = await openEditorForPage(app, "slash code test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("code");
  await app.keyboard.press("Enter");

  await app.keyboard.type("console.log('hello')");

  await expect(editor.locator("pre code")).toContainText("console.log");
});

appTest("slash command inserts blockquote", async ({ app }) => {
  await quickAdd(app, "slash quote test");
  const editor = await openEditorForPage(app, "slash quote test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("quote");
  await app.keyboard.press("Enter");

  await app.keyboard.type("Wise words");

  await expect(editor.locator("blockquote")).toContainText("Wise words");
});

appTest("slash command inserts horizontal rule", async ({ app }) => {
  await quickAdd(app, "slash hr test");
  const editor = await openEditorForPage(app, "slash hr test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("hr");
  await app.keyboard.press("Enter");

  await expect(editor.locator("hr")).toBeVisible();
});

appTest("slash command inserts table", async ({ app }) => {
  await quickAdd(app, "slash table test");
  const editor = await openEditorForPage(app, "slash table test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("table");
  await app.keyboard.press("Enter");

  // Default 3x3 table with header row
  await expect(editor.locator("table")).toBeVisible();
  await expect(editor.locator("th")).toHaveCount(3);
  await expect(editor.locator("tr")).toHaveCount(3);
});

appTest("escape closes slash menu without inserting", async ({ app }) => {
  await quickAdd(app, "slash escape test");
  await openEditorForPage(app, "slash escape test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.press("Escape");
  await expect(app.locator(".slash-menu")).not.toBeVisible();
});

// ─── Task list interaction ──────────────────────────────────────────────────

appTest("task checkbox toggles checked state", async ({ app }) => {
  await quickAdd(app, "checkbox test");
  const editor = await openEditorForPage(app, "checkbox test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("task");
  await app.keyboard.press("Enter");
  await app.keyboard.type("Toggle me");

  const checkbox = editor.locator("ul[data-type='taskList'] input[type='checkbox']");
  await expect(checkbox).not.toBeChecked();

  await checkbox.click();
  await expect(checkbox).toBeChecked();

  await checkbox.click();
  await expect(checkbox).not.toBeChecked();
});

// A checkbox in the body is one line of a note; the page's own status is whether
// the page is done. Nothing else pins them apart, and the two read identically on
// screen — a tick next to text.

appTest(
  "ticking an inline task leaves the page's own status open",
  { tag: ["@EDIT-06"] },
  async ({ app }) => {
    await quickAdd(app, "inline status test");
    const editor = await openEditorForPage(app, "inline status test");

    await app.keyboard.type("/");
    await expect(app.locator(".slash-menu")).toBeVisible();
    await app.keyboard.type("task");
    await app.keyboard.press("Enter");
    await app.keyboard.type("Toggle me");

    const status = app.getByRole("button", { name: "Mark done" });
    await expect(status).toHaveText("Open");

    const checkbox = editor.locator("ul[data-type='taskList'] input[type='checkbox']");
    await checkbox.click();
    await expect(checkbox).toBeChecked();

    // A flipped page status renames the chip to "Mark not done", so this resolves
    // to nothing rather than reading "Done".
    await expect(status).toHaveText("Open");
  }
);

// ─── Content persistence ────────────────────────────────────────────────────

appTest("formatted content persists across page switches @smoke", async ({ app }) => {
  await quickAdd(app, "persist-fmt-1");
  await quickAdd(app, "persist-fmt-2");

  const editor = await openEditorForPage(app, "persist-fmt-1");

  await app.keyboard.press(mod("Mod+b"));
  await app.keyboard.type("bold");
  await app.keyboard.press(mod("Mod+b"));
  await app.keyboard.type(" and ");
  await app.keyboard.press(mod("Mod+i"));
  await app.keyboard.type("italic");

  await app.locator("[data-page-list-item]").getByText("persist-fmt-2").click();
  await app.locator("[data-page-list-item]").getByText("persist-fmt-1").click();

  await expect(editor.locator("strong")).toHaveText("bold");
  await expect(editor.locator("em")).toHaveText("italic");
});

// ─── Table toolbar ──────────────────────────────────────────────────────────

appTest("table toolbar appears when cursor is in table", async ({ app }) => {
  await quickAdd(app, "table toolbar test");
  await openEditorForPage(app, "table toolbar test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("table");
  await app.keyboard.press("Enter");

  // Toolbar should be visible (cursor is in the table after insert)
  await expect(app.locator(".table-toolbar")).toBeVisible();

  // Arrow the cursor out of the table; toolbar dismissal is not asserted here.
  await app.keyboard.press(mod("Mod+a"));
  await app.keyboard.press("ArrowDown");
  await app.keyboard.press("ArrowDown");
  await app.keyboard.press("ArrowDown");
  await app.keyboard.press("ArrowDown");
});

appTest("table toolbar adds row below", { tag: ["@EDIT-09:3"] }, async ({ app }) => {
  await quickAdd(app, "table addrow test");
  const editor = await openEditorForPage(app, "table addrow test");

  // Insert a table (3x3 default)
  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("table");
  await app.keyboard.press("Enter");

  await expect(editor.locator("tr")).toHaveCount(3);

  await app.locator(".table-toolbar").getByRole("button", { name: "Add row below" }).click();

  await expect(editor.locator("tr")).toHaveCount(4);
});

appTest("table toolbar adds and removes column", { tag: ["@EDIT-09:3"] }, async ({ app }) => {
  await quickAdd(app, "table col test");
  const editor = await openEditorForPage(app, "table col test");

  // Insert a table (3 cols)
  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("table");
  await app.keyboard.press("Enter");

  await expect(editor.locator("th")).toHaveCount(3);

  await app.locator(".table-toolbar").getByRole("button", { name: "Add column after" }).click();
  await expect(editor.locator("th")).toHaveCount(4);

  await app.locator(".table-toolbar").getByRole("button", { name: "Delete column" }).click();
  await expect(editor.locator("th")).toHaveCount(3);
});

appTest("table toolbar deletes table", { tag: ["@EDIT-09:3"] }, async ({ app }) => {
  await quickAdd(app, "table delete test");
  const editor = await openEditorForPage(app, "table delete test");

  await app.keyboard.type("/");
  await expect(app.locator(".slash-menu")).toBeVisible();
  await app.keyboard.type("table");
  await app.keyboard.press("Enter");

  await expect(editor.locator("table")).toBeVisible();

  await app.locator(".table-toolbar").getByRole("button", { name: "Delete table" }).click();

  await expect(editor.locator("table")).not.toBeVisible();
});

// ─── Link insertion via the bubble toolbar ─────────────────────────────────
//
// The format bubble toolbar appears once the user has selected text. Its
// Link button (aria-label="Link") opens the LinkPopover, which exposes a
// URL input that commits on Enter and wraps the selection in <a href>.

appTest("bubble toolbar inserts a link around the selection", async ({ app }) => {
  await quickAdd(app, "link insert test");
  const editor = await openEditorForPage(app, "link insert test");

  // Type some text and select the last word ("Pikos") so the bubble toolbar
  // has something to wrap. Five Shift+ArrowLeft keys cover the 5-char word.
  await app.keyboard.type("Visit Pikos");
  for (let i = 0; i < 5; i++) await app.keyboard.press("Shift+ArrowLeft");

  // Bubble toolbar mounts on selection. Click the Link button — it blurs
  // the editor (so the selection is preserved in editor state) and surfaces
  // the LinkPopover input.
  const bubble = app.locator(".bubble-toolbar");
  await expect(bubble).toBeVisible();
  await bubble.getByRole("button", { name: "Link" }).click();

  const urlInput = app.locator(".link-popover-input");
  await expect(urlInput).toBeVisible();
  await urlInput.fill("https://pikos.app");
  await app.keyboard.press("Enter");

  const link = editor.locator('a[href="https://pikos.app"]');
  await expect(link).toHaveText("Pikos");
});

// ─── Focus timer clears the room and reports on the way out ─────────────────

// The session hides the left panels for the duration. It must not write the
// user's standing sidebar preference to do it: a run that ended by quitting the
// app would otherwise leave the panels gone on the next launch, with nothing on
// screen to explain why.

appTest(
  "a focus session hides the left panels and gives them back",
  { tag: ["@EDIT-20:4"] },
  async ({ app }) => {
    await quickAdd(app, "Deep work");
    await openEditorForPage(app, "Deep work");
    const hiddenListRow = app.locator("[inert] [data-page-list-item]").getByText("Deep work");

    await expect(app.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    await expect(hiddenListRow).toHaveCount(0);

    await app.getByRole("button", { name: "Start focus timer" }).click();
    await expect(app.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await expect(hiddenListRow).toHaveCount(1);

    await app.getByRole("button", { name: "Stop focus timer" }).click();
    await expect(app.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    await expect(hiddenListRow).toHaveCount(0);
  }
);

// Opening the sidebar mid-session is an explicit decision, so the session stops
// driving it — ending must not yank the panels away again.

appTest(
  "reopening the sidebar mid-session survives the session ending",
  { tag: ["@EDIT-21"] },
  async ({ app }) => {
    await quickAdd(app, "Deep work");
    await openEditorForPage(app, "Deep work");

    await app.getByRole("button", { name: "Start focus timer" }).click();
    await app.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(app.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();

    await app.getByRole("button", { name: "Stop focus timer" }).click();
    await expect(app.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  }
);

/** One second over the 30 s below which a session is discarded unrecorded. */
const PAST_THE_RECORDING_FLOOR_MS = 31_000;

appTest(
  "a relaunch mid-session brings back the panels as you had them, and records nothing",
  { tag: ["@EDIT-23"] },
  async ({ app, storage }) => {
    appTest.skip(
      storage !== "bridge",
      "EDIT-23 reloads, and the mock keeps nothing across a reload"
    );
    // The real writer can't run on a pinned clock, so passing the floor takes real time.
    appTest.slow();
    await quickAdd(app, "Deep work");
    await openEditorForPage(app, "Deep work");
    const relaunchMidSession = async (ranForMs: number) => {
      await app.getByRole("button", { name: "Start focus timer" }).click();
      await app.waitForTimeout(ranForMs);
      await app.reload();
      await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();
    };

    await appTest.step("EDIT-23 an open sidebar comes back open", async () => {
      await relaunchMidSession(PAST_THE_RECORDING_FLOOR_MS);
      await expect(app.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    });

    await appTest.step("EDIT-23 a collapsed sidebar stays collapsed", async () => {
      await app.keyboard.press(mod("Mod+\\"));
      await expect(app.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
      await relaunchMidSession(0);
      await expect(app.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    });

    await appTest.step("EDIT-23 neither session was recorded", async () => {
      await app.getByRole("button", { name: "Expand sidebar" }).click();
      await app.getByRole("button", { name: "Open settings" }).click();
      const settings = app.getByRole("region", { name: "Settings" });
      await settings.getByRole("button", { exact: true, name: "Data" }).click();
      await expect(settings.getByRole("group", { name: "Focus: not used" })).toBeVisible();
    });
  }
);

// Ending a session is otherwise invisible — the row lands in a settings panel the
// user isn't looking at — so both outcomes toast. The strings are unit-pinned in
// useFocusTimer.test.ts; what nothing covered is that they reach the screen.
//
// A recorded session has to outrun the 30s discard floor, so the length arm runs
// on the raw `page` fixture: clock.install must land before the first app script
// reads Date.

appTest("stopping a focus session toasts how long it ran @mock-only", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-06-08T09:00:00") });
  await page.clock.resume();
  await page.goto("/");
  await expect(page.getByRole("main", { name: "Workspace" })).toBeVisible();

  await quickAdd(page, "Deep work");
  await openEditorForPage(page, "Deep work");

  await page.getByRole("button", { name: "Start focus timer" }).click();
  await page.clock.setFixedTime(new Date("2026-06-08T09:25:00"));
  await page.getByRole("button", { name: "Stop focus timer" }).click();

  await expect(page.getByRole("status", { name: "Focused for 25 minutes" })).toBeVisible();
});

appTest(
  "a session under the floor toasts that nothing was recorded",
  { tag: ["@EDIT-20:4"] },
  async ({ app }) => {
    await quickAdd(app, "Quick glance");
    await openEditorForPage(app, "Quick glance");

    await app.getByRole("button", { name: "Start focus timer" }).click();
    await app.getByRole("button", { name: "Stop focus timer" }).click();

    await expect(
      app.getByRole("status", { name: "Under 30 seconds — not recorded" })
    ).toBeVisible();
  }
);

// ─── tier2: Cmd+Shift+K belongs to whichever meaning fits ────────────────────

// The editor's insert-link and the command palette both claim it. The editor's is
// scoped, so it used to win outright and the palette could not be opened from the
// one place you most want it. It now only claims the combo with a selection —
// which is what a link is made out of — and the registry falls through otherwise.
appTest(
  "Cmd+Shift+K makes a link from a selection, opens the palette without one",
  async ({ app }) => {
    await quickAdd(app, "a page to write in");
    await app.locator("[data-page-list-item]").filter({ hasText: "a page to write in" }).click();

    const body = app.getByRole("textbox", { name: "Page content" });
    await body.click();
    await app.keyboard.type("link this phrase");

    // No selection: the editor stands down and the palette opens.
    await app.keyboard.press(mod("Mod+Shift+k"));
    const palette = app.getByRole("dialog", { name: "Search pages" });
    await expect(palette).toBeVisible();
    await app.keyboard.press("Escape");
    await expect(palette).not.toBeVisible();

    // With a selection the editor takes it and the palette stays shut.
    await body.click();
    await app.keyboard.press(mod("Mod+a"));
    await app.keyboard.press(mod("Mod+Shift+k"));
    await expect(palette).not.toBeVisible();
  }
);

// ─── Lists loaded a window at a time ────────────────────────────────────────

appTest.describe("with lists loaded a window at a time", () => {
  appTest.use({ tightCache: true });

  appTest("typing in a page saves it without fetching the list again", async ({ app }) => {
    await quickAdd(app, "Meeting notes");
    await app.locator("[data-page-list-item]").filter({ hasText: "Meeting notes" }).click();
    const body = app.getByRole("textbox", { name: "Page content" });
    await body.click();
    await app.waitForTimeout(WRITE_QUEUE_DEBOUNCE_MS * 2);
    const fetches = () =>
      app.evaluate(
        () => (globalThis as { __PIKOS_LIST_FETCHES__?: number }).__PIKOS_LIST_FETCHES__ ?? 0
      );
    const before = await fetches();

    await app.keyboard.type("Agenda: budget, hiring, offsite.");
    await app.waitForTimeout(WRITE_QUEUE_DEBOUNCE_MS * 3);
    await app.keyboard.type(" Decisions to follow.");
    await app.waitForTimeout(WRITE_QUEUE_DEBOUNCE_MS * 3);

    expect(await fetches()).toBe(before);
  });
});

appTest.describe("with pages read ahead on hover", () => {
  appTest.use({ tightCache: true });

  appTest(
    "a page hovered before it's clicked opens from the read the hover started",
    async ({ app }) => {
      await quickAdd(app, "First page");
      await quickAdd(app, "Second page");
      const reads = () =>
        app.evaluate(
          () =>
            (globalThis as { __PIKOS_BODY_READS__?: { hits: number; misses: number } })
              .__PIKOS_BODY_READS__ ?? { hits: 0, misses: 0 }
        );
      const row = app.locator("[data-page-list-item]").filter({ hasText: "Second page" });
      const before = await reads();

      await row.hover();
      await app.waitForTimeout(300);
      await row.click();
      await expect(app.getByRole("textbox", { name: "Page content" })).toBeVisible();

      const after = await reads();
      expect(after.hits).toBeGreaterThan(before.hits);
      expect(after.misses).toBe(before.misses);
    }
  );
});
