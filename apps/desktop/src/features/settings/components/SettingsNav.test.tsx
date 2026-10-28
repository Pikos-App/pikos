import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { SettingsNav } from "./SettingsNav";

// Vite defines the build flag, which vitest's config doesn't, and the nav reads it on import.
vi.hoisted(() => vi.stubGlobal("__PIKOS_ICLOUD_SYNC__", false));

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
});
