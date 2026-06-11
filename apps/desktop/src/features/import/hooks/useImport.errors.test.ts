// Error-path coverage for useImport. The audit replaced raw err.message with
// storageErrorUserMessage at four sites; these tests assert that wiring by
// (a) making each underlying call throw with a leaky message, and
// (b) verifying state.message contains the friendly verb but not the raw text.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useImport } from "./useImport";

vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: vi.fn(),
  readTextFile: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../parsers/csv", async () => {
  const actual = await vi.importActual<typeof import("../parsers/csv")>("../parsers/csv");
  return {
    ...actual,
    applyMappings: vi.fn(actual.applyMappings),
    prepareCSVRows: vi.fn(actual.prepareCSVRows),
  };
});

import { readDir } from "@tauri-apps/plugin-fs";

import { applyMappings, prepareCSVRows } from "../parsers/csv";
import type { CSVMappingConfig } from "../parsers/types";

// useImport reads two contexts. We provide minimal stubs so the hook
// constructs without spinning up the full provider tree.

const importBatchMock = vi.fn();
vi.mock("@/shared/context/ImportContext", () => ({
  useImportBatch: () => ({
    clearLastImport: vi.fn(),
    importBatch: importBatchMock,
    lastImportResult: null,
    undoLastImport: vi.fn(),
  }),
}));

// PagesContext — mock with no-op delete helpers (only used in undoImport,
// which these tests don't exercise).
vi.mock("@/shared/context/PagesContext", () => ({
  usePages: () => ({
    softDeleteFolder: vi.fn(),
    softDeletePage: vi.fn(),
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseMarkdownDir error path", () => {
  it("translates readDir failures to friendly copy with the vault-read verb", async () => {
    // Real backend errors here can echo filesystem paths (incl. usernames).
    vi.mocked(readDir).mockRejectedValueOnce(new Error("ENOENT: /tmp/secret-vault not found"));

    const { result } = renderHook(() => useImport());

    await act(async () => {
      await result.current.parseMarkdownDir("/tmp/secret-vault");
    });

    expect(result.current.state.step).toBe("error");
    if (result.current.state.step !== "error") return;
    expect(result.current.state.message).toContain("reading your Markdown vault");
    expect(result.current.state.message).not.toContain("/tmp/secret-vault");
    expect(result.current.state.message).not.toContain("ENOENT");
  });
});

describe("parseCSVFile error path", () => {
  it("translates parser failures to friendly copy with the CSV-parse verb", () => {
    vi.mocked(prepareCSVRows).mockImplementationOnce(() => {
      throw new Error("Unterminated quote at row 42, column 'Notes': 'private data'");
    });

    const { result } = renderHook(() => useImport());

    act(() => {
      result.current.parseCSVFile("any,csv,content");
    });

    expect(result.current.state.step).toBe("error");
    if (result.current.state.step !== "error") return;
    expect(result.current.state.message).toContain("parsing your CSV");
    expect(result.current.state.message).not.toContain("private data");
    expect(result.current.state.message).not.toContain("Unterminated quote");
  });
});

describe("applyCSVMapping error path", () => {
  it("translates mapping failures to friendly copy with the mapping verb", () => {
    vi.mocked(prepareCSVRows).mockImplementationOnce(() => ({
      headers: ["title", "status"],
      rows: [{ status: "todo", title: "task one" }],
    }));
    vi.mocked(applyMappings).mockImplementationOnce(() => {
      throw new Error("Internal mapping bug: column 'xyz' undefined");
    });

    const { result } = renderHook(() => useImport());

    act(() => {
      result.current.parseCSVFile("title,status\ntask one,todo");
    });
    expect(result.current.state.step).toBe("mapping");

    act(() => {
      const config: CSVMappingConfig = {
        columnMappings: [],
        detectedSource: "generic",
        valueMappings: [],
      };
      result.current.applyCSVMapping(config);
    });

    expect(result.current.state.step).toBe("error");
    if (result.current.state.step !== "error") return;
    expect(result.current.state.message).toContain("applying your column mapping");
    expect(result.current.state.message).not.toContain("xyz");
    expect(result.current.state.message).not.toContain("Internal mapping bug");
  });
});

describe("executeImport error path", () => {
  it("translates batch failures to friendly copy with the import-run verb", async () => {
    importBatchMock.mockRejectedValueOnce(
      new Error("near INSERT: SQL syntax error on row 'TOP SECRET TITLE'")
    );

    const { result } = renderHook(() => useImport());

    await act(async () => {
      await result.current.executeImport({
        folders: [],
        meta: { skipped: [], transformations: [] },
        pages: [
          {
            body: "",
            completedAt: null,
            createdAt: null,
            folderKey: null,
            imageRefs: [],
            priority: 0,
            reminderMinutes: [],
            rrule: null,
            scheduledEnd: null,
            scheduledStart: null,
            sourceId: null,
            sourceParentId: null,
            status: "not_started",
            tags: [],
            title: "Test page",
            updatedAt: null,
            wikilinks: [],
          },
        ],
        source: "csv",
        warnings: [],
      });
    });

    expect(result.current.state.step).toBe("error");
    if (result.current.state.step !== "error") return;
    expect(result.current.state.message).toContain("running the import");
    expect(result.current.state.message).not.toContain("TOP SECRET TITLE");
    expect(result.current.state.message).not.toContain("SQL syntax error");
  });
});
