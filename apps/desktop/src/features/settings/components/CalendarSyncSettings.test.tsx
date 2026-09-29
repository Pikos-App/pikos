// The Calendar Sync panel drives the real adapter commands end-to-end (against
// MockStorageAdapter in test mode). Covers add-account → toggle → status, and
// per-calendar recolour.

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/renderWithProviders";

import { CalendarSyncSettings } from "./CalendarSyncSettings";

// globals: false in vitest config → @testing-library's auto-cleanup never runs,
// so this file unmounts between tests by hand.
afterEach(cleanup);

async function connectAccount() {
  fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
  fireEvent.click(await screen.findByText("CalDAV"));
  fireEvent.change(screen.getByLabelText("Server URL"), {
    target: { value: "https://caldav.example.com" },
  });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "me@example.com" } });
  fireEvent.change(screen.getByLabelText("App password"), { target: { value: "app-pw-1234" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
}

async function connectGoogleAccount() {
  fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
  fireEvent.click(await screen.findByRole("button", { name: /Google Calendar/ }));
}

describe("CalendarSyncSettings", () => {
  it("shows the empty state before any account is connected", async () => {
    renderWithProviders(<CalendarSyncSettings />);
    expect(await screen.findByText(/No accounts connected yet/)).toBeInTheDocument();
  });

  it("connects a CalDAV account and lists its discovered calendars", async () => {
    renderWithProviders(<CalendarSyncSettings />);
    await connectAccount();

    expect(await screen.findByText("Personal")).toBeInTheDocument();
    expect(screen.getByText("Work")).toBeInTheDocument();
    // Discovered calendars start disabled → status dot reads "Off".
    expect(screen.getByLabelText("Personal: Off")).toBeInTheDocument();
    expect(screen.getByLabelText("Work: Off")).toBeInTheDocument();
  });

  // Two providers on one account list is the 0.4.0 shape; each keeps its own
  // calendars and its own disable scope, so neither can shadow the other.
  it("shows a CalDAV and a Google account side by side", async () => {
    renderWithProviders(<CalendarSyncSettings />);
    await connectAccount();
    expect(await screen.findByText("Personal")).toBeInTheDocument();

    await connectGoogleAccount();
    expect(await screen.findByText("Team")).toBeInTheDocument();
    expect(screen.getByText("Personal")).toBeInTheDocument();
    expect(screen.getByText("Work")).toBeInTheDocument();
  });

  it("disabling one account's calendar leaves the other account's alone", async () => {
    renderWithProviders(<CalendarSyncSettings />);
    await connectAccount();
    expect(await screen.findByText("Personal")).toBeInTheDocument();
    await connectGoogleAccount();
    expect(await screen.findByText("Team")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Sync Team" }));

    await waitFor(() => expect(screen.getByLabelText("Team: Stale")).toBeInTheDocument());
    expect(screen.getByLabelText("Personal: Off")).toBeInTheDocument();
    expect(screen.getByLabelText("Work: Off")).toBeInTheDocument();
  });

  it("toggles a calendar on, flipping its switch and status dot", async () => {
    renderWithProviders(<CalendarSyncSettings />);
    await connectAccount();

    const personal = await screen.findByRole("switch", { name: "Sync Personal" });
    expect(personal).toHaveAttribute("aria-checked", "false");

    fireEvent.click(personal);

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Sync Personal" })).toHaveAttribute(
        "aria-checked",
        "true"
      )
    );
    // Enabled but never polled in the mock → "Stale"; only Work stays "Off".
    expect(screen.getByLabelText("Personal: Stale")).toBeInTheDocument();
    expect(screen.getByLabelText("Work: Off")).toBeInTheDocument();
  });

  it("recolours a calendar from the palette", async () => {
    renderWithProviders(<CalendarSyncSettings />);
    await connectAccount();

    fireEvent.click(await screen.findByRole("button", { name: "Colour for Personal" }));
    fireEvent.click(screen.getByRole("button", { name: "Sage" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Colour for Personal" })).toHaveStyle({
        backgroundColor: "#A8CDB4",
      })
    );
  });
});
