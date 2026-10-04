import type { Locator, Page } from "@playwright/test";

import {
  test as appTest,
  expect,
  mod,
  openEditorForPage,
  quickAdd,
  WRITE_QUEUE_DEBOUNCE_MS,
} from "./fixtures";

/** Empty the body back to one blank paragraph, so each block starts clean. */
async function clearBody(app: Page) {
  await app.keyboard.press(mod("Mod+a"));
  await app.keyboard.press("Backspace");
}

function listItem(scope: Locator, text: string) {
  return scope.getByRole("listitem").filter({ hasText: text }).last();
}

appTest(
  "pages are created, renamed and opened in the one editor",
  { tag: ["@EDIT-01"] },
  async ({ app }) => {
    await quickAdd(app, "First draft");
    await quickAdd(app, "Second draft");
    const list = app.locator("[data-page-list-item]");
    const body = app.getByRole("textbox", { name: "Page content" });

    await appTest.step("EDIT-01 a renamed page shows its new title in the list", async () => {
      await openEditorForPage(app, "First draft");
      await app.keyboard.type("words from the first page");
      await app.getByLabel("Page title").click();
      await expect(app.getByRole("textbox", { name: "Page title" })).toBeFocused();
      await app.keyboard.press(mod("Mod+a"));
      await app.keyboard.type("Opening chapter");
      await app.keyboard.press("Enter");
      await expect(list.filter({ hasText: "Opening chapter" })).toHaveCount(1);
      await expect(list.filter({ hasText: "First draft" })).toHaveCount(0);
    });

    await appTest.step("EDIT-01 opening another page replaces the editor, with no tabs", async () => {
      await list.filter({ hasText: "Second draft" }).click();
      await expect(app.getByLabel("Page title")).toHaveText("Second draft");
      await expect(body).not.toContainText("words from the first page");
      await expect(body).toHaveCount(1);
      await expect(app.getByRole("tab")).toHaveCount(0);

      await list.filter({ hasText: "Opening chapter" }).click();
      await expect(body).toContainText("words from the first page");
    });
  }
);

appTest(
  "Markdown typed into the body formats as it is typed",
  { tag: ["@EDIT-02"] },
  async ({ app }) => {
    await quickAdd(app, "Typed notes");
    const body = await openEditorForPage(app, "Typed notes");

    await appTest.step("EDIT-02 #, ## and ### make headings", async () => {
      for (const level of [1, 2, 3]) {
        await app.keyboard.type(`${"#".repeat(level)} Level ${level}`);
        await app.keyboard.press("Enter");
        await expect(body.getByRole("heading", { level, name: `Level ${level}` })).toBeVisible();
      }
    });

    await appTest.step("EDIT-02 **bold** and *italic* format inline", async () => {
      await app.keyboard.type("Some **loud** and *soft* words");
      await expect(body.getByRole("strong")).toHaveText("loud");
      await expect(body.getByRole("emphasis")).toHaveText("soft");
      await app.keyboard.press("Enter");
    });

    await appTest.step("EDIT-02 [ ] makes a checklist item", async () => {
      await app.keyboard.type("[ ] Buy stamps");
      await expect(body.getByRole("checkbox")).toHaveCount(1);
      await expect(listItem(body, "Buy stamps")).toBeVisible();
      await app.keyboard.press("Enter");
      await app.keyboard.press("Enter");
    });

    await appTest.step("EDIT-02 > makes a blockquote", async () => {
      await app.keyboard.type("> Quoted line");
      await expect(body.getByRole("blockquote")).toHaveText("Quoted line");
      await app.keyboard.press("Enter");
      await app.keyboard.press("Enter");
    });

    await appTest.step("EDIT-02 ``` makes a code block", async () => {
      await app.keyboard.type("``` ");
      await app.keyboard.type("let x = 1");
      await expect(body.getByRole("code")).toHaveText("let x = 1");
      await expect(body.getByRole("blockquote")).not.toContainText("let x");
    });
  }
);

