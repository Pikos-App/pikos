// ReleaseNotes — covers the markdown subset it renders (headings as labels,
// bullet lists, **bold**, `inline code`) and the core guarantee: no raw
// markdown syntax leaks into the visible text.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReleaseNotes } from "./ReleaseNotes";

afterEach(cleanup);

const NOTES = `### Fixed

- **Linux:** Fixed a blank or white window on some distributions, including Fedora.
- Tidied up \`latest.json\` handling.`;

describe("ReleaseNotes", () => {
  it("renders a heading as a label, not raw '###'", () => {
    render(<ReleaseNotes body={NOTES} />);
    expect(screen.getByText("Fixed")).toBeInTheDocument();
    expect(screen.queryByText(/###/)).not.toBeInTheDocument();
  });

  it("renders bullet items as a list", () => {
    render(<ReleaseNotes body={NOTES} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("renders **bold** as <strong> without the asterisks", () => {
    render(<ReleaseNotes body={NOTES} />);
    const strong = screen.getByText("Linux:");
    expect(strong.tagName).toBe("STRONG");
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();
  });

  it("renders `code` as <code> without the backticks", () => {
    render(<ReleaseNotes body={NOTES} />);
    const code = screen.getByText("latest.json");
    expect(code.tagName).toBe("CODE");
  });

  it("joins consecutive plain lines into one paragraph", () => {
    render(<ReleaseNotes body={"First line.\nSecond line."} />);
    expect(screen.getByText("First line. Second line.")).toBeInTheDocument();
  });

  it("renders a [link](url) as a link without the brackets", () => {
    render(<ReleaseNotes body={"See [the speed page](https://pikos.app/speed)."} />);
    expect(screen.getByRole("link", { name: "the speed page" })).toHaveAttribute(
      "href",
      "https://pikos.app/speed"
    );
    expect(screen.queryByText(/\]\(/)).not.toBeInTheDocument();
  });
});

const PUBLISHED = import.meta.glob<string>("../../../../marketing/src/content/release-notes/*.md", {
  eager: true,
  import: "default",
  query: "?raw",
});
const FRONT_MATTER = /^---\n[\s\S]*?\n---\n/;
const UNDRAWN_MARKDOWN = /\*\*|`|\]\(|^\s*(#|[-*+] |\d+\. |>)|<\/?[a-z]/m;

describe("every published release note", () => {
  it("finds the notes", () => {
    expect(Object.keys(PUBLISHED).length).toBeGreaterThan(0);
  });

  it.each(Object.entries(PUBLISHED))("%s draws with no Markdown left over", (_path, file) => {
    const { container } = render(<ReleaseNotes body={file.replace(FRONT_MATTER, "")} />);

    for (const block of container.querySelectorAll("p, li")) {
      expect(block.textContent).not.toMatch(UNDRAWN_MARKDOWN);
    }
  });
});
