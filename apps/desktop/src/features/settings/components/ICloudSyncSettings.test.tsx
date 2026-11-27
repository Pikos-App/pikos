import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ICloudSyncSettings } from "./ICloudSyncSettings";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

afterEach(cleanup);

function answers(state: { on: boolean; text: string; action: string }) {
  invoke.mockImplementation((command: string) =>
    Promise.resolve(command === "icloud_sync_state" ? state : null)
  );
}

describe("ICloudSyncSettings", () => {
  beforeEach(() => invoke.mockReset());

  // qa: CLOUD-120:3
  it("shows the switch on with the line the transport last sent", async () => {
    answers({ action: "none", on: true, text: "Up to date · checked 2 minutes ago" });

    render(<ICloudSyncSettings />);

    expect(await screen.findByText("Up to date · checked 2 minutes ago")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Sync with iCloud" })).toBeChecked();
  });

  it("turns sync off from the switch", async () => {
    answers({ action: "none", on: true, text: "Up to date" });
    render(<ICloudSyncSettings />);
    const toggle = await screen.findByRole("switch", { name: "Sync with iCloud" });
    await waitFor(() => expect(toggle).toBeChecked());

    fireEvent.click(toggle);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("icloud_sync_set", { on: false }));
  });

  it("offers to sync with a new account and does it when asked", async () => {
    answers({
      action: "useThisAccount",
      on: true,
      text: "This device is signed in to a different iCloud account, so sync is paused.",
    });
    render(<ICloudSyncSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Sync with this account" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("icloud_sync_act", undefined));
  });

  // qa: CLOUD-141:3
  it("copies the sync report the transport made", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    invoke.mockImplementation((command: string) =>
      Promise.resolve(
        command === "icloud_sync_report"
          ? "Sync on in pikos-1\nUp to date"
          : { action: "none", on: true, text: "Up to date" }
      )
    );
    render(<ICloudSyncSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));

    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("Sync on in pikos-1\nUp to date");
  });

  it("says why the switch failed instead of showing an object", async () => {
    invoke.mockImplementation((command: string) =>
      command === "icloud_sync_set"
        ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the plain { kind, message } object
          Promise.reject({ kind: "Db", message: "db error: database is locked" })
        : Promise.resolve({ action: "none", on: true, text: "Up to date" })
    );
    render(<ICloudSyncSettings />);
    const toggle = await screen.findByRole("switch", { name: "Sync with iCloud" });
    await waitFor(() => expect(toggle).toBeChecked());

    fireEvent.click(toggle);

    expect(
      await screen.findByText(/^Storage error while turning iCloud sync off/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/object Object|database is locked/)).toBeNull();
  });

  it("says the clipboard refused the report, apart from a report that couldn't be made", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
    });
    invoke.mockImplementation((command: string) =>
      Promise.resolve(
        command === "icloud_sync_report"
          ? "Sync on in pikos-1"
          : { action: "none", on: true, text: "Up to date" }
      )
    );
    render(<ICloudSyncSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));

    expect(
      await screen.findByText("Couldn't copy the report to the clipboard. Try again.")
    ).toBeInTheDocument();
  });
});
