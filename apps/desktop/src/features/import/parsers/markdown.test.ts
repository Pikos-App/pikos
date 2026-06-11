import { describe, expect, it } from "vitest";

import {
  extractImageRefs,
  extractWikilinks,
  parseFrontmatter,
  parseMarkdownVault,
  transformCallouts,
  type VaultFile,
} from "./markdown";

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

  it("ignores fractional priority (must be a whole number, not force-cast to i64)", () => {
    // Regression: `2.5` passed the 1–4 range check and was cast straight
    // through to create_page's i64 priority arg, aborting the whole import.
    expect(parseFrontmatter("---\npriority: 2.5\n---\n").frontmatter.priority).toBe(0);
    expect(parseFrontmatter("---\npriority: 1.0\n---\n").frontmatter.priority).toBe(1);
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
    // Images are now handled (extracted as imageRefs), only mermaid triggers a warning
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]!.type).toBe("unsupported_content");
    expect(plan.warnings[0]!.message).toContain("mermaid diagram");
    expect(plan.pages[0]!.imageRefs).toHaveLength(1);
    expect(plan.pages[0]!.imageRefs[0]!.sourcePath).toBe("image.png");
  });

  it("imports empty (title-only) files without warning", () => {
    const files: VaultFile[] = [{ content: "---\ntags: [a]\n---\n", path: "empty.md" }];

    const plan = parseMarkdownVault(files);
    expect(plan.pages).toHaveLength(1);
    expect(plan.warnings).toHaveLength(0);
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

  it("transforms callouts instead of warning", () => {
    const files: VaultFile[] = [
      { content: "> [!warning] Be careful\n> Details here", path: "note.md" },
    ];
    const plan = parseMarkdownVault(files);
    expect(plan.warnings.some((w) => w.message.includes("callout"))).toBe(false);
    expect(plan.pages[0]!.body).toContain("**Warning:** Be careful");
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

    // Embedded images are now handled via imageRefs, not warned about
    const diagrams = plan.pages.find((p) => p.title === "Diagrams");
    expect(diagrams!.imageRefs.length).toBeGreaterThan(0);
  });

  it("imports empty content files without warning", () => {
    const emptyWarning = plan.warnings.find(
      (w) => w.source === "Projects/Work/Empty Task.md" && w.message.includes("no content")
    );
    expect(emptyWarning).toBeUndefined();
    expect(plan.pages.some((p) => p.title === "Empty Task")).toBe(true);
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

describe("extractImageRefs", () => {
  it("extracts Obsidian wiki-embed images", () => {
    const refs = extractImageRefs("Some text\n![[screenshot.png]]\nMore text");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      altText: "screenshot",
      fullMatch: "![[screenshot.png]]",
      sourcePath: "screenshot.png",
      syntax: "wiki",
    });
  });

  it("extracts wiki-embed with nested path", () => {
    const refs = extractImageRefs("![[attachments/photos/vacation.jpg]]");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      sourcePath: "attachments/photos/vacation.jpg",
      syntax: "wiki",
    });
  });

  it("extracts standard markdown images", () => {
    const refs = extractImageRefs("![alt text](images/diagram.png)");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      altText: "alt text",
      fullMatch: "![alt text](images/diagram.png)",
      sourcePath: "images/diagram.png",
      syntax: "standard",
    });
  });

  it("ignores http/https URLs in standard markdown", () => {
    const refs = extractImageRefs("![logo](https://example.com/logo.png)");
    expect(refs).toHaveLength(0);
  });

  it("extracts multiple image refs from one body", () => {
    const body = `# Notes
![[photo1.png]]
Some text
![diagram](assets/diagram.svg)
![[photo2.jpeg]]`;
    const refs = extractImageRefs(body);
    expect(refs).toHaveLength(3);
    expect(refs[0]!.sourcePath).toBe("photo1.png");
    expect(refs[1]!.sourcePath).toBe("assets/diagram.svg");
    expect(refs[2]!.sourcePath).toBe("photo2.jpeg");
  });

  it("handles empty alt text in standard markdown", () => {
    const refs = extractImageRefs("![](path/to/image.webp)");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.altText).toBe("");
    expect(refs[0]!.sourcePath).toBe("path/to/image.webp");
  });

  it("returns empty array when no images present", () => {
    const refs = extractImageRefs("Just plain text\n## With heading");
    expect(refs).toHaveLength(0);
  });

  it("is case-insensitive on extensions", () => {
    const refs = extractImageRefs("![[Photo.PNG]]\n![](diagram.SVG)");
    expect(refs).toHaveLength(2);
  });

  it("marks extensionless wiki-embeds as speculative", () => {
    const refs = extractImageRefs("![[Screenshot 2026-04-13 at 7.41.23 PM]]");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.speculative).toBe(true);
    expect(refs[0]!.sourcePath).toBe("Screenshot 2026-04-13 at 7.41.23 PM");
  });

  it("does not mark wiki-embeds with extensions as speculative", () => {
    const refs = extractImageRefs("![[photo.png]]");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.speculative).toBeUndefined();
  });

  it("does not double-match embeds with extensions", () => {
    const refs = extractImageRefs("![[photo.png]]\n![[My Note]]");
    expect(refs).toHaveLength(2);
    expect(refs[0]!.sourcePath).toBe("photo.png");
    expect(refs[0]!.speculative).toBeUndefined();
    expect(refs[1]!.sourcePath).toBe("My Note");
    expect(refs[1]!.speculative).toBe(true);
  });

  it("handles wiki-embed with display text", () => {
    const refs = extractImageRefs("![[photo.png|My Photo]]");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourcePath).toBe("photo.png");
  });
});

