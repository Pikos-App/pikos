import { describe, expect, it, vi } from "vitest";

import { EMPTY_TIPTAP_DOC, tryParseTiptapJson } from "./jsonContent";

describe("tryParseTiptapJson", () => {
  it("returns null for null, undefined, empty, and empty-object strings", () => {
    expect(tryParseTiptapJson(null, "ctx")).toBeNull();
    expect(tryParseTiptapJson(undefined, "ctx")).toBeNull();
    expect(tryParseTiptapJson("", "ctx")).toBeNull();
    expect(tryParseTiptapJson("{}", "ctx")).toBeNull();
  });

  it("parses a valid Tiptap JSON document", () => {
    const doc = { content: [{ type: "paragraph" }], type: "doc" };
    expect(tryParseTiptapJson(JSON.stringify(doc), "ctx")).toEqual(doc);
  });

  it("returns null and logs an error for malformed JSON", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(tryParseTiptapJson("{not json", "open-page")).toBeNull();
    errSpy.mockRestore();
  });
});

describe("EMPTY_TIPTAP_DOC", () => {
  it("is a single empty paragraph doc", () => {
    expect(EMPTY_TIPTAP_DOC).toEqual({ content: [{ type: "paragraph" }], type: "doc" });
  });
});
