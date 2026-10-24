import { useRef, useState } from "react";

export type RowPickerKind = "pick-date" | "tags" | "repeat";

export interface OpenRowPicker {
  kind: RowPickerKind;
  anchor: HTMLElement;
}

/**
 * Which picker a row's menu asked for. It opens only once the menu has closed and handed focus
 * back to the row: opened from the menu item itself, the closing menu took focus from it.
 */
export function useRowPicker() {
  const requested = useRef<RowPickerKind | null>(null);
  const [open, setOpen] = useState<OpenRowPicker | null>(null);

  function request(kind: RowPickerKind) {
    requested.current = kind;
  }

  function openRequested(anchor: HTMLElement | null) {
    const kind = requested.current;
    requested.current = null;
    if (kind === null || anchor === null) return;

    setOpen({ anchor, kind });
  }

  return { close: () => setOpen(null), open, openRequested, request };
}
