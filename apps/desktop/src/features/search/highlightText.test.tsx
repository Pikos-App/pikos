import { ftsTokens } from "@pikos/core";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { highlightText } from "./highlightText";

function marked(text: string, typed: string): string[] {
  const { container } = render(<>{highlightText(text, ftsTokens(typed), typed)}</>);
  return [...container.querySelectorAll("mark")].map((mark) => mark.textContent ?? "");
}

describe("highlightText", () => {
  it("marks a typed address once, not its pieces in every neighbour", () => {
    const guests = "Zoom · alex@example.com · sam@example.com · jordan@example.com";
    expect(marked(guests, "sam@example.com")).toEqual(["sam@example.com"]);
  });

  it("marks the tokens when the typed text isn't there verbatim", () => {
    expect(marked("a multi color palette", "multi-color")).toEqual(["multi", "color"]);
  });

  it("ignores spaces around the typed text", () => {
    expect(marked("Guests: sam@example.com", " sam@example.com ")).toEqual(["sam@example.com"]);
  });

  it("marks nothing when the index matched no tokens, even where the typed text appears", () => {
    const { container } = render(<>{highlightText("Zoom call", [], "Zoom")}</>);
    expect(container.querySelectorAll("mark")).toHaveLength(0);
    expect(container.textContent).toBe("Zoom call");
  });

  it("matches the typed text regardless of case", () => {
    expect(marked("Team Standup notes", "team standup")).toEqual(["Team Standup"]);
  });
});
