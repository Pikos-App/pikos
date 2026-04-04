import { describe, expect, it } from "vitest";

import { extractWikilinks, parseFrontmatter, parseMarkdownVault, type VaultFile } from "./markdown";

// ─── parseFrontmatter ─────────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  it("returns body unchanged when no frontmatter", () => {
    const { body, frontmatter } = parseFrontmatter("# Hello\nWorld");
    expect(body).toBe("# Hello\nWorld");
    expect(frontmatter.status).toBe("not_started");
    expect(frontmatter.tags).toEqual([]);
  });

  it("parses basic frontmatter fields", () => {
    const raw = `---
status: done
priority: 2
due: 2025-06-15
created: "2025-01-01"
---

# My Note`;

    const { body, frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.status).toBe("done");
    expect(frontmatter.priority).toBe(2);
    expect(frontmatter.scheduled).toBe("2025-06-15");
    expect(frontmatter.created).toBe("2025-01-01");
    expect(body).toBe("\n# My Note");
  });

  it("parses inline tags array", () => {
    const raw = `---
tags: [work, urgent, "project-x"]
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.tags).toEqual(["work", "urgent", "project-x"]);
  });

  it("parses comma-separated tags", () => {
    const raw = `---
tags: work, personal
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.tags).toEqual(["work", "personal"]);
  });

  it("parses multi-line YAML list tags", () => {
    const raw = `---
tags:
  - "alpha"
  - beta
  - gamma
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.tags).toEqual(["alpha", "beta", "gamma"]);
  });

  it("maps text priority values", () => {
    const raw = `---
priority: urgent
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.priority).toBe(1);
  });

  it("handles completed/x status aliases", () => {
    expect(parseFrontmatter("---\nstatus: completed\n---\n").frontmatter.status).toBe("done");
    expect(parseFrontmatter("---\nstatus: x\n---\n").frontmatter.status).toBe("done");
  });

  it("leaves status as not_started for unrecognized values", () => {
    expect(parseFrontmatter("---\nstatus: in_progress\n---\n").frontmatter.status).toBe(
      "not_started"
    );
  });

  it("parses scheduled_start field (Pikos export format)", () => {
    const raw = `---
scheduled_start: "2025-03-15T09:00:00"
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.scheduled).toBe("2025-03-15");
  });

  it("parses scheduled field as date-only", () => {
    const raw = `---
scheduled: 2025-12-25
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.scheduled).toBe("2025-12-25");
  });

  it("parses created_at alias for created date", () => {
    const raw = `---
created_at: 2025-01-15
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.created).toBe("2025-01-15");
  });

  it("parses date created alias for created date", () => {
    const raw = `---
date created: "2025-03-10"
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.created).toBe("2025-03-10");
  });

  it("parses modified field", () => {
    const raw = `---
modified: 2025-06-01
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.modified).toBe("2025-06-01");
  });

  it("parses date modified alias", () => {
    const raw = `---
date modified: "2025-06-01"
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.modified).toBe("2025-06-01");
  });

  it("parses updated alias for modified date", () => {
    const raw = `---
updated: 2025-07-01
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.modified).toBe("2025-07-01");
  });

  it("parses updated_at alias for modified date", () => {
    const raw = `---
updated_at: 2025-08-01
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.modified).toBe("2025-08-01");
  });

  it("parses Obsidian Linter date format", () => {
    const raw = `---
created: "Monday, March 17th 2025, 11:03:04 am"
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.created).toBe("2025-03-17T11:03:04");
  });

  it("parses ISO datetime with time", () => {
    const raw = `---
created: "2025-06-15T14:30:00"
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    // ISO format passes through directly
    expect(frontmatter.created).toBe("2025-06-15T14:30:00");
  });

  it("ignores numeric priority outside 1-4 range", () => {
    expect(parseFrontmatter("---\npriority: 0\n---\n").frontmatter.priority).toBe(0);
    expect(parseFrontmatter("---\npriority: 5\n---\n").frontmatter.priority).toBe(0);
    expect(parseFrontmatter("---\npriority: -1\n---\n").frontmatter.priority).toBe(0);
  });

  it("maps all text priority labels", () => {
    expect(parseFrontmatter("---\npriority: high\n---\n").frontmatter.priority).toBe(2);
    expect(parseFrontmatter("---\npriority: medium\n---\n").frontmatter.priority).toBe(3);
    expect(parseFrontmatter("---\npriority: low\n---\n").frontmatter.priority).toBe(4);
  });

  it("ignores unrecognized priority label", () => {
    expect(parseFrontmatter("---\npriority: critical\n---\n").frontmatter.priority).toBe(0);
  });

  it("skips frontmatter comment lines", () => {
    const raw = `---
# This is a comment
status: done
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.status).toBe("done");
  });

  it("handles empty tags value with YAML list", () => {
    const raw = `---
tags:
  - alpha
  - beta
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.tags).toEqual(["alpha", "beta"]);
  });
});

