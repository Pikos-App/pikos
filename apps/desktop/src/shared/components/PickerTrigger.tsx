import type { ReactNode } from "react";

import { PopoverAnchor, PopoverTrigger } from "@/components/ui/popover";

/**
 * A picker opened from somewhere other than its own chip, such as a list row's menu. It is
 * open for as long as the caller renders it, sits beside `anchor`, and draws no chip.
 */
export interface AnchoredOpen {
  anchor: HTMLElement;
  onClose: () => void;
}

/** The picker's own chip, or with `anchored` an invisible anchor at the caller's element. */
export function PickerTrigger({
  anchored,
  children,
}: {
  anchored: AnchoredOpen | undefined;
  children: ReactNode;
}) {
  if (anchored) return <PopoverAnchor virtualRef={{ current: anchored.anchor }} />;

  return <PopoverTrigger asChild>{children}</PopoverTrigger>;
}
