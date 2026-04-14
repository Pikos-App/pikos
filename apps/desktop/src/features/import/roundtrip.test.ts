// Round-trip integration tests for import/export data integrity.
// Tests that data survives: create → export → re-import → verify.
//
// MD path: markdown string → parseMarkdownVault → convertMarkdownToTiptap → editor.getJSON()
//          → editor.storage.markdown.getMarkdown() → parseMarkdownVault → verify metadata + content
//
// CSV path: CSV string → prepareCSVRows + applyMappings → verify metadata fields
//           → build CSV from output → re-parse → verify round-trip

import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { describe, expect, it } from "vitest";

import { convertMarkdownToTiptap } from "./hooks/useImport";
import {
  applyMappings,
  detectUniqueValues,
  prepareCSVRows,
  suggestColumnMappings,
  suggestValueMappings,
} from "./parsers/csv";
import { parseMarkdownVault, type VaultFile } from "./parsers/markdown";
import type { CSVMappingConfig, ImportPage } from "./parsers/types";

// ─── Shared editor for markdown round-trip ──────────────────────────────────

function createTestEditor(): Editor {
  return new Editor({
    content: "",
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Underline,
      Image.configure({ allowBase64: false, inline: false }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      Markdown.configure({
        breaks: true,
        transformPastedText: false,
      }),
    ],
  });
}

/** Convert Tiptap JSON back to markdown via the tiptap-markdown extension. */
function tiptapJsonToMarkdown(json: JSONContent): string {
  const editor = createTestEditor();
  editor.commands.setContent(json);
  const storage = editor.storage as unknown as Record<string, { getMarkdown?: () => string }>;
  const md = storage["markdown"]?.getMarkdown?.() ?? "";
  editor.destroy();
  return md;
}

// ─── Test fixtures ──────────────────────────────────────────────────────────

const RICH_MARKDOWN = `---
title: "Round Trip Test"
status: done
priority: 3
tags:
  - "testing"
  - "integration"
scheduled_start: "2026-04-15"
created: "2026-04-01T10:00:00"
updated: "2026-04-10T14:30:00"
---

# Main Heading

Some introductory text with **bold**, *italic*, and ~~strikethrough~~ formatting.

## Sub Heading

A paragraph with a [link](https://example.com) and some \`inline code\`.

- Bullet item one
- Bullet item two
- Bullet item three

1. Ordered item one
2. Ordered item two

- [ ] Unchecked task
- [x] Checked task

\`\`\`javascript
function hello() {
  console.log("world");
}
\`\`\`

> A blockquote with some wisdom.

| Name | Value | Notes |
| --- | --- | --- |
| Alpha | 1 | First |
| Beta | 2 | Second |

---

Final paragraph.
`;

const RICH_CSV = `Title,Content,Folder,Status,Priority,Tags,Start Date,End Date,Created At,Updated At,Completed At
"Project Alpha","This is the project description","Work",done,3,"planning, review",2026-04-15,2026-04-15T17:00:00,2026-04-01T10:00:00,2026-04-10T14:30:00,2026-04-10T14:30:00
"Quick Note","A simple note","Personal",not_started,0,"notes",,,2026-04-02T09:00:00,2026-04-02T09:00:00,
"High Priority Bug","Fix the login flow","Work",not_started,4,"bugs, urgent",2026-04-16T09:00:00,2026-04-16T12:00:00,2026-04-03T08:00:00,2026-04-03T08:00:00,
"Empty Task","","",not_started,0,"",,,2026-04-04T11:00:00,2026-04-04T11:00:00,
`;

// ─── Markdown round-trip tests ──────────────────────────────────────────────

