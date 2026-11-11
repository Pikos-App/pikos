import { execFileSync } from "node:child_process";

import type { Locator, Page } from "@playwright/test";

import {
  test as appTest,
  bridgeCall,
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

appTest(
  "typing [[ links an existing page picked by its title, and never makes one",
  { tag: ["@EDIT-25"] },
  async ({ app }) => {
    for (const title of ["Garden plans", "Garage sale", "Reading list", "Hub"]) {
      await quickAdd(app, title);
    }
    const body = await openEditorForPage(app, "Hub");
    const picker = app.getByRole("listbox", { name: "Link to page" });
    const link = (title: string) => body.getByRole("button", { exact: true, name: title });
    const rows = app.locator("[data-page-list-item]");

    await appTest.step("EDIT-25 the picker lists only the pages whose titles match", async () => {
      await app.keyboard.type("[[Gar");
      await expect(picker.getByRole("option")).toHaveCount(2);
      for (const title of ["Garden plans", "Garage sale"]) {
        await expect(picker.getByRole("option", { name: title })).toBeVisible();
      }
    });

    await appTest.step("EDIT-25 with no match it says so and makes nothing", async () => {
      await app.keyboard.type("xyz");
      await expect(app.getByRole("status").filter({ hasText: "No pages match" })).toBeVisible();
      await app.keyboard.press("Enter");
      await expect(rows).toHaveCount(4);
      await expect(body.getByRole("button")).toHaveCount(0);
      await clearBody(app);
    });

    await appTest.step("EDIT-25 Escape closes the picker", async () => {
      await app.keyboard.type("[[Rea");
      await expect(picker).toBeVisible();
      await app.keyboard.press("Escape");
      await expect(picker).toHaveCount(0);
      await expect(body.getByRole("button")).toHaveCount(0);
      await clearBody(app);
    });

    await appTest.step("EDIT-25 Enter inserts the link", async () => {
      await app.keyboard.type("[[Garden");
      await expect(picker.getByRole("option")).toHaveCount(1);
      await app.keyboard.press("Enter");
      await expect(picker).toHaveCount(0);
      await expect(link("Garden plans")).toBeVisible();
    });

    await appTest.step("EDIT-25 a click inserts the link", async () => {
      await app.keyboard.type("and [[Read");
      await picker.getByRole("option", { name: "Reading list" }).click();
      await expect(link("Reading list")).toBeVisible();
    });

    await appTest.step("EDIT-25 [[ in a code block opens nothing", async () => {
      await app.keyboard.press("Enter");
      await app.keyboard.type("``` ");
      await app.keyboard.type("[[Gar");
      await expect(body.getByRole("code")).toContainText("[[Gar");
      await expect(picker).toHaveCount(0);
      await expect(app.getByText("No pages match")).toHaveCount(0);
    });

    await appTest.step("EDIT-25 clicking the link opens that page", async () => {
      await link("Garden plans").click();
      await expect(app.getByLabel("Page title")).toHaveText("Garden plans");
    });
  }
);

appTest(
  "a renamed page's links show its new title, and its byline counts and lists the pages linking here",
  { tag: ["@EDIT-26"] },
  async ({ app }) => {
    await quickAdd(app, "Plans");
    await quickAdd(app, "Garden journal");
    const body = await openEditorForPage(app, "Garden journal");
    await app.keyboard.type("See [[Plans");
    await expect(app.getByRole("listbox", { name: "Link to page" })).toBeVisible();
    await app.keyboard.press("Enter");
    const link = (title: string) => body.getByRole("button", { exact: true, name: title });
    await expect(link("Plans")).toBeVisible();
    await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);
    const items = app.locator("[data-page-list-item]");
    const backlinks = app.getByRole("button", { name: "Linked from 1 page" });

    await appTest.step("EDIT-26 the link shows the new title at once and still opens it", async () => {
      await items.filter({ hasText: "Plans" }).click();
      await app.getByLabel("Page title").click();
      await app.keyboard.press(mod("Mod+a"));
      await app.keyboard.type("Plans for spring");
      await app.keyboard.press("Enter");
      await items.filter({ hasText: "Garden journal" }).click();
      await expect(link("Plans for spring")).toBeVisible();
      await link("Plans for spring").click();
      await expect(app.getByLabel("Page title")).toHaveText("Plans for spring");
    });

    await appTest.step("EDIT-26 the byline shows the count after the tags", async () => {
      await expect(backlinks).toHaveText("1");
      const tags = await app.getByRole("button", { name: /^Tags: / }).boundingBox();
      const count = await backlinks.boundingBox();
      expect(count!.x).toBeGreaterThan(tags!.x + tags!.width);
    });

    await appTest.step("EDIT-26 it lists the linking pages and opens one", async () => {
      await backlinks.click();
      await app.getByRole("menuitem", { name: "Garden journal" }).click();
      await expect(app.getByLabel("Page title")).toHaveText("Garden journal");
    });

    await appTest.step("EDIT-26 it is absent when nothing links to the page", async () => {
      await expect(app.getByRole("button", { name: /^Linked from / })).toHaveCount(0);
    });
  }
);