appTest(
  "the slash menu inserts every block type, and Escape inserts nothing",
  { tag: ["@EDIT-03"] },
  async ({ app }) => {
    await quickAdd(app, "Block sampler");
    const body = await openEditorForPage(app, "Block sampler");
    const menu = app.getByRole("listbox", { name: "Slash commands" });

    async function insert(title: string) {
      await clearBody(app);
      await app.keyboard.type("/");
      await expect(menu).toBeVisible();
      await menu.getByRole("option", { name: new RegExp(`^\\S+ ${title} `) }).click();
      await expect(menu).not.toBeVisible();
    }

    await appTest.step("EDIT-03 headings 1 to 3", async () => {
      for (const level of [1, 2, 3]) {
        await insert(`Heading ${level}`);
        await app.keyboard.type("Heading text");
        await expect(body.getByRole("heading", { level })).toHaveText("Heading text");
      }
    });

    await appTest.step("EDIT-03 bullet, ordered and task lists", async () => {
      await insert("Bullet List");
      await app.keyboard.type("A bullet");
      await expect(body.locator("ul:not([data-type])")).toContainText("A bullet");
      await insert("Ordered List");
      await app.keyboard.type("A step");
      await expect(body.locator("ol")).toContainText("A step");
      await insert("Task List");
      await app.keyboard.type("A task");
      await expect(body.getByRole("checkbox")).toHaveCount(1);
    });

    await appTest.step("EDIT-03 code block, blockquote, rule and table", async () => {
      await insert("Code Block");
      await app.keyboard.type("run()");
      await expect(body.getByRole("code")).toHaveText("run()");
      await insert("Blockquote");
      await app.keyboard.type("Said once");
      await expect(body.getByRole("blockquote")).toHaveText("Said once");
      await insert("Horizontal Rule");
      await expect(body.getByRole("separator")).toHaveCount(1);
      await insert("Table");
      await expect(body.getByRole("table")).toBeVisible();
      await expect(body.getByRole("columnheader")).toHaveCount(3);
    });

    await appTest.step("EDIT-03 Image is offered (its file picker is EDIT-15's)", async () => {
      await clearBody(app);
      await app.keyboard.type("/");
      await expect(menu.getByRole("option", { name: /^\S+ Image / })).toBeVisible();
      await app.keyboard.press("Escape");
    });

    await appTest.step("EDIT-03 Escape closes the menu and inserts nothing", async () => {
      await clearBody(app);
      await app.keyboard.type("/");
      await expect(menu).toBeVisible();
      await app.keyboard.press("Escape");
      await expect(menu).not.toBeVisible();
      await expect(body).toHaveText("/");
      for (const role of ["heading", "list", "table", "separator", "blockquote", "code"] as const) {
        await expect(body.getByRole(role)).toHaveCount(0);
      }
    });
  }
);

appTest(
  "each format toolbar button applies its format to the selection",
  { tag: ["@EDIT-04"] },
  async ({ app }) => {
    await quickAdd(app, "Formatting");
    const body = await openEditorForPage(app, "Formatting");
    const toolbar = app.getByRole("toolbar", { name: "Format" });

    async function formatWith(button: string) {
      await clearBody(app);
      await app.keyboard.type("styled");
      await app.keyboard.press("Shift+Home");
      await toolbar.getByRole("button", { exact: true, name: button }).click();
    }

    await appTest.step("EDIT-04 bold, italic, underline, strikethrough, inline code", async () => {
      await formatWith("Bold");
      await expect(body.getByRole("strong")).toHaveText("styled");
      await formatWith("Italic");
      await expect(body.getByRole("emphasis")).toHaveText("styled");
      await formatWith("Underline");
      await expect(body.locator("u")).toHaveText("styled");
      await formatWith("Strikethrough");
      await expect(body.locator("s")).toHaveText("styled");
      await formatWith("Inline code");
      await expect(body.getByRole("code")).toHaveText("styled");
    });

    await appTest.step("EDIT-04 headings 1 to 3", async () => {
      for (const level of [1, 2, 3]) {
        await formatWith(`Heading ${level}`);
        await expect(body.getByRole("heading", { level })).toHaveText("styled");
      }
    });

    await appTest.step("EDIT-04 bullet and ordered lists", async () => {
      await formatWith("Bullet list");
      await expect(body.locator("ul")).toHaveText("styled");
      await formatWith("Ordered list");
      await expect(body.locator("ol")).toHaveText("styled");
    });

    await appTest.step("EDIT-04 link", async () => {
      await formatWith("Link");
      await app.getByPlaceholder("Paste or type a URL…").fill("https://pikos.app");
      await app.keyboard.press("Enter");
      await expect(body.getByRole("link", { name: "styled" })).toHaveAttribute(
        "href",
        "https://pikos.app"
      );
    });
  }
);

appTest("pasted Markdown converts to formatted content", { tag: ["@EDIT-05"] }, async ({ app }) => {
  await quickAdd(app, "Pasted notes");
  const body = await openEditorForPage(app, "Pasted notes");

  await appTest.step("EDIT-05 a paste carrying Markdown and HTML formats", async () => {
    const markdown = "## Plan\n\n- **first** step\n- second step\n\n> keep it small";
    // Browsers and editors attach an HTML copy too; the Markdown must still win.
    await body.evaluate((el, text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      data.setData("text/html", `<pre>${text}</pre>`);
      el.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })
      );
    }, markdown);

    await expect(body.getByRole("heading", { level: 2 })).toHaveText("Plan");
    await expect(body.getByRole("listitem")).toHaveCount(2);
    await expect(body.getByRole("strong")).toHaveText("first");
    await expect(body.getByRole("blockquote")).toHaveText("keep it small");
    await expect(body).not.toContainText("##");
  });
});