describe("Markdown round-trip", () => {
  it("preserves metadata through import → export → re-import", () => {
    // Step 1: Parse the markdown
    const files: VaultFile[] = [{ content: RICH_MARKDOWN, path: "test-note.md" }];
    const plan1 = parseMarkdownVault(files);
    expect(plan1.pages).toHaveLength(1);
    const page1 = plan1.pages[0]!;

    // Verify initial parse
    expect(page1.title).toBe("test-note");
    expect(page1.status).toBe("done");
    expect(page1.priority).toBe(3);
    expect(page1.tags).toEqual(["testing", "integration"]);
    expect(page1.scheduledStart).toBe("2026-04-15");
    expect(page1.createdAt).toBe("2026-04-01T10:00:00");

    // Step 2: Convert to Tiptap JSON
    const tiptapJson = convertMarkdownToTiptap(page1.body);
    const parsed = JSON.parse(tiptapJson) as JSONContent;

    // Step 3: Convert back to markdown
    const exportedMd = tiptapJsonToMarkdown(parsed);

    // Step 4: Re-build with frontmatter (simulating export_markdown)
    const frontmatter = [
      "---",
      `title: "test-note"`,
      "status: done",
      "priority: 3",
      "tags:",
      '  - "testing"',
      '  - "integration"',
      'scheduled_start: "2026-04-15"',
      'created: "2026-04-01T10:00:00"',
      'updated: "2026-04-10T14:30:00"',
      "---",
      "",
    ].join("\n");
    const fullExport = frontmatter + exportedMd;

    // Step 5: Re-import
    const files2: VaultFile[] = [{ content: fullExport, path: "test-note.md" }];
    const plan2 = parseMarkdownVault(files2);
    expect(plan2.pages).toHaveLength(1);
    const page2 = plan2.pages[0]!;

    // Step 6: Verify metadata survived
    expect(page2.status).toBe(page1.status);
    expect(page2.priority).toBe(page1.priority);
    expect(page2.tags).toEqual(page1.tags);
    expect(page2.scheduledStart).toBe(page1.scheduledStart);
    expect(page2.createdAt).toBe(page1.createdAt);
  });

  it("preserves rich text structure through round-trip", () => {
    const files: VaultFile[] = [{ content: RICH_MARKDOWN, path: "rich.md" }];
    const plan = parseMarkdownVault(files);
    const tiptapJson = convertMarkdownToTiptap(plan.pages[0]!.body);
    const parsed = JSON.parse(tiptapJson) as JSONContent;

    // Verify key structural elements survived the markdown → Tiptap conversion
    const nodeTypes = (parsed.content ?? []).map((n) => n.type);
    expect(nodeTypes).toContain("heading");
    expect(nodeTypes).toContain("paragraph");
    expect(nodeTypes).toContain("bulletList");
    expect(nodeTypes).toContain("orderedList");
    expect(nodeTypes).toContain("taskList");
    expect(nodeTypes).toContain("codeBlock");
    expect(nodeTypes).toContain("blockquote");
    expect(nodeTypes).toContain("table");
    expect(nodeTypes).toContain("horizontalRule");

    // Now round-trip: Tiptap JSON → markdown → Tiptap JSON again
    const exportedMd = tiptapJsonToMarkdown(parsed);
    const reimportedJson = convertMarkdownToTiptap(exportedMd);
    const reparsed = JSON.parse(reimportedJson) as JSONContent;

    // Same structural elements should be present
    const nodeTypes2 = (reparsed.content ?? [])
      .filter((n) => n.type !== "paragraph" || (n.content && n.content.length > 0))
      .map((n) => n.type);

    expect(nodeTypes2).toContain("heading");
    expect(nodeTypes2).toContain("bulletList");
    expect(nodeTypes2).toContain("orderedList");
    expect(nodeTypes2).toContain("taskList");
    expect(nodeTypes2).toContain("codeBlock");
    expect(nodeTypes2).toContain("blockquote");
    expect(nodeTypes2).toContain("table");
    expect(nodeTypes2).toContain("horizontalRule");
  });

  it("preserves table content through round-trip", () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
    const json = JSON.parse(convertMarkdownToTiptap(md)) as JSONContent;
    const table = json.content?.find((n) => n.type === "table");
    expect(table).toBeTruthy();

    // Should have 3 rows (header + 2 data)
    expect(table!.content).toHaveLength(3);

    // Round-trip through markdown
    const exported = tiptapJsonToMarkdown(json);
    expect(exported).toContain("| A |");
    expect(exported).toContain("| 1 |");

    const reimported = JSON.parse(convertMarkdownToTiptap(exported)) as JSONContent;
    const table2 = reimported.content?.find((n) => n.type === "table");
    expect(table2).toBeTruthy();
    expect(table2!.content).toHaveLength(3);
  });

  it("preserves inline formatting marks", () => {
    const md = "**bold** *italic* ~~strike~~ `code` [link](https://example.com)";
    const json = JSON.parse(convertMarkdownToTiptap(md)) as JSONContent;
    const paragraph = json.content?.find((n) => n.type === "paragraph");
    const marks = (paragraph?.content ?? []).flatMap((n) => (n.marks ?? []).map((m) => m.type));

    expect(marks).toContain("bold");
    expect(marks).toContain("italic");
    expect(marks).toContain("strike");
    expect(marks).toContain("code");
    expect(marks).toContain("link");
  });

  it("preserves task list checked state", () => {
    const md = "- [ ] unchecked\n- [x] checked";
    const json = JSON.parse(convertMarkdownToTiptap(md)) as JSONContent;
    const taskList = json.content?.find((n) => n.type === "taskList");
    expect(taskList).toBeTruthy();

    const items = taskList!.content ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]!.attrs?.["checked"]).toBe(false);
    expect(items[1]!.attrs?.["checked"]).toBe(true);

    // Round-trip
    const exported = tiptapJsonToMarkdown(json);
    expect(exported).toContain("[ ]");
    expect(exported).toContain("[x]");
  });

  it("preserves heading levels", () => {
    const md = "# H1\n\n## H2\n\n### H3";
    const json = JSON.parse(convertMarkdownToTiptap(md)) as JSONContent;
    const headings = (json.content ?? []).filter((n) => n.type === "heading");
    expect(headings).toHaveLength(3);
    expect(headings[0]!.attrs?.["level"]).toBe(1);
    expect(headings[1]!.attrs?.["level"]).toBe(2);
    expect(headings[2]!.attrs?.["level"]).toBe(3);

    // Round-trip
    const exported = tiptapJsonToMarkdown(json);
    expect(exported).toContain("# H1");
    expect(exported).toContain("## H2");
    expect(exported).toContain("### H3");
  });

  it("handles empty content gracefully", () => {
    const files: VaultFile[] = [{ content: "---\ntags: [test]\n---\n", path: "empty.md" }];
    const plan = parseMarkdownVault(files);
    expect(plan.pages[0]!.tags).toEqual(["test"]);
    expect(plan.pages[0]!.body.trim()).toBe("");
  });

  it("preserves code block language", () => {
    const md = '```python\nprint("hello")\n```';
    const json = JSON.parse(convertMarkdownToTiptap(md)) as JSONContent;
    const codeBlock = json.content?.find((n) => n.type === "codeBlock");
    expect(codeBlock?.attrs?.["language"]).toBe("python");

    // Round-trip
    const exported = tiptapJsonToMarkdown(json);
    expect(exported).toContain("```python");
  });
});

