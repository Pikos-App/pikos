import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SidebarCount } from "./SidebarCount";

describe("SidebarCount", () => {
  it("shows its first count still", () => {
    render(<SidebarCount value={4} />);

    expect(screen.getByText("4")).not.toHaveClass("animate-count-change");
  });

  it("fades a changed count in", () => {
    const { rerender } = render(<SidebarCount value={4} />);

    rerender(<SidebarCount value={5} />);

    expect(screen.getByText("5")).toHaveClass("animate-count-change");
  });

  it("stays still when a count past 99 changes but still reads 99+", () => {
    const { rerender } = render(<SidebarCount value={120} />);

    rerender(<SidebarCount value={121} />);

    expect(screen.getByText("99+")).not.toHaveClass("animate-count-change");
  });
});
