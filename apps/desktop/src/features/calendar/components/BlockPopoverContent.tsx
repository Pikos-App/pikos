import type { ComponentProps } from "react";

import { PopoverContent } from "@/components/ui/popover";
import { useUI } from "@/shared/context/UIContext";

/**
 * A calendar block's popover, taken away outright while the calendar is hidden.
 *
 * The calendar hides under an Activity when a page opens, which disconnects every effect inside
 * it. A popover closing at that moment waits on a fade whose end its effect no longer hears, so it
 * stayed on screen for good, drawn at the window's top left where its hidden block collapsed to.
 * Not unmounted on every close: a popover's title is saved as it closes, and an unmount cut it off.
 */
export function BlockPopoverContent(props: ComponentProps<typeof PopoverContent>) {
  const { rightPanel } = useUI();
  const isCalendarHidden = rightPanel !== "calendar";
  if (isCalendarHidden) return null;

  return <PopoverContent {...props} />;
}
