import { DEFAULT_EVENT_COLOR } from "@pikos/core";
import type { CSSProperties } from "react";

/**
 * Shared Tailwind classes for event chips — compact timed blocks, all-day bars and
 * month chips all wear them, so they stay visually identical.
 *
 * Lives in the app rather than in `@pikos/core` beside the geometry it pairs with:
 * Tailwind generates a utility only when it finds the literal while scanning, and its
 * scan does not reach `packages/core`. Declared there, `h-[19px]` produced no rule at
 * all and every chip silently collapsed to its text height — the class was present in
 * the DOM and did nothing, which is why it read as a styling bug rather than a missing
 * one. `ALL_DAY_BAR_HEIGHT` still owns the number; these two must agree.
 */
export const CHIP_BASE_CLASSES =
  "type-body-sm h-[19px] overflow-hidden truncate rounded-sm border-l-[2px] px-1.5 leading-none font-medium text-foreground transition-[opacity,box-shadow] hover:opacity-80 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" as const;

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
