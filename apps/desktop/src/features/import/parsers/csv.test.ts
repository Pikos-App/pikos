import { describe, expect, it } from "vitest";

import {
  applyMappings,
  detectUniqueValues,
  parseCSV,
  parseDurationToMinutes,
  prepareCSVRows,
  suggestColumnMappings,
  suggestValueMappings,
} from "./csv";
import type { CSVMappingConfig } from "./types";

// ─── parseCSV ─────────────────────────────────────────────────────────────────

describe("parseCSV", () => {
  it("parses simple CSV", () => {
    const rows = parseCSV("Name,Age\nAlice,30\nBob,25");
    expect(rows).toEqual([
      { Age: "30", Name: "Alice" },
      { Age: "25", Name: "Bob" },
    ]);
  });

  it("handles quoted fields with commas", () => {
    const rows = parseCSV('Title,Content\n"Task, important","Do this, then that"');
    expect(rows[0]!["Title"]).toBe("Task, important");
    expect(rows[0]!["Content"]).toBe("Do this, then that");
  });

  it("handles quoted fields with newlines", () => {
    const rows = parseCSV('Title,Content\n"Task","Line 1\nLine 2"');
    expect(rows[0]!["Content"]).toBe("Line 1\nLine 2");
  });

  it("handles escaped quotes", () => {
    const rows = parseCSV('Title\n"Say ""hello"""');
    expect(rows[0]!["Title"]).toBe('Say "hello"');
  });

  it("returns empty for header-only CSV", () => {
    expect(parseCSV("Title,Content")).toEqual([]);
  });
});

// ─── prepareCSVRows ──────────────────────────────────────────────────────────

describe("prepareCSVRows", () => {
  it("strips BOM", () => {
    const { rows } = prepareCSVRows("\uFEFFTitle,Status\nTest,0");
    expect(rows).toHaveLength(1);
    expect(rows[0]!["Title"]).toBe("Test");
  });

  it("strips TickTick preamble", () => {
    const csv = `"Date: 2026-04-04+0000"
"Version: 7.1"
"Status:
0 Normal
1 Completed
2 Archived"
"Folder Name","List Name","Title","Status"
"","Work","Buy milk","0"`;
    const { headers, rows } = prepareCSVRows(csv);
    expect(headers).toContain("Title");
    expect(rows).toHaveLength(1);
    expect(rows[0]!["Title"]).toBe("Buy milk");
  });

  it("preprocesses Todoist note rows", () => {
    const csv = `TYPE,CONTENT,DESCRIPTION
task,My Task,Original
note,Extra context,`;
    const { rows } = prepareCSVRows(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["DESCRIPTION"]).toBe("Original\n\nExtra context");
  });

  it("skips Todoist meta and section rows", () => {
    const csv = `TYPE,CONTENT
meta,view_style=list
section,My Section
task,Real task`;
    const { rows } = prepareCSVRows(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["CONTENT"]).toBe("Real task");
  });
});

// ─── suggestColumnMappings ───────────────────────────────────────────────────

describe("suggestColumnMappings", () => {
  it("detects TickTick headers", () => {
    const headers = ["Folder Name", "List Name", "Title", "Status", "Priority"];
    const rows = [
      { "Folder Name": "", "List Name": "Work", Priority: "0", Status: "0", Title: "Test" },
    ];
    const { detectedSource, mappings } = suggestColumnMappings(headers, rows);
    expect(detectedSource).toBe("TickTick");
    expect(mappings.find((m) => m.csvHeader === "Title")?.pikosField).toBe("title");
    expect(mappings.find((m) => m.csvHeader === "Status")?.pikosField).toBe("status");
  });

  it("detects Todoist headers and overrides CONTENT to title", () => {
    const headers = ["TYPE", "CONTENT", "DESCRIPTION", "PRIORITY"];
    const rows = [{ CONTENT: "My task", DESCRIPTION: "Details", PRIORITY: "1", TYPE: "task" }];
    const { detectedSource, mappings } = suggestColumnMappings(headers, rows);
    expect(detectedSource).toBe("Todoist");
    expect(mappings.find((m) => m.csvHeader === "CONTENT")?.pikosField).toBe("title");
    expect(mappings.find((m) => m.csvHeader === "DESCRIPTION")?.pikosField).toBe("body");
  });

  it("defaults unknown headers to skip", () => {
    const headers = ["Foo", "Bar"];
    const rows = [{ Bar: "b", Foo: "a" }];
    const { detectedSource, mappings } = suggestColumnMappings(headers, rows);
    expect(detectedSource).toBeNull();
    expect(mappings.every((m) => m.pikosField === "skip")).toBe(true);
  });

  it("prevents duplicate field assignments", () => {
    const headers = ["Title", "Name"]; // both heuristically map to "title"
    const rows = [{ Name: "b", Title: "a" }];
    const { mappings } = suggestColumnMappings(headers, rows);
    const titleMappings = mappings.filter((m) => m.pikosField === "title");
    expect(titleMappings).toHaveLength(1);
  });
});

// ─── suggestValueMappings ────────────────────────────────────────────────────

describe("suggestValueMappings", () => {
  it("maps TickTick status values", () => {
    const vm = suggestValueMappings("status", ["0", "1", "2", "-1"], "TickTick");
    expect(vm.entries.find((e) => e.sourceValue === "0")?.targetValue).toBe("not_started");
    expect(vm.entries.find((e) => e.sourceValue === "1")?.targetValue).toBe("done");
    expect(vm.entries.find((e) => e.sourceValue === "2")?.targetValue).toBe("done");
    expect(vm.entries.find((e) => e.sourceValue === "-1")?.targetValue).toBe("done");
  });

  it("maps TickTick priority values", () => {
    const vm = suggestValueMappings("priority", ["0", "1", "3", "5"], "TickTick");
    expect(vm.entries.map((e) => e.targetValue)).toEqual(["0", "4", "3", "2"]);
  });

  it("maps Todoist priority values", () => {
    const vm = suggestValueMappings("priority", ["1", "2", "3", "4"], "Todoist");
    expect(vm.entries.map((e) => e.targetValue)).toEqual(["1", "2", "3", "0"]);
  });
});

