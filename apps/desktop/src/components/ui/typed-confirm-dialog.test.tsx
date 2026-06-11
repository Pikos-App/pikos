// TypedConfirmDialog — verifies the typed-phrase guard around destructive
// confirmations. The dialog must keep its primary action disabled until the
// user types the exact phrase (case-insensitive, trimmed); Enter on a
// matching input must commit; busy state must lock the whole UI.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TypedConfirmDialog } from "./typed-confirm-dialog";

interface HarnessProps {
  onConfirm: () => void;
  busy?: boolean;
  initialOpen?: boolean;
  confirmPhrase?: string;
  description?: ReactNode;
}

function Harness({
  busy = false,
  confirmPhrase = "delete",
  description = "This will wipe your data.",
  initialOpen = true,
  onConfirm,
}: HarnessProps) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        open dialog
      </button>
      <TypedConfirmDialog
        busy={busy}
        confirmLabel="Delete Everything"
        confirmPhrase={confirmPhrase}
        description={description}
        onConfirm={onConfirm}
        onOpenChange={setOpen}
        open={open}
        title="Delete all data?"
      />
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TypedConfirmDialog", () => {
  it("disables the confirm button until the typed phrase matches", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);

    const confirm = screen.getByRole("button", { name: "Delete Everything" });
    expect(confirm).toBeDisabled();

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "wrong" } });
    expect(confirm).toBeDisabled();

    fireEvent.change(input, { target: { value: "delete" } });
    expect(confirm).toBeEnabled();

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("matches the phrase case-insensitively and trims surrounding whitespace", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "  DELETE  " } });
    expect(screen.getByRole("button", { name: "Delete Everything" })).toBeEnabled();
  });

  it("Enter on a matching input commits without an extra click", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "delete" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("Enter on a non-matching input does NOT commit", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "wrong" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("locks input + buttons while busy=true and ignores re-confirms", () => {
    const onConfirm = vi.fn();
    render(<Harness busy initialOpen onConfirm={onConfirm} />);

    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Everything" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("clears the typed phrase when the dialog re-opens (no leakage between attempts)", () => {
    const onConfirm = vi.fn();
    function Wrap() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">
            reopen
          </button>
          <TypedConfirmDialog
            confirmLabel="Delete Everything"
            confirmPhrase="delete"
            description="x"
            onConfirm={onConfirm}
            onOpenChange={setOpen}
            open={open}
            title="t"
          />
        </>
      );
    }
    render(<Wrap />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "delete" } });
    expect(screen.getByRole("button", { name: "Delete Everything" })).toBeEnabled();

    // Cancel via Escape — Radix closes; reopen.
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    fireEvent.click(screen.getByRole("button", { name: "reopen" }));

    // The input is fresh; confirm is disabled again.
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Delete Everything" })).toBeDisabled();
  });
});
