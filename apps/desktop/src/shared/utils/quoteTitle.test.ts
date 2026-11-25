import { describe, expect, it } from "vitest";

import { quoteTitle } from "./quoteTitle";

describe("quoteTitle", () => {
  it("quotes a short title whole", () => {
    expect(quoteTitle("Get 3 contractor quotes")).toBe("“Get 3 contractor quotes”");
  });

  it("cuts a long title inside the quotes, so the closing quote stays", () => {
    const quoted = quoteTitle(`Get 3 contractor quotes ${"for the kitchen ".repeat(5)}`);

    expect(quoted.endsWith("…”")).toBe(true);
    expect(quoted.length).toBeLessThan(55);
  });

  it("names an untitled page", () => {
    expect(quoteTitle("")).toBe("“Untitled”");
  });
});