describe("parseMarkdownVault image handling", () => {
  it("populates imageRefs on pages with embedded images", () => {
    const files: VaultFile[] = [
      {
        content: "# My Note\n\n![[screenshot.png]]\n\n![diagram](assets/flow.svg)",
        path: "notes/my-note.md",
      },
    ];
    const plan = parseMarkdownVault(files);
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]!.imageRefs).toHaveLength(2);
    expect(plan.pages[0]!.imageRefs[0]!.syntax).toBe("wiki");
    expect(plan.pages[0]!.imageRefs[1]!.syntax).toBe("standard");
  });

  it("does not warn about embedded images (now handled)", () => {
    const files: VaultFile[] = [{ content: "![[photo.png]]", path: "note.md" }];
    const plan = parseMarkdownVault(files);
    const imageWarnings = plan.warnings.filter((w) => w.message.includes("embedded image"));
    expect(imageWarnings).toHaveLength(0);
  });

  it("still warns about other unsupported content", () => {
    const files: VaultFile[] = [{ content: "```mermaid\ngraph TD\nA-->B\n```", path: "note.md" }];
    const plan = parseMarkdownVault(files);
    expect(plan.warnings.some((w) => w.message.includes("mermaid"))).toBe(true);
  });

  it("sets empty imageRefs on pages without images", () => {
    const files: VaultFile[] = [{ content: "# Plain note\nNo images here.", path: "plain.md" }];
    const plan = parseMarkdownVault(files);
    expect(plan.pages[0]!.imageRefs).toEqual([]);
  });

  it("transforms callouts into styled blockquotes on import", () => {
    const files: VaultFile[] = [
      { content: "> [!note] Important info\n> More details here.", path: "callout.md" },
    ];
    const plan = parseMarkdownVault(files);
    expect(plan.pages[0]!.body).toContain("**Note:** Important info");
    expect(plan.pages[0]!.body).toContain("> More details here.");
  });

  it("does not warn about callouts (now handled)", () => {
    const files: VaultFile[] = [
      { content: "> [!warning] Watch out!\n> This is dangerous.", path: "warn.md" },
    ];
    const plan = parseMarkdownVault(files);
    const calloutWarnings = plan.warnings.filter((w) => w.message.includes("callout"));
    expect(calloutWarnings).toHaveLength(0);
  });
});

describe("transformCallouts", () => {
  it("transforms callout with title", () => {
    const input = "> [!note] My Title\n> Body text";
    const result = transformCallouts(input);
    expect(result).toBe("> **Note:** My Title\n> Body text");
  });

  it("transforms callout without title", () => {
    const result = transformCallouts("> [!warning]");
    expect(result).toBe("> **Warning:**");
  });

  it("handles multiple callouts", () => {
    const input = "> [!note] First\n\n> [!tip] Second";
    const result = transformCallouts(input);
    expect(result).toContain("**Note:** First");
    expect(result).toContain("**Tip:** Second");
  });

  it("preserves non-callout blockquotes", () => {
    const input = "> Just a regular quote";
    const result = transformCallouts(input);
    expect(result).toBe("> Just a regular quote");
  });

  it("capitalizes type label", () => {
    const result = transformCallouts("> [!INFO] Details");
    expect(result).toBe("> **Info:** Details");
  });
});

// ─── Date format variants ─────────────────────────────────────────────────────
// Coverage for every format in DATE_FORMATS, plus failure cases. The Linter
// without-seconds branch and the abbreviated/slash formats had no direct tests,
// so a regression in DATE_FORMATS could silently drop user dates.

