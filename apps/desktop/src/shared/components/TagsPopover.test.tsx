import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
  it("does not leave the tag tooltip over the field you type into", async () => {
    setup(["home", "shopping"]);

    fireEvent.click(screen.getByRole("button", { name: /^Tags:/ }));

    expect(await screen.findByPlaceholderText("Search or create…")).toBeVisible();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