// ─── extractWikilinks ─────────────────────────────────────────────────────────

describe("extractWikilinks", () => {
  it("extracts simple wikilinks", () => {
    expect(extractWikilinks("See [[My Page]] and [[Other]]")).toEqual(["My Page", "Other"]);
  });

  it("extracts aliased wikilinks (takes target, not display)", () => {
    expect(extractWikilinks("See [[Target|Display Text]]")).toEqual(["Target"]);
  });

  it("deduplicates links", () => {
    expect(extractWikilinks("[[A]] and [[A]] again")).toEqual(["A"]);
  });

  it("returns empty for no links", () => {
    expect(extractWikilinks("No links here")).toEqual([]);
  });
});

// ─── parseMarkdownVault ───────────────────────────────────────────────────────

describe("parseMarkdownVault", () => {
  it("parses a simple vault with folders", () => {
    const files: VaultFile[] = [
      { content: "# Hello\nContent here", path: "Work/note1.md" },
      { content: "# World\nMore content", path: "Work/note2.md" },
      { content: "# Personal note", path: "Personal/diary.md" },
    ];

    const plan = parseMarkdownVault(files);
    expect(plan.source).toBe("markdown");
    expect(plan.pages).toHaveLength(3);
    expect(plan.folders).toHaveLength(2);

    expect(plan.folders.map((f) => f.name).sort()).toEqual(["Personal", "Work"]);
    expect(plan.pages[0]!.title).toBe("note1");
    expect(plan.pages[0]!.folderKey).toBe("Work");
  });

  it("flattens nested directories", () => {
    const files: VaultFile[] = [
      { content: "content", path: "Projects/Work/ClientA/task.md" },
      { content: "content", path: "Projects/Personal/idea.md" },
    ];

    const plan = parseMarkdownVault(files);
    expect(plan.folders.map((f) => f.name).sort()).toEqual([
      "Projects / Personal",
      "Projects / Work / ClientA",
    ]);
  });

  it("puts root-level files in inbox (null folder)", () => {
    const files: VaultFile[] = [{ content: "inbox note", path: "quick-note.md" }];

    const plan = parseMarkdownVault(files);
    expect(plan.pages[0]!.folderKey).toBeNull();
    expect(plan.folders).toHaveLength(0);
  });

  it("extracts frontmatter into page fields", () => {
    const files: VaultFile[] = [
      {
        content: `---
tags: [important, work]
status: done
priority: 1
due: 2025-06-01
---
Task body`,
        path: "task.md",
      },
    ];

    const plan = parseMarkdownVault(files);
    const page = plan.pages[0]!;
    expect(page.tags).toEqual(["important", "work"]);
    expect(page.status).toBe("done");
    expect(page.priority).toBe(1);
    expect(page.scheduledStart).toBe("2025-06-01");
  });

  it("extracts wikilinks from body", () => {
    const files: VaultFile[] = [{ content: "See [[Other Page]] for details", path: "note.md" }];

    const plan = parseMarkdownVault(files);
    expect(plan.pages[0]!.wikilinks).toEqual(["Other Page"]);
  });

  it("warns about unsupported content", () => {
    const files: VaultFile[] = [
      { content: "![[image.png]]\n\n```mermaid\ngraph TD\n```", path: "fancy.md" },
    ];

    const plan = parseMarkdownVault(files);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]!.type).toBe("unsupported_content");
    expect(plan.warnings[0]!.message).toContain("embedded image");
    expect(plan.warnings[0]!.message).toContain("mermaid diagram");
  });

  it("warns about empty files", () => {
    const files: VaultFile[] = [{ content: "---\ntags: [a]\n---\n", path: "empty.md" }];

    const plan = parseMarkdownVault(files);
    expect(plan.warnings.some((w) => w.type === "empty_content")).toBe(true);
  });

  it("ignores non-.md files", () => {
    const files: VaultFile[] = [
      { content: "note content", path: "note.md" },
      { content: "{}", path: ".obsidian/config.json" },
      { content: "data", path: "image.png" },
    ];

    const plan = parseMarkdownVault(files);
    expect(plan.pages).toHaveLength(1);
  });

  it("warns about dataview queries", () => {
    const files: VaultFile[] = [
      { content: "```dataview\nTABLE file.name\nFROM #tag\n```", path: "query.md" },
    ];
    const plan = parseMarkdownVault(files);
    expect(plan.warnings.some((w) => w.message.includes("dataview query"))).toBe(true);
  });

  it("warns about callouts", () => {
    const files: VaultFile[] = [
      { content: "> [!warning] Be careful\n> Details here", path: "note.md" },
    ];
    const plan = parseMarkdownVault(files);
    expect(plan.warnings.some((w) => w.message.includes("callout"))).toBe(true);
  });

  it("adds folder flattening note to meta transformations", () => {
    const files: VaultFile[] = [{ content: "content", path: "A/B/note.md" }];
    const plan = parseMarkdownVault(files);
    expect(plan.meta.transformations.some((t) => t.includes("flattened"))).toBe(true);
  });

  it("adds wikilink count to meta transformations", () => {
    const files: VaultFile[] = [
      { content: "See [[Other]]", path: "note.md" },
      { content: "No links", path: "plain.md" },
    ];
    const plan = parseMarkdownVault(files);
    expect(plan.meta.transformations.some((t) => t.includes("Wikilinks in 1 pages"))).toBe(true);
  });

  it("sets updatedAt from modified frontmatter", () => {
    const files: VaultFile[] = [
      {
        content: `---
modified: 2025-09-01
---
Content`,
        path: "note.md",
      },
    ];
    const plan = parseMarkdownVault(files);
    expect(plan.pages[0]!.updatedAt).toBe("2025-09-01");
  });

  it("handles .MD extension (case-insensitive)", () => {
    const files: VaultFile[] = [{ content: "content", path: "NOTE.MD" }];
    const plan = parseMarkdownVault(files);
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]!.title).toBe("NOTE");
  });

  it("returns empty plan for no files", () => {
    const plan = parseMarkdownVault([]);
    expect(plan.pages).toHaveLength(0);
    expect(plan.folders).toHaveLength(0);
  });
});

