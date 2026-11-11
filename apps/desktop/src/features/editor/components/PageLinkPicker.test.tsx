import { act, render, screen } from "@testing-library/react";
import type { SuggestionKeyDownProps } from "@tiptap/suggestion";
import { createRef, type RefObject } from "react";
import { describe, expect, it, vi } from "vitest";

import { PageLinkList, type PageLinkListRef } from "./PageLinkPicker";

const ITEMS = [
  { id: "a", title: "Garden plans" },
  { id: "b", title: "Trip plans" },
];

function press(ref: RefObject<PageLinkListRef | null>, key: string): boolean {
  const props = { event: new KeyboardEvent("keydown", { key }) } as SuggestionKeyDownProps;
  let handled = false;
  act(() => {
    handled = ref.current!.onKeyDown(props);
  });
  return handled;
}

describe("PageLinkList", () => {
  it("lists the matching pages as options", () => {
    render(<PageLinkList command={vi.fn()} items={ITEMS} />);

    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Garden plans",
      "Trip plans",
    ]);
  });

  it("links the page the arrows land on when Enter is pressed", () => {
    const command = vi.fn();
    const ref = createRef<PageLinkListRef>();
    render(<PageLinkList command={command} items={ITEMS} ref={ref} />);

    press(ref, "ArrowDown");
    press(ref, "Enter");

    expect(command).toHaveBeenCalledWith(ITEMS[1]);
  });

  it("says when no page matches, and lets Enter through to the editor", () => {
    const ref = createRef<PageLinkListRef>();
    render(<PageLinkList command={vi.fn()} items={[]} ref={ref} />);

    expect(screen.getByRole("status").textContent).toBe("No pages match");
    expect(press(ref, "Enter")).toBe(false);
  });
});