// ─── applyMappings ───────────────────────────────────────────────────────────

describe("applyMappings", () => {
  it("transforms rows using column and value mappings", () => {
    const rows = [
      { Content: "Get 2%", Folder: "Work", Priority: "5", Status: "0", Title: "Buy milk" },
      { Content: "", Folder: "Work", Priority: "0", Status: "2", Title: "Finish report" },
    ];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Content", pikosField: "body", sampleValues: [] },
        { csvHeader: "Folder", pikosField: "folder", sampleValues: [] },
        { csvHeader: "Status", pikosField: "status", sampleValues: [] },
        { csvHeader: "Priority", pikosField: "priority", sampleValues: [] },
      ],
      detectedSource: "TickTick",
      valueMappings: [
        {
          entries: [
            { sourceValue: "0", targetValue: "not_started" },
            { sourceValue: "2", targetValue: "done" },
          ],
          field: "status",
        },
        {
          entries: [
            { sourceValue: "0", targetValue: "0" },
            { sourceValue: "5", targetValue: "2" },
          ],
          field: "priority",
        },
      ],
    };

    const plan = applyMappings(rows, config);
    expect(plan.pages).toHaveLength(2);
    expect(plan.folders).toHaveLength(1);

    expect(plan.pages[0]!.title).toBe("Buy milk");
    expect(plan.pages[0]!.body).toBe("Get 2%");
    expect(plan.pages[0]!.status).toBe("not_started");
    expect(plan.pages[0]!.priority).toBe(2);

    expect(plan.pages[1]!.status).toBe("done");
    expect(plan.pages[1]!.priority).toBe(0);
  });

  it("skips rows without title", () => {
    const rows = [{ Status: "0", Title: "" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Status", pikosField: "skip", sampleValues: [] },
      ],
      detectedSource: null,
      valueMappings: [],
    };

    const plan = applyMappings(rows, config);
    expect(plan.pages).toHaveLength(0);
    expect(plan.warnings.some((w) => w.type === "parse_error")).toBe(true);
  });

  it("puts inbox-named folders in null folderKey", () => {
    const rows = [{ Folder: "inbox", Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Folder", pikosField: "folder", sampleValues: [] },
      ],
      detectedSource: null,
      valueMappings: [],
    };

    const plan = applyMappings(rows, config);
    expect(plan.pages[0]!.folderKey).toBeNull();
    expect(plan.folders).toHaveLength(0);
  });
});

// ─── prepareCSVRows — additional cases ──────────────────────────────────────

describe("prepareCSVRows — edge cases", () => {
  it("returns empty for header-only CSV", () => {
    const { rows } = prepareCSVRows("Title");
    expect(rows).toHaveLength(0);
  });

  it("returns empty for empty string", () => {
    const { rows } = prepareCSVRows("");
    expect(rows).toHaveLength(0);
  });

  it("merges Todoist note into previous task even when DESCRIPTION is empty", () => {
    const csv = `TYPE,CONTENT,DESCRIPTION
task,My Task,
note,Note text,`;
    const { rows } = prepareCSVRows(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["DESCRIPTION"]).toBe("Note text");
  });

  it("skips Todoist empty rows (no TYPE, no CONTENT)", () => {
    const csv = `TYPE,CONTENT
task,Real task
,,`;
    const { rows } = prepareCSVRows(csv);
    expect(rows).toHaveLength(1);
  });

  it("handles BOM combined with TickTick preamble", () => {
    const csv = `\uFEFF"Date: 2026-01-01"
"Folder Name","List Name","Title"
"","Home","Task 1"`;
    const { headers, rows } = prepareCSVRows(csv);
    expect(headers).toContain("Title");
    expect(rows).toHaveLength(1);
  });
});

// ─── suggestColumnMappings — additional cases ───────────────────────────────

