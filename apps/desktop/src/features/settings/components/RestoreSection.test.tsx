// Restoring is the one destructive action in the app that is *meant* to replace
// everything, so what matters is that it cannot happen by accident and that a
// refusal leaves a working app behind.

import { StorageError } from "@pikos/core";
import { MockStorageAdapter } from "@pikos/core/testing";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { renderWithProviders } from "@/test/renderWithProviders";

import { RestoreSection } from "./RestoreSection";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Harness({ onReady }: { onReady: (ws: ReturnType<typeof useWorkspace>) => void }) {
  onReady(useWorkspace());
  return <RestoreSection />;
}

async function render() {
  let ws!: ReturnType<typeof useWorkspace>;
  const utils = renderWithProviders(<Harness onReady={(w) => (ws = w)} />);
  await act(async () => {
    await ws.selectWorkspace();
  });
  return utils;
}

describe("RestoreSection", () => {
  it("lists what each snapshot was taken ahead of, not its filename", async () => {
    await render();

    await waitFor(() =>
      expect(screen.getByText("Before an update changed the workspace")).toBeInTheDocument()
    );
    expect(screen.getByText("Before an import")).toBeInTheDocument();
    // The filename is an implementation detail of where it landed on disk.
    expect(screen.queryByText(/pre-migration-/)).not.toBeInTheDocument();
  });

  it("does not restore until the confirmation is accepted", async () => {
    const restore = vi.spyOn(MockStorageAdapter.prototype, "restoreBackup");
    await render();
    await waitFor(() => expect(screen.getByText("Before an import")).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: /^Restore the backup/ })[0]!);

    expect(restore).not.toHaveBeenCalled();
    expect(screen.getByText(/Restore the workspace from/)).toBeInTheDocument();
  });

  it("says the app will restart and that nothing is thrown away", async () => {
    await render();
    await waitFor(() => expect(screen.getByText("Before an import")).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: /^Restore the backup/ })[0]!);

    expect(screen.getByText(/close, put this backup in place, and open again/)).toBeInTheDocument();
    expect(screen.getByText(/Everything you have now is kept/)).toBeInTheDocument();
  });

  it("restores the chosen snapshot once confirmed", async () => {
    const restore = vi
      .spyOn(MockStorageAdapter.prototype, "restoreBackup")
      .mockResolvedValue(undefined);
    await render();
    await waitFor(() => expect(screen.getByText("Before an import")).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: /^Restore the backup/ })[0]!);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore and restart" }));
      await Promise.resolve();
    });

    expect(restore).toHaveBeenCalledWith("pre-import-2026-07-02T09-00-00.sqlite");
  });

  // The backend refuses a damaged or too-new snapshot before it touches the
  // workspace, so the app is still running and has to say what happened.
  it("reports a refused restore instead of leaving the dialog spinning", async () => {
    vi.spyOn(MockStorageAdapter.prototype, "restoreBackup").mockRejectedValue(
      new StorageError("Corrupt", "the backup is damaged: page 3 is malformed")
    );
    await render();
    await waitFor(() => expect(screen.getByText("Before an import")).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: /^Restore the backup/ })[0]!);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore and restart" }));
      await Promise.resolve();
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/workspace file is damaged/i);
    // And the raw sqlx-shaped detail never reaches the screen.
    expect(screen.queryByText(/page 3 is malformed/)).not.toBeInTheDocument();
  });

  it("offers nothing to restore when no snapshot has been needed yet", async () => {
    vi.spyOn(MockStorageAdapter.prototype, "listBackups").mockResolvedValue([]);
    await render();

    expect(await screen.findByText(/No backups yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Restore the backup/ })).not.toBeInTheDocument();
  });
});
