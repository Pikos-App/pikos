import { describe, expect, it } from "vitest";

import { parseCSV, parseCSVImport } from "./csv";

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

// ─── TickTick import ──────────────────────────────────────────────────────────

describe("parseCSVImport — TickTick", () => {
  const header = "Folder Name,List Name,Title,Content,Status,Priority,Tags,Due Date,Created Date";

  it("parses a basic TickTick export", () => {
    const csv = `${header}
Work,,Buy milk,Get 2% milk,0,0,groceries,,2025-01-15
Work,,Finish report,Q4 summary,2,5,"work, urgent",2025-06-15,2025-01-10`;

    const plan = parseCSVImport(csv);
    expect(plan.source).toBe("csv_ticktick");
    expect(plan.pages).toHaveLength(2);
    expect(plan.folders).toHaveLength(1);
    expect(plan.folders[0]!.name).toBe("Work");

    // First task
    expect(plan.pages[0]!.title).toBe("Buy milk");
    expect(plan.pages[0]!.body).toBe("Get 2% milk");
    expect(plan.pages[0]!.status).toBe("not_started");
    expect(plan.pages[0]!.priority).toBe(0);
    expect(plan.pages[0]!.tags).toEqual(["groceries"]);

    // Second task — completed, high priority
    expect(plan.pages[1]!.status).toBe("done");
    expect(plan.pages[1]!.priority).toBe(2); // TickTick 5 → Pikos high (2)
    expect(plan.pages[1]!.tags).toEqual(["work", "urgent"]);
    expect(plan.pages[1]!.scheduledDate).toBe("2025-06-15");
  });

  it("maps TickTick priorities correctly", () => {
    const csv = `${header}
,,None,,0,0,,,
,,Low,,0,1,,,
,,Medium,,0,3,,,
,,High,,0,5,,,`;

    const plan = parseCSVImport(csv);
    expect(plan.pages.map((p) => p.priority)).toEqual([0, 4, 3, 2]);
  });

  it("puts inbox tasks in null folder", () => {
    const csv = `Folder Name,Title,Status,Priority
inbox,Task,0,0`;

    const plan = parseCSVImport(csv);
    expect(plan.pages[0]!.folderKey).toBeNull();
    expect(plan.folders).toHaveLength(0);
  });

  it("warns on rows without title", () => {
    const csv = `${header}
Work,,,,0,0,,,`;

    const plan = parseCSVImport(csv);
    expect(plan.pages).toHaveLength(0);
    expect(plan.warnings.some((w) => w.type === "parse_error")).toBe(true);
  });
});

// ─── Todoist import ───────────────────────────────────────────────────────────

describe("parseCSVImport — Todoist", () => {
  const header = "TYPE,CONTENT,DESCRIPTION,PRIORITY,DATE,PROJECT,LABELS";

  it("parses a basic Todoist export", () => {
    const csv = `${header}
task,Buy groceries,Milk and eggs,4,2025-06-15,Shopping,errands
task,Read book,,1,,Personal,reading`;

    const plan = parseCSVImport(csv);
    expect(plan.source).toBe("csv_todoist");
    expect(plan.pages).toHaveLength(2);
    expect(plan.folders).toHaveLength(2);

    expect(plan.pages[0]!.title).toBe("Buy groceries");
    expect(plan.pages[0]!.body).toBe("Milk and eggs");
    expect(plan.pages[0]!.priority).toBe(1); // Todoist 4 → urgent (1)
    expect(plan.pages[0]!.scheduledDate).toBe("2025-06-15");
    expect(plan.pages[0]!.tags).toEqual(["errands"]);

    expect(plan.pages[1]!.priority).toBe(0); // Todoist 1 → none (0)
  });

  it("maps Todoist priorities correctly (inverted)", () => {
    const csv = `${header}
task,P1,,4,,Inbox,
task,P2,,3,,Inbox,
task,P3,,2,,Inbox,
task,P4,,1,,Inbox,`;

    const plan = parseCSVImport(csv);
    expect(plan.pages.map((p) => p.priority)).toEqual([1, 2, 3, 0]);
  });

  it("skips section rows", () => {
    const csv = `${header}
section,My Section,,1,,Project,
task,Real task,,1,,Project,`;

    const plan = parseCSVImport(csv);
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]!.title).toBe("Real task");
  });

  it("appends note rows to preceding task", () => {
    const csv = `${header}
task,My Task,Original description,1,,Project,
note,Extra context,,1,,Project,`;

    const plan = parseCSVImport(csv);
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]!.body).toBe("Original description\n\nExtra context");
  });
});

// ─── Unknown format ───────────────────────────────────────────────────────────

describe("parseCSVImport — unknown format", () => {
  it("returns warning for unrecognized headers", () => {
    const csv = "Foo,Bar\n1,2";
    const plan = parseCSVImport(csv);
    expect(plan.pages).toHaveLength(0);
    expect(plan.warnings[0]!.type).toBe("parse_error");
    expect(plan.warnings[0]!.message).toContain("Could not detect");
  });

  it("returns warning for empty CSV", () => {
    const plan = parseCSVImport("Title");
    expect(plan.warnings[0]!.type).toBe("parse_error");
  });
});
