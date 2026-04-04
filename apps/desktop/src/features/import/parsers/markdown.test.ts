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

  it("parses scheduled_start field (Pikos export format)", () => {
    const raw = `---
scheduled_start: "2025-03-15T09:00:00"
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.scheduled).toBe("2025-03-15");
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
    expect(page.scheduledDate).toBe("2025-06-01");
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
});
