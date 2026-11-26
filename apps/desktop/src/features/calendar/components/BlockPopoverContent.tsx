import type { ComponentProps } from "react";

import { PopoverContent } from "@/components/ui/popover";
import { useUI } from "@/shared/context/UIContext";

/**
 * A calendar block's popover, unmounted outright while the calendar is hidden.
 *
 * The calendar hides under an Activity when a page opens, which disconnects its effects. A
 * popover closing then waits on a fade whose end its effect no longer hears, and stays on
 * screen at the window's top left where its hidden block collapsed. It isn't unmounted on every
 * close: the title is saved as the popover closes, and an unmount would cut that off.
 */
export function BlockPopoverContent(props: ComponentProps<typeof PopoverContent>) {
  const { rightPanel } = useUI();
  const isCalendarHidden = rightPanel !== "calendar";
  if (isCalendarHidden) return null;

  return <PopoverContent {...props} />;
}
