// Read-only mirror metadata (location + attendees) for synced events.
// Verifies: nothing renders when both are empty; a single attendee shows the
// email verbatim; multiple attendees collapse to a count.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { SyncedEventDetails } from "./SyncedEventDetails";

// globals: false in vitest config → @testing-library's auto-cleanup never runs.
afterEach(cleanup);

function renderDetails(props: Parameters<typeof SyncedEventDetails>[0]) {
  return render(
    <TooltipProvider>
      <SyncedEventDetails {...props} />
    </TooltipProvider>
  );
}

describe("SyncedEventDetails", () => {
  it("renders nothing when both location and attendees are empty", () => {
    const { container } = renderDetails({ attendees: null, location: null });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the location", () => {
    renderDetails({ location: "Room 4B" });
    expect(screen.getByText("Room 4B")).toBeInTheDocument();
  });

  it("shows a single attendee's email verbatim", () => {
    renderDetails({ attendees: ["alex@example.com"] });
    expect(screen.getByText("alex@example.com")).toBeInTheDocument();
  });

  it("collapses multiple attendees to a count", () => {
    renderDetails({ attendees: ["alex@example.com", "sam@example.com", "jo@example.com"] });
    expect(screen.getByText("3 guests")).toBeInTheDocument();
  });
});
