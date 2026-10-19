import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { SettingsNav } from "./SettingsNav";

// qa: CLOUD-124:2
it("offers no iCloud section in a build without iCloud sync, which the release build is", () => {
  render(
    <TooltipProvider>
      <SettingsNav active="general" onClose={() => {}} onNavigate={() => {}} />
    </TooltipProvider>
  );

  expect(screen.getByRole("button", { name: "Calendar sync" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "iCloud" })).not.toBeInTheDocument();
});