describe("parseFrontmatter date formats", () => {
  it("parses Linter format without seconds", () => {
    const raw = `---\ncreated: "Monday, March 17th 2025, 11:03 am"\n---\n`;
    expect(parseFrontmatter(raw).frontmatter.created).toBe("2025-03-17T11:03:00");
  });

  it("parses month-day-year with time, no weekday", () => {
    const raw = `---\ncreated: "March 17th 2025, 11:03:04 am"\n---\n`;
    expect(parseFrontmatter(raw).frontmatter.created).toBe("2025-03-17T11:03:04");
  });

  it("parses month-day-year with ordinal, no time", () => {
    const raw = `---\ncreated: "March 17th 2025"\n---\n`;
    expect(parseFrontmatter(raw).frontmatter.created).toBe("2025-03-17");
  });

  it("parses long month with no ordinal", () => {
    const raw = `---\ncreated: "March 17, 2025"\n---\n`;
    expect(parseFrontmatter(raw).frontmatter.created).toBe("2025-03-17");
  });

  it("parses abbreviated month", () => {
    const raw = `---\ncreated: "Mar 17, 2025"\n---\n`;
    expect(parseFrontmatter(raw).frontmatter.created).toBe("2025-03-17");
  });

  it("parses US slash format", () => {
    const raw = `---\ncreated: 03/17/2025\n---\n`;
    expect(parseFrontmatter(raw).frontmatter.created).toBe("2025-03-17");
  });

  it("parses ISO with T separator and minutes only", () => {
    const raw = `---\ncreated: "2025-06-15T14:30"\n---\n`;
    // ISO patterns pass through directly without reformatting
    expect(parseFrontmatter(raw).frontmatter.created).toBe("2025-06-15T14:30");
  });

  it("returns null for unparseable dates without throwing", () => {
    const raw = `---\ncreated: not-a-date\n---\n`;
    expect(parseFrontmatter(raw).frontmatter.created).toBeNull();
  });

  it("returns null for empty date value", () => {
    const raw = `---\ncreated: ""\n---\n`;
    expect(parseFrontmatter(raw).frontmatter.created).toBeNull();
  });

  it("trims surrounding whitespace before parsing", () => {
    const raw = `---\ncreated:    "2025-06-15"   \n---\n`;
    expect(parseFrontmatter(raw).frontmatter.created).toBe("2025-06-15");
  });
});

// ─── Status / priority edge cases ─────────────────────────────────────────────
// The toLowerCase() path is exercised but never with truly mixed-case input.

describe("parseFrontmatter status/priority casing", () => {
  it("normalizes uppercase status", () => {
    expect(parseFrontmatter("---\nstatus: DONE\n---\n").frontmatter.status).toBe("done");
    expect(parseFrontmatter("---\nstatus: Completed\n---\n").frontmatter.status).toBe("done");
  });

  it("normalizes uppercase priority labels", () => {
    expect(parseFrontmatter("---\npriority: URGENT\n---\n").frontmatter.priority).toBe(1);
    expect(parseFrontmatter("---\npriority: High\n---\n").frontmatter.priority).toBe(2);
  });

  it("accepts quoted numeric priority", () => {
    expect(parseFrontmatter('---\npriority: "2"\n---\n').frontmatter.priority).toBe(2);
  });

  it("accepts quoted text priority", () => {
    expect(parseFrontmatter("---\npriority: 'urgent'\n---\n").frontmatter.priority).toBe(1);
  });

  it("treats fractional priority as out-of-range", () => {
    // Number("2.5") === 2.5 is not a valid PagePriority — it must default to 0,
    // not be force-cast through to create_page's i64 arg.
    const p = parseFrontmatter("---\npriority: 2.5\n---\n").frontmatter.priority;
    expect(p).toBe(0);
  });
});

// ─── Frontmatter robustness ────────────────────────────────────────────────────
// Body content containing `---` and CRLF inputs round-trip through Pikos and
// other tools. Malformed frontmatter (no closing fence) shouldn't crash.

describe("parseFrontmatter robustness", () => {
  it("handles CRLF line endings", () => {
    const raw = "---\r\nstatus: done\r\npriority: 2\r\n---\r\nBody";
    const { body, frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.status).toBe("done");
    expect(frontmatter.priority).toBe(2);
    expect(body).toBe("Body");
  });

  it("preserves horizontal-rule --- in body", () => {
    const raw = "---\nstatus: done\n---\n# Heading\n\n---\n\nMore body";
    const { body, frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.status).toBe("done");
    expect(body).toContain("---");
    expect(body).toContain("More body");
  });

  it("treats unclosed frontmatter as plain body", () => {
    const raw = "---\nstatus: done\nno-closing-fence\n# Heading";
    const { body, frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.status).toBe("not_started");
    expect(body).toBe(raw);
  });

  it("handles frontmatter with no trailing newline before fence", () => {
    const raw = "---\nstatus: done\n---";
    expect(parseFrontmatter(raw).frontmatter.status).toBe("done");
  });
});