appTest(
  "Tab and Shift+Tab indent and outdent list and task list items",
  { tag: ["@EDIT-07"] },
  async ({ app }) => {
    await quickAdd(app, "Outline");
    const body = await openEditorForPage(app, "Outline");

    for (const [kind, marker] of [
      ["list", "- "],
      ["task list", "[ ] "],
    ] as const) {
      await appTest.step(`EDIT-07 Tab nests a ${kind} item and Shift+Tab lifts it`, async () => {
        await clearBody(app);
        await app.keyboard.type(`${marker}Parent`);
        await app.keyboard.press("Enter");
        await app.keyboard.type("Child");
        const parent = listItem(body, "Parent");

        await app.keyboard.press("Tab");
        await expect(parent.getByRole("list")).toContainText("Child");

        await app.keyboard.press("Shift+Tab");
        await expect(parent.getByRole("list")).toHaveCount(0);
        await expect(body.getByRole("listitem")).toHaveCount(2);
      });
    }
  }
);

appTest(
  "the word count opens the page's counts and dates",
  { tag: ["@EDIT-11"] },
  async ({ app }) => {
    await quickAdd(app, "Field report");
    await openEditorForPage(app, "Field report");
    await app.keyboard.type("Alpha beta gamma");
    await app.keyboard.press("Enter");
    await app.keyboard.type("delta");
    await app.getByRole("button", { name: "Mark done" }).click();
    await expect(app.getByRole("button", { name: "Mark not done" })).toBeVisible();

    const info = app.getByRole("button", { name: "Page info" });
    const popover = app.getByRole("dialog");

    await appTest.step("EDIT-11 the word count opens the popover", async () => {
      await expect(info).toHaveText("4 words");
      await info.click();
      await expect(popover).toBeVisible();
    });

    await appTest.step("EDIT-11 it shows words, characters, paragraphs and reading time", async () => {
      await expect(popover).toContainText(/Words\s*4/);
      await expect(popover).toContainText(/Characters\s*22/);
      await expect(popover).toContainText(/Paragraphs\s*2/);
      await expect(popover).toContainText(/Reading time\s*< 1 min/);
    });

    await appTest.step("EDIT-11 it shows the created, updated and completed dates", async () => {
      for (const label of ["Created", "Updated", "Completed"]) {
        await expect(popover).toContainText(new RegExp(`${label}\\s*less than a minute ago`));
      }
    });
  }
);

appTest(
  "typed content persists across a page switch and a relaunch",
  { tag: ["@EDIT-12"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "EDIT-12 reloads, and the mock keeps nothing across a reload");
    await quickAdd(app, "Journal");
    await quickAdd(app, "Elsewhere");
    const body = await openEditorForPage(app, "Journal");
    const list = app.locator("[data-page-list-item]");

    await app.keyboard.type("Rained all morning");
    await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);

    await appTest.step("EDIT-12 the content is there after switching away and back", async () => {
      await list.filter({ hasText: "Elsewhere" }).click();
      await expect(body).not.toContainText("Rained all morning");
      await list.filter({ hasText: "Journal" }).click();
      await expect(body).toHaveText("Rained all morning");
    });

    await appTest.step("EDIT-12 the content is there after a relaunch", async () => {
      await app.reload();
      await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();
      await list.filter({ hasText: "Journal" }).click();
      await expect(body).toHaveText("Rained all morning");
    });
  }
);

appTest(
  "Cmd+Shift+K links a selection, and opens the palette with none",
  { tag: ["@EDIT-08"] },
  async ({ app }) => {
    await quickAdd(app, "Reading notes");
    const body = await openEditorForPage(app, "Reading notes");
    await app.keyboard.type("Pikos is local-first");
    const palette = app.getByRole("dialog", { name: "Search pages" });

    await appTest.step("EDIT-08 with no selection the command palette opens", async () => {
      await app.keyboard.press(mod("Mod+Shift+k"));
      await expect(palette).toBeVisible();
      await app.keyboard.press("Escape");
      await expect(palette).not.toBeVisible();
    });

    await appTest.step("EDIT-08 with a selection a link is made", async () => {
      await body.click();
      await app.keyboard.press(mod("Mod+a"));
      await app.keyboard.press(mod("Mod+Shift+k"));
      await expect(palette).not.toBeVisible();
      await app.getByPlaceholder("Paste or type a URL…").fill("https://pikos.app");
      await app.keyboard.press("Enter");
      await expect(body.getByRole("link", { name: "Pikos is local-first" })).toBeVisible();
    });
  }
);
