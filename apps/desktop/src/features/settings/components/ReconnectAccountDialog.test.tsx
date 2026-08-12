import type { SyncAccount } from "@pikos/core";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReconnectAccountDialog } from "./ReconnectAccountDialog";

const CALDAV: SyncAccount = {
  authKind: "basic",
  createdAt: "2026-06-19T00:00:00Z",
  displayName: "me@example.com · https://caldav.example.com",
  id: "a1",
  provider: "caldav",
  reconnectNeeded: true,
};

function render(props?: {
  account?: SyncAccount;
  onReconnect?: (password: string) => Promise<void>;
  onReconnectGoogle?: () => Promise<void>;
  onOpenChange?: (open: boolean) => void;
}) {
  return rtlRender(
    <ReconnectAccountDialog
      account={props?.account ?? CALDAV}
      onOpenChange={props?.onOpenChange ?? (() => {})}
      onReconnect={props?.onReconnect ?? (() => Promise.resolve())}
      onReconnectGoogle={props?.onReconnectGoogle ?? (() => Promise.resolve())}
      open
    />
  );
}

afterEach(cleanup);

describe("ReconnectAccountDialog", () => {
  it("submits only the password — the server and username are never re-collected", async () => {
    const onReconnect = vi.fn(() => Promise.resolve());
    const onOpenChange = vi.fn();
    render({ onOpenChange, onReconnect });

    expect(screen.queryByLabelText("Server URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("App password"), { target: { value: "new-pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    await waitFor(() => expect(onReconnect).toHaveBeenCalledWith("new-pw"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("gates submit on a password", () => {
    render();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeDisabled();
  });

  it("stays open and shows the failure when the password is rejected", async () => {
    const onOpenChange = vi.fn();
    render({
      onOpenChange,
      onReconnect: () => Promise.reject(new Error("Bad credentials")),
    });

    fireEvent.change(screen.getByLabelText("App password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    await waitFor(() => expect(screen.getByText("Bad credentials")).toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("re-runs the grant for a Google account instead of asking for a password", () => {
    const onReconnectGoogle = vi.fn(() => Promise.resolve());
    render({
      account: { ...CALDAV, displayName: "you@gmail.com", provider: "google" },
      onReconnectGoogle,
    });

    expect(screen.queryByLabelText("App password")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    expect(onReconnectGoogle).toHaveBeenCalled();
  });
});