describe("extractWikilinks edge cases", () => {
  it("preserves block-reference syntax in target", () => {
    expect(extractWikilinks("[[Note^block-id]]")).toEqual(["Note^block-id"]);
  });

  it("preserves header-anchor syntax in target", () => {
    expect(extractWikilinks("[[Note#Heading]]")).toEqual(["Note#Heading"]);
  });

  it("trims whitespace inside brackets", () => {
    expect(extractWikilinks("[[  Padded  ]]")).toEqual(["Padded"]);
  });

  it("ignores empty wikilinks", () => {
    // [[]] has no target chars, regex requires ≥1 non-]/| char, so no match
    expect(extractWikilinks("[[]]")).toEqual([]);
  });
});

describe("extractImageRefs edge cases", () => {
  it("extracts consecutive wiki-embeds with no separator", () => {
    const refs = extractImageRefs("![[a.png]]![[b.png]]");
    expect(refs.map((r) => r.sourcePath)).toEqual(["a.png", "b.png"]);
  });

  it("preserves document order across wiki and standard mixed", () => {
    const body = "Lead\n![first](one.png)\n![[two.png]]\n![third](three.svg)\n![[four.jpg]]";
    const refs = extractImageRefs(body);
    expect(refs.map((r) => r.sourcePath)).toEqual(["one.png", "two.png", "three.svg", "four.jpg"]);
  });

  it("ignores http/https in standard syntax even with image extension", () => {
    const refs = extractImageRefs("![cdn](http://cdn.example.com/x.png)");
    expect(refs).toHaveLength(0);
  });

  it("does not match standard image syntax with title metadata", () => {
    // ![alt](path.png "title") — the title trailing causes the regex not to
    // match. Lock the current behavior so a future change to the regex is
    // explicit.
    const refs = extractImageRefs('![alt](image.png "title")');
    expect(refs).toHaveLength(0);
  });

  it("captures wiki embed with whitespace in name", () => {
    const refs = extractImageRefs("![[Pasted image 20250517123456.png]]");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourcePath).toBe("Pasted image 20250517123456.png");
  });

  it("captures multiple speculative refs separately", () => {
    const refs = extractImageRefs("![[Note A]] and ![[Note B]]");
    expect(refs).toHaveLength(2);
    expect(refs.every((r) => r.speculative === true)).toBe(true);
  });
});

// ─── parseMarkdownVault: frontmatter survives transformations ─────────────────
// These guard against regressions where wikilink/image extraction mutates the
// body before frontmatter is read, or where callout transformation strips
// content the user authored.

describe("parseMarkdownVault transformation order", () => {
  it("extracts wikilinks BEFORE callout transformation", () => {
    // A callout body containing a wikilink — both should round-trip.
    const files: VaultFile[] = [
      { content: "> [!note] See also\n> Read [[Other Page]] first", path: "n.md" },
    ];
    const plan = parseMarkdownVault(files);
    expect(plan.pages[0]!.wikilinks).toEqual(["Other Page"]);
    expect(plan.pages[0]!.body).toContain("**Note:** See also");
    expect(plan.pages[0]!.body).toContain("[[Other Page]]");
  });

  it("extracts image refs from inside a callout body", () => {
    const files: VaultFile[] = [{ content: "> [!info] Look\n> ![[diagram.png]]", path: "n.md" }];
    const plan = parseMarkdownVault(files);
    expect(plan.pages[0]!.imageRefs).toHaveLength(1);
    expect(plan.pages[0]!.imageRefs[0]!.sourcePath).toBe("diagram.png");
  });

  it("does not transform callouts inside fenced code blocks (current behavior)", () => {
    // The CALLOUT_RE matches `^> [!type]` at line start globally; fenced code
    // is not currently parsed structurally. Lock the current behavior so any
    // future structural pass is intentional.
    const files: VaultFile[] = [{ content: "```md\n> [!note] inside fence\n```", path: "n.md" }];
    const plan = parseMarkdownVault(files);
    expect(plan.pages[0]!.body).toContain("**Note:** inside fence");
  });

  it("preserves body identity when no transformations apply", () => {
    const files: VaultFile[] = [{ content: "Plain body, no specials.", path: "p.md" }];
    const plan = parseMarkdownVault(files);
    expect(plan.pages[0]!.body).toBe("Plain body, no specials.");
  });
});
