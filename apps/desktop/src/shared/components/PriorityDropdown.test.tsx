import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PriorityDropdown } from "./PriorityDropdown";

afterEach(cleanup);

function openMenu(priority: 0 | 1 | 2 | 3 | 4) {
  const onSelect = vi.fn();
  render(<PriorityDropdown onSelect={onSelect} priority={priority} />);
  fireEvent.pointerDown(screen.getByRole("button", { name: /^Priority:/ }), {
    button: 0,
    ctrlKey: false,
  });
  return { onSelect };
}

describe("PriorityDropdown", () => {
  it("names the row that clears a priority", async () => {
    const { onSelect } = openMenu(2);

    fireEvent.click(await screen.findByRole("menuitem", { name: "No priority" }));

    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it("draws Low's mark as a full dot, not a speck", async () => {
    openMenu(0);

    const low = await screen.findByRole("menuitem", { name: /Low/ });

    expect(low.textContent).toBe("•Low");
  });
});
