import { DEFAULT_EVENT_COLOR } from "@pikos/core";
import type { CSSProperties } from "react";

/**
 * Shared Tailwind classes for event chips: compact timed blocks, all-day bars and month chips.
 *
 * Lives in the app, not beside the geometry in `@pikos/core`: Tailwind generates a utility only
 * when its scan finds the literal, and the scan does not reach `packages/core`. Declared there,
 * `h-[19px]` produced no rule and every chip collapsed to its text height. `ALL_DAY_BAR_HEIGHT`
 * still owns the number; these two must agree.
 */
export const CHIP_HEIGHT_CLASS = "h-[calc(19px*var(--calendar-zoom,1))]";

export const CHIP_BASE_CLASSES =
  `type-body-sm ${CHIP_HEIGHT_CLASS} overflow-hidden truncate rounded-sm border-l-[2px] px-1.5 leading-none font-medium text-foreground transition-[opacity,box-shadow] hover:opacity-80 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none` as const;

/**
 * The time line inside a tinted block, and the drag ghosts that copy it. Measured against the
 * block's mixed fill, not the page: `text-subtle` falls to 3.5:1 on the pale palette colours in
 * dark, and this stays above 4.5:1 on every palette colour in both themes.
 */
export const BLOCK_TIME_TEXT_CLASS = "text-muted-foreground";

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
 * Inline `--event-color` for chips; app.css derives the opaque background and left-edge accent
 * from it. Folderless pages use DEFAULT_EVENT_COLOR. The cast is needed because custom
 * properties aren't part of CSSProperties.
 */
export function chipFolderStyle(folderColor?: string | null): CSSProperties {
  return { "--event-color": folderColor ?? DEFAULT_EVENT_COLOR } as CSSProperties;
}
