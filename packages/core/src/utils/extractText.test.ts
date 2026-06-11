import { describe, expect, it } from "vitest";

import { extractText } from "./extractText";

describe("extractText", () => {
  it('empty string → ""', () => {
    expect(extractText("")).toBe("");
  });

  it('empty object "{}" string → ""', () => {
    expect(extractText("{}")).toBe("");
  });

  it('null → ""', () => {
    expect(extractText(null)).toBe("");
  });

  it('undefined → ""', () => {
    expect(extractText(undefined)).toBe("");
  });

  it("simple paragraph → plain text", () => {
    const doc = {
      content: [
        {
          content: [{ text: "Hello world", type: "text" }],
          type: "paragraph",
        },
      ],
      type: "doc",
    };
    expect(extractText(doc)).toBe("Hello world");
  });

  it("nested headings + paragraphs → newline-separated", () => {
    const doc = {
      content: [
        {
          content: [{ text: "Title", type: "text" }],
          type: "heading",
        },
        {
          content: [{ text: "Body text", type: "text" }],
          type: "paragraph",
        },
      ],
      type: "doc",
    };
    expect(extractText(doc)).toBe("Title\nBody text");
  });

  it("code block → text extracted", () => {
    const doc = {
      content: [
        {
          content: [{ text: "const x = 1;", type: "text" }],
          type: "codeBlock",
        },
      ],
      type: "doc",
    };
    expect(extractText(doc)).toBe("const x = 1;");
  });

  it("task list items → text extracted", () => {
    const doc = {
      content: [
        {
          content: [
            {
              content: [
                {
                  content: [{ text: "Buy milk", type: "text" }],
                  type: "paragraph",
                },
              ],
              type: "taskItem",
            },
            {
              content: [
                {
                  content: [{ text: "Write tests", type: "text" }],
                  type: "paragraph",
                },
              ],
              type: "taskItem",
            },
          ],
          type: "taskList",
        },
      ],
      type: "doc",
    };
    expect(extractText(doc)).toBe("Buy milk\nWrite tests");
  });

  it("deeply nested lists → all text extracted", () => {
    const doc = {
      content: [
        {
          content: [
            {
              content: [
                {
                  content: [{ text: "Level 1", type: "text" }],
                  type: "paragraph",
                },
                {
                  content: [
                    {
                      content: [
                        {
                          content: [{ text: "Level 2", type: "text" }],
                          type: "paragraph",
                        },
                      ],
                      type: "listItem",
                    },
                  ],
                  type: "bulletList",
                },
              ],
              type: "listItem",
            },
          ],
          type: "bulletList",
        },
      ],
      type: "doc",
    };
    const result = extractText(doc);
    expect(result).toContain("Level 1");
    expect(result).toContain("Level 2");
  });

  it("JSON string input → parsed and extracted", () => {
    const doc = JSON.stringify({
      content: [
        {
          content: [{ text: "From string", type: "text" }],
          type: "paragraph",
        },
      ],
      type: "doc",
    });
    expect(extractText(doc)).toBe("From string");
  });

  it('invalid JSON string → ""', () => {
    expect(extractText("{not valid json")).toBe("");
  });
});