describe("suggestColumnMappings — source-specific overrides", () => {
  it("TickTick: maps Folder Name→skip, List Name→folder, Start Date→scheduledStart, Due Date→scheduledEnd", () => {
    const headers = ["Folder Name", "List Name", "Title", "Start Date", "Due Date", "Status"];
    const rows = [
      {
        "Due Date": "2025-06-01",
        "Folder Name": "",
        "List Name": "Work",
        "Start Date": "2025-05-31",
        Status: "0",
        Title: "Test",
      },
    ];
    const { mappings } = suggestColumnMappings(headers, rows);
    expect(mappings.find((m) => m.csvHeader === "Folder Name")?.pikosField).toBe("skip");
    expect(mappings.find((m) => m.csvHeader === "List Name")?.pikosField).toBe("folder");
    expect(mappings.find((m) => m.csvHeader === "Start Date")?.pikosField).toBe("scheduledStart");
    expect(mappings.find((m) => m.csvHeader === "Due Date")?.pikosField).toBe("scheduledEnd");
  });

  it("Todoist: maps TYPE→skip, indent→skip, DEADLINE→scheduledEnd", () => {
    const headers = ["TYPE", "CONTENT", "DESCRIPTION", "DEADLINE", "indent"];
    const rows = [
      {
        CONTENT: "Task",
        DEADLINE: "2025-06-01",
        DESCRIPTION: "Details",
        indent: "1",
        TYPE: "task",
      },
    ];
    const { mappings } = suggestColumnMappings(headers, rows);
    expect(mappings.find((m) => m.csvHeader === "TYPE")?.pikosField).toBe("skip");
    expect(mappings.find((m) => m.csvHeader === "indent")?.pikosField).toBe("skip");
    expect(mappings.find((m) => m.csvHeader === "DEADLINE")?.pikosField).toBe("scheduledEnd");
  });

  it("extracts sample values from first 3 non-empty rows", () => {
    const headers = ["Title"];
    const rows = [
      { Title: "Alpha" },
      { Title: "" },
      { Title: "Beta" },
      { Title: "Gamma" },
      { Title: "Delta" },
    ];
    const { mappings } = suggestColumnMappings(headers, rows);
    expect(mappings[0]!.sampleValues).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("truncates long sample values", () => {
    const headers = ["Title"];
    const longVal = "A".repeat(80);
    const rows = [{ Title: longVal }];
    const { mappings } = suggestColumnMappings(headers, rows);
    expect(mappings[0]!.sampleValues[0]!.length).toBeLessThanOrEqual(60);
    expect(mappings[0]!.sampleValues[0]).toContain("...");
  });
});

// ─── detectUniqueValues ─────────────────────────────────────────────────────

describe("detectUniqueValues", () => {
  it("returns sorted unique non-empty values", () => {
    const rows = [
      { Status: "done" },
      { Status: "active" },
      { Status: "done" },
      { Status: "pending" },
    ];
    expect(detectUniqueValues(rows, "Status")).toEqual(["active", "done", "pending"]);
  });

  it("filters out empty and whitespace values", () => {
    const rows = [{ Tag: "a" }, { Tag: "" }, { Tag: "  " }, { Tag: "b" }];
    expect(detectUniqueValues(rows, "Tag")).toEqual(["a", "b"]);
  });

  it("returns empty array for missing header", () => {
    const rows = [{ Other: "x" }];
    expect(detectUniqueValues(rows, "Missing")).toEqual([]);
  });
});

// ─── suggestValueMappings — additional cases ────────────────────────────────

describe("suggestValueMappings — generic patterns", () => {
  it("maps generic status values: done, completed, complete, closed, true, yes, 1, x", () => {
    const values = ["done", "completed", "complete", "closed", "true", "yes", "1", "x", "open"];
    const vm = suggestValueMappings("status", values, null);
    for (const doneVal of ["done", "completed", "complete", "closed", "true", "yes", "1", "x"]) {
      expect(vm.entries.find((e) => e.sourceValue === doneVal)?.targetValue).toBe("done");
    }
    expect(vm.entries.find((e) => e.sourceValue === "open")?.targetValue).toBe("not_started");
  });

  it("maps generic priority labels", () => {
    const values = ["urgent", "high", "medium", "low", "none", "normal"];
    const vm = suggestValueMappings("priority", values, null);
    expect(vm.entries.find((e) => e.sourceValue === "urgent")?.targetValue).toBe("1");
    expect(vm.entries.find((e) => e.sourceValue === "high")?.targetValue).toBe("2");
    expect(vm.entries.find((e) => e.sourceValue === "medium")?.targetValue).toBe("3");
    expect(vm.entries.find((e) => e.sourceValue === "low")?.targetValue).toBe("4");
    expect(vm.entries.find((e) => e.sourceValue === "none")?.targetValue).toBe("0");
    expect(vm.entries.find((e) => e.sourceValue === "normal")?.targetValue).toBe("0");
  });

  it("Todoist priority: 4 maps to none (0), 1 maps to critical (1)", () => {
    const vm = suggestValueMappings("priority", ["4", "1"], "Todoist");
    expect(vm.entries.find((e) => e.sourceValue === "4")?.targetValue).toBe("0");
    expect(vm.entries.find((e) => e.sourceValue === "1")?.targetValue).toBe("1");
  });

  it("defaults unknown priority values to 0", () => {
    const vm = suggestValueMappings("priority", ["unknown"], null);
    expect(vm.entries[0]!.targetValue).toBe("0");
  });
});

// ─── applyMappings — additional cases ───────────────────────────────────────

describe("applyMappings — date parsing", () => {
  const makeConfig = (fields: [string, string][]): CSVMappingConfig => ({
    columnMappings: fields.map(([header, field]) => ({
      csvHeader: header,
      pikosField: field as import("./types").PikosFieldKey,
      sampleValues: [],
    })),
    detectedSource: null,
    valueMappings: [],
  });

  it("parses date-only values (YYYY-MM-DD)", () => {
    const rows = [{ Due: "2025-06-15", Title: "Task" }];
    const plan = applyMappings(
      rows,
      makeConfig([
        ["Title", "title"],
        ["Due", "scheduledStart"],
      ])
    );
    expect(plan.pages[0]!.scheduledStart).toBe("2025-06-15");
  });

  it("parses ISO datetime with timezone offset", () => {
    const rows = [{ Due: "2025-06-15T14:30:00+0000", Title: "Task" }];
    const plan = applyMappings(
      rows,
      makeConfig([
        ["Title", "title"],
        ["Due", "scheduledStart"],
      ])
    );
    // Should be converted to local time, not null
    expect(plan.pages[0]!.scheduledStart).toBeTruthy();
    expect(plan.pages[0]!.scheduledStart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it("returns null for empty date values", () => {
    const rows = [{ Due: "", Title: "Task" }];
    const plan = applyMappings(
      rows,
      makeConfig([
        ["Title", "title"],
        ["Due", "scheduledStart"],
      ])
    );
    expect(plan.pages[0]!.scheduledStart).toBeNull();
  });
});

describe("applyMappings — folder handling", () => {
  const makeConfig = (source: string | null = null): CSVMappingConfig => ({
    columnMappings: [
      { csvHeader: "Title", pikosField: "title", sampleValues: [] },
      { csvHeader: "Folder", pikosField: "folder", sampleValues: [] },
    ],
    detectedSource: source,
    valueMappings: [],
  });

  it("deduplicates folders across rows", () => {
    const rows = [
      { Folder: "Work", Title: "Task 1" },
      { Folder: "Work", Title: "Task 2" },
      { Folder: "Personal", Title: "Task 3" },
    ];
    const plan = applyMappings(rows, makeConfig());
    expect(plan.folders).toHaveLength(2);
    expect(plan.folders.map((f) => f.name).sort()).toEqual(["Personal", "Work"]);
  });

  it("treats Inbox (case-insensitive) as null folderKey", () => {
    const rows = [
      { Folder: "Inbox", Title: "Task 1" },
      { Folder: "INBOX", Title: "Task 2" },
    ];
    const plan = applyMappings(rows, makeConfig());
    expect(plan.pages.every((p) => p.folderKey === null)).toBe(true);
    expect(plan.folders).toHaveLength(0);
  });

  it("treats empty folder as null folderKey", () => {
    const rows = [{ Folder: "", Title: "Task" }];
    const plan = applyMappings(rows, makeConfig());
    expect(plan.pages[0]!.folderKey).toBeNull();
  });
});

describe("applyMappings — completedAt and updatedAt fallbacks", () => {
  it("sets completedAt to current time when status is done but no completedAt column", () => {
    const rows = [{ Status: "1", Title: "Done task" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Status", pikosField: "status", sampleValues: [] },
      ],
      detectedSource: null,
      valueMappings: [
        {
          entries: [{ sourceValue: "1", targetValue: "done" }],
          field: "status",
        },
      ],
    };
    const plan = applyMappings(rows, config);
    expect(plan.pages[0]!.completedAt).toBeTruthy();
  });

  it("does not set completedAt for non-done tasks", () => {
    const rows = [{ Status: "0", Title: "Active task" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Status", pikosField: "status", sampleValues: [] },
      ],
      detectedSource: null,
      valueMappings: [
        {
          entries: [{ sourceValue: "0", targetValue: "not_started" }],
          field: "status",
        },
      ],
    };
    const plan = applyMappings(rows, config);
    expect(plan.pages[0]!.completedAt).toBeNull();
  });

  it("updatedAt falls back to completedAt, then createdAt", () => {
    const rows = [{ Created: "2025-01-01", Status: "1", Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Status", pikosField: "status", sampleValues: [] },
        { csvHeader: "Created", pikosField: "createdAt", sampleValues: [] },
      ],
      detectedSource: null,
      valueMappings: [
        {
          entries: [{ sourceValue: "1", targetValue: "done" }],
          field: "status",
        },
      ],
    };
    const plan = applyMappings(rows, config);
    // updatedAt should not be null — falls back through completedAt → createdAt
    expect(plan.pages[0]!.updatedAt).toBeTruthy();
  });

  it("updatedAt falls back to createdAt when no completedAt", () => {
    const rows = [{ Created: "2025-01-01", Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Created", pikosField: "createdAt", sampleValues: [] },
      ],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    expect(plan.pages[0]!.updatedAt).toBe("2025-01-01");
  });
});

describe("applyMappings — sourceId and sourceParentId", () => {
  it("extracts sourceId and sourceParentId from mapped columns", () => {
    const rows = [{ ParentId: "parent-123", TaskId: "abc-123", Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "TaskId", pikosField: "sourceId", sampleValues: [] },
        { csvHeader: "ParentId", pikosField: "sourceParentId", sampleValues: [] },
      ],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    expect(plan.pages[0]!.sourceId).toBe("abc-123");
    expect(plan.pages[0]!.sourceParentId).toBe("parent-123");
  });

  it("sets sourceId/sourceParentId to null when columns not mapped", () => {
    const rows = [{ Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [{ csvHeader: "Title", pikosField: "title", sampleValues: [] }],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    expect(plan.pages[0]!.sourceId).toBeNull();
    expect(plan.pages[0]!.sourceParentId).toBeNull();
  });
});

describe("applyMappings — tags", () => {
  it("splits comma-separated tags", () => {
    const rows = [{ Tags: "work, urgent, project-x", Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Tags", pikosField: "tags", sampleValues: [] },
      ],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    expect(plan.pages[0]!.tags).toEqual(["work", "urgent", "project-x"]);
  });

  it("returns empty tags when column is empty", () => {
    const rows = [{ Tags: "", Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Tags", pikosField: "tags", sampleValues: [] },
      ],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    expect(plan.pages[0]!.tags).toEqual([]);
  });
});

describe("applyMappings — meta generation", () => {
  it("reports skipped rows in meta", () => {
    const rows = [{ Title: "Good" }, { Title: "" }];
    const config: CSVMappingConfig = {
      columnMappings: [{ csvHeader: "Title", pikosField: "title", sampleValues: [] }],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    expect(plan.meta.skipped.some((s) => s.reason === "rows without a title")).toBe(true);
  });

  it("reports skipped columns in meta", () => {
    const rows = [{ Extra: "x", Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Extra", pikosField: "skip", sampleValues: ["x"] },
      ],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    expect(plan.meta.skipped.some((s) => s.reason.includes("not mapped"))).toBe(true);
  });

  it("adds transformation for completed tasks count", () => {
    const rows = [
      { Status: "done", Title: "Task 1" },
      { Status: "active", Title: "Task 2" },
    ];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Status", pikosField: "status", sampleValues: [] },
      ],
      detectedSource: null,
      valueMappings: [
        {
          entries: [
            { sourceValue: "done", targetValue: "done" },
            { sourceValue: "active", targetValue: "not_started" },
          ],
          field: "status",
        },
      ],
    };
    const plan = applyMappings(rows, config);
    expect(plan.meta.transformations.some((t) => t.includes("1 tasks marked as completed"))).toBe(
      true
    );
  });

  it("adds transformation for subtasks with parent IDs", () => {
    const rows = [{ ParentId: "parent-1", Title: "Subtask" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "ParentId", pikosField: "sourceParentId", sampleValues: [] },
      ],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    expect(plan.meta.transformations.some((t) => t.includes("subtasks linked"))).toBe(true);
  });

  it("adds transformation when only start dates mapped (no end)", () => {
    const rows = [{ Due: "2025-06-15", Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Due", pikosField: "scheduledStart", sampleValues: [] },
      ],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    expect(plan.meta.transformations.some((t) => t.includes("Only start/due dates imported"))).toBe(
      true
    );
  });

  it("adds transformation when no createdAt mapped", () => {
    const rows = [{ Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [{ csvHeader: "Title", pikosField: "title", sampleValues: [] }],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    expect(plan.meta.transformations.some((t) => t.includes("No created date mapped"))).toBe(true);
  });

  it("adds transformation when status mapped but no completedAt", () => {
    const rows = [{ Status: "done", Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Status", pikosField: "status", sampleValues: [] },
      ],
      detectedSource: null,
      valueMappings: [{ entries: [{ sourceValue: "done", targetValue: "done" }], field: "status" }],
    };
    const plan = applyMappings(rows, config);
    expect(plan.meta.transformations.some((t) => t.includes("No completed date column"))).toBe(
      true
    );
  });

  it("explains known TickTick skip reasons in transformations", () => {
    const rows = [{ "Folder Name": "", Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Folder Name", pikosField: "skip", sampleValues: [""] },
      ],
      detectedSource: "TickTick",
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    expect(
      plan.meta.transformations.some((t) => t.includes("Folder Name") && t.includes("List Name"))
    ).toBe(true);
  });

  it("lists unexplained skipped columns in transformations", () => {
    const rows = [{ CustomField: "val", Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "CustomField", pikosField: "skip", sampleValues: ["val"] },
      ],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    expect(
      plan.meta.transformations.some(
        (t) => t.includes("Skipped columns") && t.includes("CustomField")
      )
    ).toBe(true);
  });

  it("sets source label based on detectedSource", () => {
    const rows = [{ Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [{ csvHeader: "Title", pikosField: "title", sampleValues: [] }],
      detectedSource: "TickTick",
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    expect(plan.source).toBe("csv_ticktick");
  });

  it("sets source label to csv for unknown source", () => {
    const rows = [{ Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [{ csvHeader: "Title", pikosField: "title", sampleValues: [] }],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    expect(plan.source).toBe("csv");
  });
});

// ─── applyMappings — scheduledStart/scheduledEnd fallback logic ─────────────

describe("applyMappings — scheduledStart fallback to scheduledEnd", () => {
  const makeConfig = (fields: [string, string][]): CSVMappingConfig => ({
    columnMappings: fields.map(([header, field]) => ({
      csvHeader: header,
      pikosField: field as import("./types").PikosFieldKey,
      sampleValues: [],
    })),
    detectedSource: null,
    valueMappings: [],
  });

  it("uses scheduledEnd as fallback when scheduledStart is unparseable", () => {
    const rows = [{ DATE: "today at 11:00", DEADLINE: "2025-06-20", Title: "Task" }];
    const config = makeConfig([
      ["Title", "title"],
      ["DATE", "scheduledStart"],
      ["DEADLINE", "scheduledEnd"],
    ]);
    const plan = applyMappings(rows, config);
    // DATE is unparseable natural language → falls back to DEADLINE
    expect(plan.pages[0]!.scheduledStart).toBe("2025-06-20");
    expect(plan.pages[0]!.scheduledEnd).toBeNull(); // cleared after fallback
  });

  it("does not fall back when scheduledStart is parseable", () => {
    const rows = [{ DATE: "2025-06-15", DEADLINE: "2025-06-20", Title: "Task" }];
    const config = makeConfig([
      ["Title", "title"],
      ["DATE", "scheduledStart"],
      ["DEADLINE", "scheduledEnd"],
    ]);
    const plan = applyMappings(rows, config);
    expect(plan.pages[0]!.scheduledStart).toBe("2025-06-15");
    expect(plan.pages[0]!.scheduledEnd).toBe("2025-06-20");
  });

  it("leaves both null when neither is parseable", () => {
    const rows = [{ DATE: "whenever", DEADLINE: "someday", Title: "Task" }];
    const config = makeConfig([
      ["Title", "title"],
      ["DATE", "scheduledStart"],
      ["DEADLINE", "scheduledEnd"],
    ]);
    const plan = applyMappings(rows, config);
    expect(plan.pages[0]!.scheduledStart).toBeNull();
    expect(plan.pages[0]!.scheduledEnd).toBeNull();
  });
});

// ─── applyMappings — duration computation ───────────────────────────────────

describe("applyMappings — duration computation", () => {
  it("computes scheduledEnd from start datetime + duration", () => {
    const rows = [
      { Due: "2025-06-15T14:00:00", DURATION: "30", DURATION_UNIT: "minute", Title: "Meeting" },
    ];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Due", pikosField: "scheduledStart", sampleValues: [] },
        { csvHeader: "DURATION", pikosField: "skip", sampleValues: ["30"] },
        { csvHeader: "DURATION_UNIT", pikosField: "skip", sampleValues: ["minute"] },
      ],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    expect(plan.pages[0]!.scheduledStart).toBe("2025-06-15T14:00:00");
    expect(plan.pages[0]!.scheduledEnd).toBe("2025-06-15T14:30:00");
  });

  it("extracts time from raw field value when start is date-only", () => {
    // Simulates Todoist: DATE="2025-06-15" but raw has time info embedded
    // Actually, the raw field is read via `get(row, "scheduledStart")` which gives the raw CSV value
    // If date-only is parsed, it tries to extract time from the raw value
    const rows = [{ DATE: "2025-06-15 at 11:00", DURATION: "60", Title: "Call" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "DATE", pikosField: "scheduledStart", sampleValues: [] },
        { csvHeader: "DURATION", pikosField: "skip", sampleValues: ["60"] },
      ],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    // The date portion "2025-06-15" is parseable, time "11:00" extracted from raw
    expect(plan.pages[0]!.scheduledStart).toBe("2025-06-15T11:00:00");
    expect(plan.pages[0]!.scheduledEnd).toBe("2025-06-15T12:00:00");
  });

  it("skips duration when start is date-only with no extractable time", () => {
    const rows = [{ Due: "2025-06-15", DURATION: "30", Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Due", pikosField: "scheduledStart", sampleValues: [] },
        { csvHeader: "DURATION", pikosField: "skip", sampleValues: ["30"] },
      ],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    // No time in raw value → all-day block, duration skipped
    expect(plan.pages[0]!.scheduledStart).toBe("2025-06-15");
    expect(plan.pages[0]!.scheduledEnd).toBeNull();
  });

  it("ignores non-numeric duration values", () => {
    const rows = [{ Due: "2025-06-15T10:00:00", DURATION: "invalid", Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Due", pikosField: "scheduledStart", sampleValues: [] },
        { csvHeader: "DURATION", pikosField: "skip", sampleValues: ["invalid"] },
      ],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    expect(plan.pages[0]!.scheduledEnd).toBeNull();
  });

  it("ignores zero or negative duration values", () => {
    const rows = [{ Due: "2025-06-15T10:00:00", DURATION: "0", Title: "Task" }];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Due", pikosField: "scheduledStart", sampleValues: [] },
        { csvHeader: "DURATION", pikosField: "skip", sampleValues: ["0"] },
      ],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    expect(plan.pages[0]!.scheduledEnd).toBeNull();
  });

  it("does not overwrite existing scheduledEnd with duration", () => {
    const rows = [
      { DURATION: "30", End: "2025-06-15T16:00:00", Start: "2025-06-15T14:00:00", Title: "Task" },
    ];
    const config: CSVMappingConfig = {
      columnMappings: [
        { csvHeader: "Title", pikosField: "title", sampleValues: [] },
        { csvHeader: "Start", pikosField: "scheduledStart", sampleValues: [] },
        { csvHeader: "End", pikosField: "scheduledEnd", sampleValues: [] },
        { csvHeader: "DURATION", pikosField: "skip", sampleValues: ["30"] },
      ],
      detectedSource: null,
      valueMappings: [],
    };
    const plan = applyMappings(rows, config);
    // Explicit end time should be preserved, not overwritten by duration
    expect(plan.pages[0]!.scheduledEnd).toBe("2025-06-15T16:00:00");
  });
});

// ─── prepareCSVRows — Todoist preprocessing edge cases ──────────────────────

describe("prepareCSVRows — Todoist edge cases", () => {
  it("drops orphaned note appearing before any task", () => {
    const csv = `TYPE,CONTENT,DESCRIPTION
note,Orphan note,
task,Real task,`;
    const { rows } = prepareCSVRows(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["CONTENT"]).toBe("Real task");
  });

  it("merges multiple consecutive notes into previous task", () => {
    const csv = `TYPE,CONTENT,DESCRIPTION
task,My Task,Original desc
note,First note,
note,Second note,`;
    const { rows } = prepareCSVRows(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["DESCRIPTION"]).toBe("Original desc\n\nFirst note\n\nSecond note");
  });

  it("handles task followed by note then another task", () => {
    const csv = `TYPE,CONTENT,DESCRIPTION
task,Task A,Desc A
note,Note for A,
task,Task B,Desc B`;
    const { rows } = prepareCSVRows(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]!["DESCRIPTION"]).toBe("Desc A\n\nNote for A");
    expect(rows[1]!["DESCRIPTION"]).toBe("Desc B");
  });
});

// ─── End-to-end: TickTick CSV ────────────────────────────────────────────────
// Simulates the full pipeline: raw CSV → prepareCSVRows → suggestColumnMappings
// → suggestValueMappings → applyMappings → ImportPlan with correct field values.

describe("end-to-end: TickTick CSV import", () => {
  const ticktickCSV = `"Date: 2026-04-04+0000"
"Version: 7.1"
"Status:
0 Normal
1 Completed
2 Archived"
"Folder Name","List Name","Title","Kind","Tags","Content","Is Check list","Start Date","Due Date","Reminder","Repeat","Priority","Status","Created Time","Completed Time","Order","Timezone","Is All Day","Is Floating","Column Name","Column Order","View Mode","taskId","parentId"
"","Work","Buy groceries","TEXT","errands","Milk and eggs","N","2026-03-15T09:00:00+0000","2026-03-15T09:30:00+0000","PT0S","","5","0","2026-01-10T08:00:00+0000","","0","America/Los_Angeles","false","false",,,"list","101",""
"","Work","Write report","TEXT","work","Q4 summary","N","","2026-06-15T00:00:00+0000","","","3","2","2026-01-05T10:00:00+0000","2026-03-20T14:30:00+0000","0","America/Los_Angeles","true","false",,,"list","102",""
"","Work","Review PR","TEXT","","","N","","","","","0","-1","2026-02-01T09:00:00+0000","2026-02-15T11:00:00+0000","0","America/Los_Angeles","false","false",,,"list","103","101"`;

  function runFullPipeline(csv: string) {
    const { headers, rows } = prepareCSVRows(csv);
    const { detectedSource, mappings } = suggestColumnMappings(headers, rows);

    // Generate value mappings for auto-detected status/priority
    const valueMappings = [];
    for (const cm of mappings) {
      if (cm.pikosField === "status" || cm.pikosField === "priority") {
        const uniqueVals = detectUniqueValues(rows, cm.csvHeader);
        if (uniqueVals.length > 0) {
          valueMappings.push(suggestValueMappings(cm.pikosField, uniqueVals, detectedSource));
        }
      }
    }

    const config: CSVMappingConfig = {
      columnMappings: mappings,
      detectedSource,
      valueMappings,
    };

    return { config, plan: applyMappings(rows, config) };
  }

  it("detects TickTick source and maps all key columns", () => {
    const { config } = runFullPipeline(ticktickCSV);
    expect(config.detectedSource).toBe("TickTick");

    const mapped = config.columnMappings.filter((cm) => cm.pikosField !== "skip");
    const fields = mapped.map((cm) => cm.pikosField);
    expect(fields).toContain("title");
    expect(fields).toContain("folder");
    expect(fields).toContain("status");
    expect(fields).toContain("priority");
    expect(fields).toContain("tags");
    expect(fields).toContain("body");
    expect(fields).toContain("scheduledStart");
    expect(fields).toContain("scheduledEnd");
    expect(fields).toContain("createdAt");
    expect(fields).toContain("completedAt");
    expect(fields).toContain("sourceId");
    expect(fields).toContain("sourceParentId");
  });

  it("correctly maps TickTick Folder Name to skip and List Name to folder", () => {
    const { config } = runFullPipeline(ticktickCSV);
    expect(config.columnMappings.find((cm) => cm.csvHeader === "Folder Name")?.pikosField).toBe(
      "skip"
    );
    expect(config.columnMappings.find((cm) => cm.csvHeader === "List Name")?.pikosField).toBe(
      "folder"
    );
  });

  it("produces correct page count and folder structure", () => {
    const { plan } = runFullPipeline(ticktickCSV);
    expect(plan.pages).toHaveLength(3);
    expect(plan.folders).toHaveLength(1);
    expect(plan.folders[0]!.name).toBe("Work");
  });

  it("maps status values correctly (0=active, 2=archived/done, -1=done)", () => {
    const { plan } = runFullPipeline(ticktickCSV);
    expect(plan.pages[0]!.status).toBe("not_started"); // Status 0
    expect(plan.pages[1]!.status).toBe("done"); // Status 2
    expect(plan.pages[2]!.status).toBe("done"); // Status -1
  });

  it("maps priority values correctly (0=none, 3=medium, 5=high)", () => {
    const { plan } = runFullPipeline(ticktickCSV);
    expect(plan.pages[0]!.priority).toBe(2); // TickTick 5 → Pikos high (2)
    expect(plan.pages[1]!.priority).toBe(3); // TickTick 3 → Pikos medium (3)
    expect(plan.pages[2]!.priority).toBe(0); // TickTick 0 → Pikos none (0)
  });

  it("extracts tags correctly", () => {
    const { plan } = runFullPipeline(ticktickCSV);
    expect(plan.pages[0]!.tags).toEqual(["errands"]);
    expect(plan.pages[1]!.tags).toEqual(["work"]);
    expect(plan.pages[2]!.tags).toEqual([]);
  });

  it("maps timed events with start and end dates", () => {
    const { plan } = runFullPipeline(ticktickCSV);
    // First task: timed event with Start Date + Due Date
    expect(plan.pages[0]!.scheduledStart).toContain("T");
    expect(plan.pages[0]!.scheduledEnd).toContain("T");
  });

  it("maps all-day events as date-only", () => {
    const { plan } = runFullPipeline(ticktickCSV);
    // Second task: Is All Day = true, Due Date only → date-only via fallback
    const start = plan.pages[1]!.scheduledStart;
    // Should have a schedule from the due date
    expect(start).toBeTruthy();
  });

  it("preserves created and completed timestamps", () => {
    const { plan } = runFullPipeline(ticktickCSV);
    expect(plan.pages[0]!.createdAt).toBeTruthy();
    expect(plan.pages[0]!.completedAt).toBeNull(); // not done

    expect(plan.pages[1]!.createdAt).toBeTruthy();
    expect(plan.pages[1]!.completedAt).toBeTruthy(); // done, has Completed Time
  });

  it("maps sourceId and sourceParentId for parent resolution", () => {
    const { plan } = runFullPipeline(ticktickCSV);
    expect(plan.pages[0]!.sourceId).toBe("101");
    expect(plan.pages[0]!.sourceParentId).toBeNull();

    expect(plan.pages[2]!.sourceId).toBe("103");
    expect(plan.pages[2]!.sourceParentId).toBe("101"); // child of task 101
  });

  it("maps body content", () => {
    const { plan } = runFullPipeline(ticktickCSV);
    expect(plan.pages[0]!.body).toBe("Milk and eggs");
    expect(plan.pages[1]!.body).toBe("Q4 summary");
  });
});

// ─── parseDurationToMinutes ──────────────────────────────────────────────────

describe("parseDurationToMinutes", () => {
  it("parses PT0S (on time) to 0", () => {
    expect(parseDurationToMinutes("PT0S")).toBe(0);
  });

  it("parses -PT5M to 5", () => {
    expect(parseDurationToMinutes("-PT5M")).toBe(5);
  });

  it("parses -PT30M to 30", () => {
    expect(parseDurationToMinutes("-PT30M")).toBe(30);
  });

  it("parses -PT1H to 60", () => {
    expect(parseDurationToMinutes("-PT1H")).toBe(60);
  });

  it("parses -P1D to 1440", () => {
    expect(parseDurationToMinutes("-P1D")).toBe(1440);
  });

  it("parses combined duration -P1DT2H30M", () => {
    expect(parseDurationToMinutes("-P1DT2H30M")).toBe(1440 + 120 + 30);
  });

  it("returns null for empty string", () => {
    expect(parseDurationToMinutes("")).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseDurationToMinutes("not a duration")).toBeNull();
  });

  it("handles positive duration (no leading minus)", () => {
    expect(parseDurationToMinutes("PT15M")).toBe(15);
  });
});

// ─── TickTick reminder import (via mapping pipeline) ─────────────────────────

describe("TickTick reminders via applyMappings", () => {
  function runReminderPipeline(csv: string) {
    const { headers, rows } = prepareCSVRows(csv);
    const { detectedSource, mappings } = suggestColumnMappings(headers, rows);
    const valueMappings = [];
    for (const cm of mappings) {
      if (cm.pikosField === "status" || cm.pikosField === "priority") {
        const uniqueVals = detectUniqueValues(rows, cm.csvHeader);
        if (uniqueVals.length > 0) {
          valueMappings.push(suggestValueMappings(cm.pikosField, uniqueVals, detectedSource));
        }
      }
    }
    const config: CSVMappingConfig = { columnMappings: mappings, detectedSource, valueMappings };
    return applyMappings(rows, config);
  }

  it("parses Reminder column into reminderMinutes", () => {
    const csv = `Folder Name,List Name,Title,Status,Priority,Reminder,Due Date
,Work,Meeting,0,0,-PT10M,2025-06-15`;
    const plan = runReminderPipeline(csv);
    expect(plan.pages[0]!.reminderMinutes).toEqual([10]);
  });

  it("handles multiple reminders separated by semicolons", () => {
    const csv = `Folder Name,List Name,Title,Status,Priority,Reminder,Due Date
,Work,Meeting,0,0,"-PT5M;-PT30M",2025-06-15`;
    const plan = runReminderPipeline(csv);
    expect(plan.pages[0]!.reminderMinutes).toEqual([5, 30]);
  });

  it("defaults to empty array when no Reminder column", () => {
    const csv = `Folder Name,List Name,Title,Status,Priority
,Work,Task,0,0`;
    const plan = runReminderPipeline(csv);
    expect(plan.pages[0]!.reminderMinutes).toEqual([]);
  });

  it("skips unparseable reminder values", () => {
    const csv = `Folder Name,List Name,Title,Status,Priority,Reminder
,Work,Task,0,0,garbage`;
    const plan = runReminderPipeline(csv);
    expect(plan.pages[0]!.reminderMinutes).toEqual([]);
  });
});

// ─── End-to-end: Todoist CSV ─────────────────────────────────────────────────

describe("end-to-end: Todoist CSV import", () => {
  const todoistCSV = `TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT,DEADLINE,DEADLINE_LANG
meta,view_style=list,,,,,,,,,,,,
,,,,,,,,,,,,,
task,Call important client,Only on Tuesdays,1,1,,,today at 11:00,en,,30,minute,2025-03-31,en
note,Follow up next week,,,,,,,,,,,,
task,**Weekly chores**:,,4,1,,,,,,,,2025-02-24,en
task,Clean the house,,4,2,,,every month @ 13:00,en,,120,minute,,
task,Take out the trash,,3,2,,,every Friday,en,,,,,`;

  function runFullPipeline(csv: string) {
    const { headers, rows } = prepareCSVRows(csv);
    const { detectedSource, mappings } = suggestColumnMappings(headers, rows);

    const valueMappings = [];
    for (const cm of mappings) {
      if (cm.pikosField === "status" || cm.pikosField === "priority") {
        const uniqueVals = detectUniqueValues(rows, cm.csvHeader);
        if (uniqueVals.length > 0) {
          valueMappings.push(suggestValueMappings(cm.pikosField, uniqueVals, detectedSource));
        }
      }
    }

    return {
      config: { columnMappings: mappings, detectedSource, valueMappings } as CSVMappingConfig,
      plan: applyMappings(rows, { columnMappings: mappings, detectedSource, valueMappings }),
    };
  }

  it("detects Todoist source", () => {
    const { config } = runFullPipeline(todoistCSV);
    expect(config.detectedSource).toBe("Todoist");
  });

  it("preprocesses: skips meta rows, empty rows, merges notes", () => {
    const { plan } = runFullPipeline(todoistCSV);
    // meta row, empty row, and note row should be gone
    // Remaining: 4 task rows
    expect(plan.pages).toHaveLength(4);
  });

  it("maps CONTENT to title and DESCRIPTION to body", () => {
    const { plan } = runFullPipeline(todoistCSV);
    expect(plan.pages[0]!.title).toBe("Call important client");
    // Note merged into description
    expect(plan.pages[0]!.body).toBe("Only on Tuesdays\n\nFollow up next week");
  });

  it("maps Todoist priority correctly (1=urgent, 3=medium, 4=none)", () => {
    const { plan } = runFullPipeline(todoistCSV);
    expect(plan.pages[0]!.priority).toBe(1); // Todoist 1 → urgent
    expect(plan.pages[1]!.priority).toBe(0); // Todoist 4 → none
    expect(plan.pages[2]!.priority).toBe(0); // Todoist 4 → none
    expect(plan.pages[3]!.priority).toBe(3); // Todoist 3 → medium
  });

  it("falls back to DEADLINE when DATE is natural language", () => {
    const { plan } = runFullPipeline(todoistCSV);
    // "today at 11:00" unparseable, DEADLINE "2025-03-31" used
    expect(plan.pages[0]!.scheduledStart).toBeTruthy();
    expect(plan.pages[0]!.scheduledStart).toContain("2025-03-31");
  });

  it("computes scheduledEnd from DEADLINE + DURATION + time from DATE", () => {
    const { plan } = runFullPipeline(todoistCSV);
    // DATE="today at 11:00" → extract 11:00, DEADLINE=2025-03-31, DURATION=30
    // → start: 2025-03-31T11:00:00, end: 2025-03-31T11:30:00
    const start = plan.pages[0]!.scheduledStart;
    const end = plan.pages[0]!.scheduledEnd;
    expect(start).toBe("2025-03-31T11:00:00");
    expect(end).toBe("2025-03-31T11:30:00");
  });

  it("maps TYPE to skip, INDENT to skip, DEADLINE to scheduledEnd", () => {
    const { config } = runFullPipeline(todoistCSV);
    expect(config.columnMappings.find((cm) => cm.csvHeader === "TYPE")?.pikosField).toBe("skip");
    expect(config.columnMappings.find((cm) => cm.csvHeader === "INDENT")?.pikosField).toBe("skip");
    expect(config.columnMappings.find((cm) => cm.csvHeader === "DEADLINE")?.pikosField).toBe(
      "scheduledEnd"
    );
  });

  it("all tasks default to not_started (Todoist exports only active)", () => {
    const { plan } = runFullPipeline(todoistCSV);
    for (const page of plan.pages) {
      expect(page.status).toBe("not_started");
    }
  });
});
