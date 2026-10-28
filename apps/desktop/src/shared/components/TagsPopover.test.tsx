// The tags menu is the only way to add or create a tag, and the tooltip that names
// the current tags is anchored to the control the menu opens over.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { TagsPopover } from "./TagsPopover";

function setup(selected: string[]) {
  return render(
    <TooltipProvider>
      <TagsPopover allTags={["home", "shopping"]} onToggle={() => {}} selected={selected} />
    </TooltipProvider>
  );
}

describe("TagsPopover", () => {
  afterEach(cleanup);

  it("does not leave the tag tooltip over the field you type into", async () => {
    setup(["home", "shopping"]);

    fireEvent.click(screen.getByRole("button", { name: /^Tags:/ }));

    expect(await screen.findByPlaceholderText("Search or create…")).toBeVisible();
    // The tooltip repeats what the open menu already shows, and it sits on top of it.
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("lists a tag the page has before any page carries it, ticked", async () => {
    setup(["health"]);

    fireEvent.click(screen.getByRole("button", { name: /^Tags:/ }));

    const item = await screen.findByRole("button", { name: "#health" });
    expect(item).toHaveClass("font-medium");
    expect(screen.queryByText("Create")).not.toBeInTheDocument();
  });
});
