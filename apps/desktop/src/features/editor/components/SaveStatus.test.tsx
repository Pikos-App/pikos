import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { renderWithProviders } from "@/test/renderWithProviders";

import { SaveStatus } from "./SaveStatus";

afterEach(cleanup);

function renderStatus(contentSaveError: Error | null, onRetryContent = vi.fn()) {
  renderWithProviders(
    <TooltipProvider>
      <SaveStatus
        contentSaveError={contentSaveError}
        isSaving={false}
        onRetryContent={onRetryContent}
        pageId="p1"
      />
    </TooltipProvider>
  );
  return onRetryContent;
}

describe("SaveStatus", () => {
  it("draws nothing while saves succeed", () => {
    renderStatus(null);

    expect(screen.queryByRole("button", { name: "Save failed. Click to retry" })).toBeNull();
  });

  it("shows a failed content save and retries it on click", () => {
    const onRetry = renderStatus(new Error("disk full"));

    fireEvent.click(screen.getByRole("button", { name: "Save failed. Click to retry" }));

    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByText("Failed to save. Please try again.")).toBeTruthy();
  });
});
