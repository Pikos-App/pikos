import type { CSSProperties } from "react";

import { DEFAULT_EVENT_COLOR } from "./calendarConstants";

/** Accepts #RRGGBB or RRGGBB; falls back to muted indigo if the hex cannot be parsed. */
export function hexToRgba(hex: string, alpha: number): string {
  const cleaned = hex.startsWith("#") ? hex.slice(1) : hex;
  const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(cleaned);
  if (!result) return `rgba(99,102,241,${alpha})`;
  const r = parseInt(result[1]!, 16);
  const g = parseInt(result[2]!, 16);
  const b = parseInt(result[3]!, 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Inline `--event-color` style for chips. CSS derives the mode-aware
 * background (opaque color-mix with `--background`) and the full-saturation
 * left-edge accent — see app.css `--event-color` rules. Pages without a
 * folder colour fall back to DEFAULT_EVENT_COLOR so every chip routes
 * through the same opaque-fill path.
 *
 * Returns CSSProperties so React's `style` prop accepts the result. The cast
 * is required because custom CSS properties aren't part of CSSProperties.
 */
export function chipFolderStyle(folderColor?: string | null): CSSProperties {
  return { "--event-color": folderColor ?? DEFAULT_EVENT_COLOR } as CSSProperties;
}
