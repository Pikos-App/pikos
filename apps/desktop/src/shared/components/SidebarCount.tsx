import { useState } from "react";

import { cn } from "@/lib/utils";

/** A sidebar entry's page count. A change fades the new number in, but only a
 *  number already on screen: the counts arrive just after startup, and a whole
 *  sidebar fading in then is motion on the startup path. */
export function SidebarCount({ value }: { value: number }) {
  const label = value > 99 ? "99+" : String(value);
  const [shownLabel, setShownLabel] = useState(label);
  const [hasChanged, setHasChanged] = useState(false);

  const isNewLabel = label !== shownLabel;
  if (isNewLabel) {
    setShownLabel(label);
    setHasChanged(true);
  }

  return (
    <span
      className={cn(
        "type-ui-sm shrink-0 text-subtle tabular-nums",
        hasChanged && "animate-count-change"
      )}
      // Remounting replays the animation on every change, not just the first.
      key={label}
    >
      {label}
    </span>
  );
}
