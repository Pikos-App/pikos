// Exports run through the storage adapter, which under VITE_TEST_MODE is the
// MockStorageAdapter the provider tree builds. Spying on the prototype reads
// the arguments each Export button sends without stubbing the whole context.

import { MockStorageAdapter } from "@pikos/core";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/renderWithProviders";

import { CalendarSyncSettings } from "./CalendarSyncSettings";
import { DataSettings } from "./DataSettings";

const exportWorkspace = vi.spyOn(MockStorageAdapter.prototype, "exportWorkspace");

afterEach(() => {
  cleanup();
  exportWorkspace.mockClear();
});

function renderDataSettings(withSyncPanel = false) {
  return renderWithProviders(
    <>
      {withSyncPanel && <CalendarSyncSettings />}
      <DataSettings
        importState={{ step: "idle" }}
        lastImportResult={null}
        onClearImport={() => {}}
        onUndoImport={() => Promise.resolve()}
        parseCSVFile={() => {}}
        parseMarkdownDir={() => Promise.resolve()}
        resetImport={() => {}}
        usageStats={null}
      />
    </>
  );
}

/** Enabling a calendar is the only path that creates an external-calendar folder. */
async function connectAndEnableCalendar() {
  fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
  fireEvent.click(await screen.findByText("CalDAV"));
  fireEvent.change(screen.getByLabelText("Server URL"), {
    target: { value: "https://caldav.example.com" },
  });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "me@example.com" } });
  fireEvent.change(screen.getByLabelText("App password"), { target: { value: "app-pw-1234" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  fireEvent.click(await screen.findByRole("switch", { name: "Sync Personal" }));
}

describe("DataSettings export", () => {
  it("leaves the calendar toggle out until a calendar is synced", async () => {
    renderDataSettings();
    expect(await screen.findByRole("button", { name: "Export as CSV" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Include synced calendar events/ })).toBeNull();
  });

  it("exports without the synced calendar's events by default", async () => {
    renderDataSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Export as CSV" }));

    await waitFor(() =>
      expect(exportWorkspace).toHaveBeenCalledWith("csv", { includeSynced: false })
    );
  });

  it("exports the calendar without the synced events by default", async () => {
    renderDataSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Export as Calendar" }));

    await waitFor(() =>
      expect(exportWorkspace).toHaveBeenCalledWith("ics", { includeSynced: false })
    );
  });

  it("includes them in every page export once the toggle is on", async () => {
    renderDataSettings(true);
    await connectAndEnableCalendar();

    fireEvent.click(await screen.findByLabelText("Include synced calendar events"));
    fireEvent.click(screen.getByRole("button", { name: "Export as CSV" }));
    fireEvent.click(screen.getByRole("button", { name: "Export as Markdown" }));
    fireEvent.click(screen.getByRole("button", { name: "Export as Calendar" }));

    await waitFor(() => {
      expect(exportWorkspace).toHaveBeenCalledWith("csv", { includeSynced: true });
      expect(exportWorkspace).toHaveBeenCalledWith("markdown", { includeSynced: true });
      expect(exportWorkspace).toHaveBeenCalledWith("ics", { includeSynced: true });
    });
  });
});