// ─── CSV round-trip tests ───────────────────────────────────────────────────

describe("CSV round-trip", () => {
  function parseCSVToPlan(csvContent: string) {
    const { headers, rows } = prepareCSVRows(csvContent);
    const { detectedSource, mappings } = suggestColumnMappings(headers, rows);
    const valueMappings: CSVMappingConfig["valueMappings"] = [];
    for (const cm of mappings) {
      if (cm.pikosField === "status" || cm.pikosField === "priority") {
        const uniqueVals = detectUniqueValues(rows, cm.csvHeader);
        if (uniqueVals.length > 0) {
          valueMappings.push(suggestValueMappings(cm.pikosField, uniqueVals, detectedSource));
        }
      }
    }
    return applyMappings(rows, {
      columnMappings: mappings,
      detectedSource,
      valueMappings,
    });
  }

  /** Simulate CSV export from page data (matches Rust export_csv headers). */
  function exportPagesToCsv(pages: ImportPage[], folderNames: Map<string, string>): string {
    let csv =
      "Title,Content,Folder,Status,Priority,Tags,Start Date,End Date,Created At,Updated At,Completed At\n";
    for (const p of pages) {
      const esc = (s: string) =>
        s.includes(",") || s.includes("\n") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      const folder = p.folderKey ? (folderNames.get(p.folderKey) ?? p.folderKey) : "";
      csv +=
        [
          esc(p.title),
          esc(p.body),
          esc(folder),
          esc(p.status),
          String(p.priority),
          esc(p.tags.join(", ")),
          esc(p.scheduledStart ?? ""),
          esc(p.scheduledEnd ?? ""),
          esc(p.createdAt ?? ""),
          esc(p.updatedAt ?? ""),
          esc(p.completedAt ?? ""),
        ].join(",") + "\n";
    }
    return csv;
  }

  it("preserves page metadata through import → export → re-import", () => {
    // Step 1: Import CSV
    const plan1 = parseCSVToPlan(RICH_CSV);
    expect(plan1.pages).toHaveLength(4);

    const alpha = plan1.pages.find((p) => p.title === "Project Alpha")!;
    expect(alpha.status).toBe("done");
    expect(alpha.priority).toBe(3);
    expect(alpha.tags).toEqual(["planning", "review"]);
    expect(alpha.folderKey).toBe("Work");

    // Step 2: Export as CSV
    const folderNames = new Map(plan1.folders.map((f) => [f.key, f.name]));
    const exported = exportPagesToCsv(plan1.pages, folderNames);

    // Step 3: Re-import the exported CSV
    const plan2 = parseCSVToPlan(exported);
    expect(plan2.pages).toHaveLength(4);

    // Step 4: Verify metadata survived
    const alpha2 = plan2.pages.find((p) => p.title === "Project Alpha")!;
    expect(alpha2.status).toBe(alpha.status);
    expect(alpha2.priority).toBe(alpha.priority);
    expect(alpha2.tags).toEqual(alpha.tags);
    expect(alpha2.folderKey).toBe(alpha.folderKey);
    expect(alpha2.scheduledStart).toBe(alpha.scheduledStart);
  });

  it("preserves all pages through round-trip", () => {
    const plan1 = parseCSVToPlan(RICH_CSV);
    const folderNames = new Map(plan1.folders.map((f) => [f.key, f.name]));
    const exported = exportPagesToCsv(plan1.pages, folderNames);
    const plan2 = parseCSVToPlan(exported);

    expect(plan2.pages).toHaveLength(plan1.pages.length);
    for (const p1 of plan1.pages) {
      const p2 = plan2.pages.find((p) => p.title === p1.title);
      expect(p2).toBeTruthy();
      expect(p2!.status).toBe(p1.status);
      expect(p2!.priority).toBe(p1.priority);
      expect(p2!.folderKey).toBe(p1.folderKey);
    }
  });

  it("handles special characters in fields", () => {
    const csv = `Title,Content,Folder,Status,Priority,Tags
"Title with ""quotes""","Content with, commas","My ""Folder""",not_started,0,"tag1, tag2"
"Multiline
Title","Body text","Folder",done,2,"test"
`;
    const plan1 = parseCSVToPlan(csv);
    expect(plan1.pages).toHaveLength(2);
    expect(plan1.pages[0]!.title).toBe('Title with "quotes"');

    // Round-trip
    const folderNames = new Map(plan1.folders.map((f) => [f.key, f.name]));
    const exported = exportPagesToCsv(plan1.pages, folderNames);
    const plan2 = parseCSVToPlan(exported);
    expect(plan2.pages[0]!.title).toBe(plan1.pages[0]!.title);
  });

  it("preserves folder assignments", () => {
    const plan1 = parseCSVToPlan(RICH_CSV);
    const workPages = plan1.pages.filter((p) => p.folderKey === "Work");
    const personalPages = plan1.pages.filter((p) => p.folderKey === "Personal");
    const inboxPages = plan1.pages.filter((p) => p.folderKey === null);

    expect(workPages).toHaveLength(2);
    expect(personalPages).toHaveLength(1);
    expect(inboxPages).toHaveLength(1);

    // Round-trip
    const folderNames = new Map(plan1.folders.map((f) => [f.key, f.name]));
    const exported = exportPagesToCsv(plan1.pages, folderNames);
    const plan2 = parseCSVToPlan(exported);

    expect(plan2.pages.filter((p) => p.folderKey === "Work")).toHaveLength(2);
    expect(plan2.pages.filter((p) => p.folderKey === "Personal")).toHaveLength(1);
    expect(plan2.pages.filter((p) => p.folderKey === null)).toHaveLength(1);
  });

  it("preserves scheduled dates", () => {
    const plan = parseCSVToPlan(RICH_CSV);
    const bug = plan.pages.find((p) => p.title === "High Priority Bug")!;
    expect(bug.scheduledStart).toBeTruthy();

    // Round-trip
    const folderNames = new Map(plan.folders.map((f) => [f.key, f.name]));
    const exported = exportPagesToCsv(plan.pages, folderNames);
    const plan2 = parseCSVToPlan(exported);
    const bug2 = plan2.pages.find((p) => p.title === "High Priority Bug")!;
    expect(bug2.scheduledStart).toBe(bug.scheduledStart);
  });

  it("handles empty body and tags gracefully", () => {
    const plan = parseCSVToPlan(RICH_CSV);
    const empty = plan.pages.find((p) => p.title === "Empty Task")!;
    expect(empty.body).toBe("");
    expect(empty.tags).toEqual([]);

    // Round-trip
    const folderNames = new Map(plan.folders.map((f) => [f.key, f.name]));
    const exported = exportPagesToCsv(plan.pages, folderNames);
    const plan2 = parseCSVToPlan(exported);
    const empty2 = plan2.pages.find((p) => p.title === "Empty Task")!;
    expect(empty2.body).toBe("");
    expect(empty2.tags).toEqual([]);
  });

  it("maps new heuristic headers correctly", () => {
    const csv = `Title,Start Date,End Date,Updated At,Completed At,Priority
"Task A",2026-05-01,2026-05-01T17:00:00,2026-04-30T12:00:00,2026-05-01T18:00:00,3
"Task B",,,,, 0
`;
    const plan = parseCSVToPlan(csv);
    const a = plan.pages.find((p) => p.title === "Task A")!;
    expect(a.scheduledStart).toBe("2026-05-01");
    expect(a.scheduledEnd).toContain("2026-05-01");
    expect(a.updatedAt).toContain("2026-04-30");
    expect(a.completedAt).toContain("2026-05-01");
    expect(a.priority).toBe(3);
  });

  it("maps numeric priority values in generic mode", () => {
    const csv = `Title,Priority
"None",0
"Urgent",1
"High",2
"Medium",3
"Low",4
`;
    const plan = parseCSVToPlan(csv);
    expect(plan.pages.map((p) => p.priority)).toEqual([0, 1, 2, 3, 4]);
  });
});
