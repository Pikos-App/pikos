// Roving-tabIndex ARIA toolbar: one button has tabIndex=0 at a time,
// ArrowLeft/Right moves focus within the group, Tab exits.
// Callers set initial tabIndex on each child button (first=0, rest=-1).

import { useRef } from "react";
import type React from "react";
import type { ReactNode } from "react";

interface IconToolbarProps {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}

export function IconToolbar({ "aria-label": ariaLabel, children, className }: IconToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);

  function getButtons() {
    if (!ref.current) return [];
    return Array.from(ref.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const buttons = getButtons();
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (idx === -1) return;
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const newIdx = Math.max(0, Math.min(buttons.length - 1, idx + dir));
    const next = buttons[newIdx];
    const current = buttons[idx];
    if (!next || !current || next === current) return;
    current.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  }

  return (
    <div
      aria-label={ariaLabel}
      className={className}
      onKeyDown={handleKeyDown}
      ref={ref}
      role="toolbar"
    >
      {children}
    </div>
  );
}