// ─── End-to-end: Obsidian vault import ───────────────────────────────────────
// Simulates a realistic vault with nested folders, varied frontmatter, wikilinks,
// and unsupported content.

describe("end-to-end: Obsidian vault import", () => {
  const vaultFiles: VaultFile[] = [
    // Root file → inbox
    {
      content: `---
tags: [idea, quick]
created: 2025-01-15
---
Just a quick thought with a [[Reference Page]] link.`,
      path: "Quick Note.md",
    },
    // Nested folder
    {
      content: `---
status: done
priority: high
due: 2025-06-01
date created: "Monday, March 17th 2025, 11:03:04 am"
date modified: "Sunday, June 1st 2025, 1:04:44 pm"
tags:
  - work
  - reports
---
# Quarterly Report

The Q2 report covers all departments.
See [[Budget Sheet]] for numbers.`,
      path: "Projects/Work/Quarterly Report.md",
    },
    // Different folder, Obsidian Linter dates
    {
      content: `---
scheduled: 2025-04-01
priority: medium
created_at: 2025-02-10
updated_at: 2025-03-15
---
Morning routine:
- Stretching
- Running`,
      path: "Areas/Health/Exercise Plan.md",
    },
    // Empty content file
    {
      content: `---
tags: [todo]
---`,
      path: "Projects/Work/Empty Task.md",
    },
    // File with unsupported content
    {
      content: `---
created: 2025-05-01
---
Some text before.

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

And an embedded image: ![[screenshot.png]]`,
      path: "Areas/Research/Diagrams.md",
    },
    // Non-md file (should be filtered by vault reader, but parser also filters)
    {
      content: "binary data",
      path: "image.png",
    },
  ];

  const plan = parseMarkdownVault(vaultFiles);

  it("imports only .md files", () => {
    expect(plan.pages).toHaveLength(5);
  });

  it("derives titles from filenames", () => {
    const titles = plan.pages.map((p) => p.title).sort();
    expect(titles).toEqual([
      "Diagrams",
      "Empty Task",
      "Exercise Plan",
      "Quarterly Report",
      "Quick Note",
    ]);
  });

  it("assigns root files to inbox (null folderKey)", () => {
    const quickNote = plan.pages.find((p) => p.title === "Quick Note");
    expect(quickNote!.folderKey).toBeNull();
  });

  it("flattens nested folders with / separator", () => {
    const report = plan.pages.find((p) => p.title === "Quarterly Report");
    expect(report!.folderKey).toBe("Projects / Work");

    const exercise = plan.pages.find((p) => p.title === "Exercise Plan");
    expect(exercise!.folderKey).toBe("Areas / Health");
  });

  it("creates correct folder entries", () => {
    const folderNames = plan.folders.map((f) => f.name).sort();
    expect(folderNames).toEqual(["Areas / Health", "Areas / Research", "Projects / Work"]);
  });

  it("parses inline tag arrays", () => {
    const quickNote = plan.pages.find((p) => p.title === "Quick Note");
    expect(quickNote!.tags).toEqual(["idea", "quick"]);
  });

  it("parses YAML list tags", () => {
    const report = plan.pages.find((p) => p.title === "Quarterly Report");
    expect(report!.tags).toEqual(["work", "reports"]);
  });

  it("maps status and priority from frontmatter", () => {
    const report = plan.pages.find((p) => p.title === "Quarterly Report");
    expect(report!.status).toBe("done");
    expect(report!.priority).toBe(2); // high

    const exercise = plan.pages.find((p) => p.title === "Exercise Plan");
    expect(exercise!.status).toBe("not_started");
    expect(exercise!.priority).toBe(3); // medium
  });

  it("parses ISO dates for scheduled/created", () => {
    const exercise = plan.pages.find((p) => p.title === "Exercise Plan");
    expect(exercise!.scheduledStart).toBe("2025-04-01");
    expect(exercise!.createdAt).toBe("2025-02-10");
    expect(exercise!.updatedAt).toBe("2025-03-15");
  });

  it("parses Obsidian Linter date format", () => {
    const report = plan.pages.find((p) => p.title === "Quarterly Report");
    expect(report!.createdAt).toBe("2025-03-17T11:03:04");
    expect(report!.updatedAt).toBe("2025-06-01T13:04:44");
  });

  it("extracts wikilinks", () => {
    const quickNote = plan.pages.find((p) => p.title === "Quick Note");
    expect(quickNote!.wikilinks).toEqual(["Reference Page"]);

    const report = plan.pages.find((p) => p.title === "Quarterly Report");
    expect(report!.wikilinks).toEqual(["Budget Sheet"]);
  });

  it("warns about unsupported content", () => {
    const mermaidWarning = plan.warnings.find(
      (w) => w.source === "Areas/Research/Diagrams.md" && w.message.includes("mermaid")
    );
    expect(mermaidWarning).toBeTruthy();

    const imageWarning = plan.warnings.find(
      (w) => w.source === "Areas/Research/Diagrams.md" && w.message.includes("embedded image")
    );
    expect(imageWarning).toBeTruthy();
  });

  it("warns about empty content files", () => {
    const emptyWarning = plan.warnings.find(
      (w) => w.source === "Projects/Work/Empty Task.md" && w.message.includes("no content")
    );
    expect(emptyWarning).toBeTruthy();
  });

  it("includes folder flattening in meta transformations", () => {
    expect(plan.meta.transformations.some((t) => t.includes("flattened"))).toBe(true);
  });

  it("includes wikilink count in meta transformations", () => {
    expect(plan.meta.transformations.some((t) => t.includes("Wikilinks"))).toBe(true);
  });

  it("preserves markdown body content (stripped of frontmatter)", () => {
    const report = plan.pages.find((p) => p.title === "Quarterly Report");
    expect(report!.body).toContain("# Quarterly Report");
    expect(report!.body).not.toContain("status: done");
  });
});
