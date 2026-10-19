import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { SettingsNav } from "./SettingsNav";

afterEach(cleanup);

function renderNav(isLocked: boolean) {
  const onNavigate = vi.fn();
  render(
    <TooltipProvider>
      <SettingsNav active="data" isLocked={isLocked} onClose={vi.fn()} onNavigate={onNavigate} />
    </TooltipProvider>
  );
  return onNavigate;
}

describe("SettingsNav", () => {
  it("moves to another section", () => {
    const onNavigate = renderNav(false);

    fireEvent.click(screen.getByRole("button", { name: "General" }));

    expect(onNavigate).toHaveBeenCalledWith("general");
  });

  it("keeps to the open section while locked", () => {
    renderNav(true);

    expect(screen.getByRole("button", { name: "General" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Data" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close settings" })).toBeEnabled();
  });

  // qa: CLOUD-124:2
  it("offers no iCloud section in a build without iCloud sync, which the release build is", () => {
    renderNav(false);

    expect(screen.getByRole("button", { name: "Calendar sync" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "iCloud" })).not.toBeInTheDocument();
  });
});
