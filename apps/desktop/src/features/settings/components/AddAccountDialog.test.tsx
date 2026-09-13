// AddAccountDialog — provider picker + the CalDAV form. Validates the submit
// gate, the failure path (stay open, show the error), and Back navigation.
// Rendered standalone with a spy onConnect; the happy path through the real
// adapter is covered by CalendarSyncSettings.test.tsx.

import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AddAccountDialog } from "./AddAccountDialog";

function render(props?: {
  googleAvailable?: boolean;
  onConnect?: (data: unknown) => Promise<void>;
  onConnectGoogle?: () => Promise<void>;
  onOpenChange?: (open: boolean) => void;
}) {
  return rtlRender(
    <AddAccountDialog
      googleAvailable={props?.googleAvailable ?? true}
      onConnect={props?.onConnect ?? (() => Promise.resolve())}
      onConnectGoogle={props?.onConnectGoogle ?? (() => Promise.resolve())}
      onOpenChange={props?.onOpenChange ?? (() => {})}
      open
    />
  );
}

afterEach(cleanup);

function fillForm() {
  fireEvent.change(screen.getByLabelText("Server URL"), {
    target: { value: "  https://caldav.example.com  " },
  });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "  me@example.com  " } });
  fireEvent.change(screen.getByLabelText("App password"), { target: { value: "app-pw" } });
}

describe("AddAccountDialog", () => {
  it("offers both providers", () => {
    render();
    expect(screen.getByText("CalDAV")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Google Calendar/ })).toBeEnabled();
  });

  // See `googleAvailable` in useCalendarSync.ts for why: shown-but-disabled, not
  // hidden, when the build carries no OAuth client.
  it("disables Google when the build carries no OAuth client", () => {
    render({ googleAvailable: false });
    expect(screen.getByRole("button", { name: /Google Calendar/ })).toBeDisabled();
    expect(screen.getByText("Not available in this build")).toBeInTheDocument();
  });

  it("starts the Google grant and waits on the browser", async () => {
    let finish: () => void = () => {};
    const onConnectGoogle = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const onOpenChange = vi.fn();
    render({ onConnectGoogle, onOpenChange });
    fireEvent.click(screen.getByRole("button", { name: /Google Calendar/ }));

    expect(onConnectGoogle).toHaveBeenCalled();
    // Why the waiting state exists: see submitGoogle in AddAccountDialog.tsx.
    expect(
      await screen.findByText("Waiting for your browser. Finish signing in there.")
    ).toBeInTheDocument();

    finish();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("returns to the picker with an error when the Google grant fails", async () => {
    const onConnectGoogle = vi.fn().mockRejectedValue(new Error("Authorization was cancelled"));
    const onOpenChange = vi.fn();
    render({ onConnectGoogle, onOpenChange });
    fireEvent.click(screen.getByRole("button", { name: /Google Calendar/ }));

    expect(await screen.findByText("Authorization was cancelled")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("button", { name: /Google Calendar/ })).toBeEnabled();
  });

  it("keeps Connect disabled until every field is filled", () => {
    render();
    fireEvent.click(screen.getByText("CalDAV"));
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "https://caldav.example.com" },
    });
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();

    fillForm();
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  it("submits trimmed credentials", async () => {
    const onConnect = vi.fn().mockResolvedValue(undefined);
    render({ onConnect });
    fireEvent.click(screen.getByText("CalDAV"));
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(onConnect).toHaveBeenCalledWith({
        baseUrl: "https://caldav.example.com",
        displayName: "me@example.com · https://caldav.example.com",
        password: "app-pw",
        username: "me@example.com",
      })
    );
  });

  it("defaults a bare host to https://", async () => {
    const onConnect = vi.fn().mockResolvedValue(undefined);
    render({ onConnect });
    fireEvent.click(screen.getByText("CalDAV"));
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "caldav.icloud.com" },
    });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "me@example.com" } });
    fireEvent.change(screen.getByLabelText("App password"), { target: { value: "app-pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(onConnect).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: "https://caldav.icloud.com" })
      )
    );
  });

  it("shows the error and stays open when the connection fails", async () => {
    const onConnect = vi.fn().mockRejectedValue(new Error("401 Unauthorized"));
    const onOpenChange = vi.fn();
    render({ onConnect, onOpenChange });
    fireEvent.click(screen.getByText("CalDAV"));
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("401 Unauthorized")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("Back returns to the provider picker", () => {
    render();
    fireEvent.click(screen.getByText("CalDAV"));
    expect(screen.getByLabelText("Server URL")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByLabelText("Server URL")).not.toBeInTheDocument();
    expect(screen.getByText("CalDAV")).toBeInTheDocument();
  });
});
