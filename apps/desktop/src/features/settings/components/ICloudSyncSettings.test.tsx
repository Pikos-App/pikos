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
});