/** The distinct text colours inside a code block: one when nothing is coloured. */
function codeColours(code: Locator) {
  return code.evaluate((el) => {
    const colours = new Set<string>();
    for (const node of [el, ...Array.from(el.querySelectorAll("*"))]) {
      const hasOwnText = Array.from(node.childNodes).some(
        (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim()
      );
      if (hasOwnText) colours.add(getComputedStyle(node).color);
    }
    return colours.size;
  });
}

async function paste(body: Locator, text: string) {
  await body.evaluate((el, plain) => {
    const data = new DataTransfer();
    data.setData("text/plain", plain);
    el.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })
    );
  }, text);
}

const PYTHON = [
  "def greet(name):",
  '    print(f"Hello, {name}")',
  "    return None",
  "",
  "class Greeter:",
  "    def __init__(self):",
  "        self.count = 0",
].join("\n");

appTest(
  "a code block is coloured by the language picked or guessed on paste",
  { tag: ["@EDIT-27"] },
  async ({ app }) => {
    await quickAdd(app, "Snippets");
    const body = await openEditorForPage(app, "Snippets");
    const code = body.getByRole("code");
    const language = body.getByRole("combobox", { name: "Code language" });

    await appTest.step("EDIT-27 a language picked colours the code; Plain text doesn't", async () => {
      await app.keyboard.type("``` ");
      await app.keyboard.type("def greet(name): return None");
      await expect(language).toHaveValue("");
      expect(await codeColours(code)).toBe(1);
      await language.selectOption({ label: "Python" });
      await expect.poll(() => codeColours(code)).toBeGreaterThan(1);
      await language.selectOption({ label: "Plain text" });
      await expect.poll(() => codeColours(code)).toBe(1);
    });

    await appTest.step("EDIT-27 code pasted into an unlabeled block gets a guessed language", async () => {
      await clearBody(app);
      await app.keyboard.type("``` ");
      await expect(language).toHaveValue("");
      await paste(body, PYTHON);
      await expect(language).toHaveValue("python");
      await expect.poll(() => codeColours(code)).toBeGreaterThan(1);
    });

    await appTest.step("EDIT-27 an untagged fenced block pasted gets one too, and it can be changed", async () => {
      await clearBody(app);
      await paste(body, "```\n" + PYTHON + "\n```");
      await expect(language).toHaveValue("python");
      await language.selectOption({ label: "Ruby" });
      await expect(language).toHaveValue("ruby");
    });
  }
);

appTest(
  "a failed save shows Not saved beside the word count, says why, and retries on a click",
  { tag: ["@EDIT-28"] },
  async ({ app, storage }) => {
    appTest.skip(storage !== "bridge", "EDIT-28 fails a write in the real writer's database");
    await quickAdd(app, "Ledger");
    const body = await openEditorForPage(app, "Ledger");
    const notSaved = app.getByRole("button", { name: "Save failed. Click to retry" });
    const byline = app.getByRole("button", { name: /^Tags: / });
    const db = await bridgeCall<string>(app, "bridge_workspace_path");
    const sql = (statement: string) =>
      execFileSync("sqlite3", ["-cmd", ".timeout 5000", db, statement]);

    await appTest.step("EDIT-28 an ordinary autosave shows nothing", async () => {
      await app.keyboard.type("first line");
      await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);
      await expect(notSaved).toHaveCount(0);
    });

    const before = await byline.boundingBox();
    sql(
      "CREATE TRIGGER refuse_writes BEFORE UPDATE ON pages BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;"
    );

    await appTest.step("EDIT-28 a failed save shows Not saved beside the word count", async () => {
      await app.keyboard.type(" and a second");
      await expect(notSaved).toHaveText("Not saved");
      const info = await app.getByRole("button", { name: "Page info" }).boundingBox();
      const status = await notSaved.boundingBox();
      expect(Math.abs(status!.y + status!.height / 2 - (info!.y + info!.height / 2))).toBeLessThan(4);
      expect(status!.x + status!.width).toBeLessThanOrEqual(info!.x);
    });

    await appTest.step("EDIT-28 nothing in the properties row moves", async () => {
      expect(await byline.boundingBox()).toEqual(before);
    });

    await appTest.step("EDIT-28 its tooltip says why", async () => {
      await notSaved.hover();
      await expect(app.getByRole("tooltip")).toContainText(/^Storage error while saving/);
    });

    await appTest.step("EDIT-28 clicking it retries, and the text is kept", async () => {
      sql("DROP TRIGGER refuse_writes;");
      await notSaved.click();
      await expect(notSaved).toHaveCount(0);
      await app.waitForTimeout(2 * WRITE_QUEUE_DEBOUNCE_MS);
      await app.reload();
      await expect(app.getByRole("main", { name: "Workspace" })).toBeVisible();
      await app.locator("[data-page-list-item]").filter({ hasText: "Ledger" }).click();
      await expect(body).toHaveText("first line and a second");
    });
  }
);
