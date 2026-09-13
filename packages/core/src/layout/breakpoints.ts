// Width → layout decisions. Pure so both the desktop `useLayoutMode` hook and
// any future mobile shell can read the same thresholds.

export type LayoutMode = "xl" | "lg" | "md" | "sm";

/** Width thresholds in px. A mode applies when width ≥ its threshold. */
export const BREAKPOINTS = {
  lg: 1024,
  md: 760,
  sm: 0,
  xl: 1280,
} as const;

export function getLayoutMode(width: number): LayoutMode {
  if (width >= BREAKPOINTS.xl) return "xl";
  if (width >= BREAKPOINTS.lg) return "lg";
  if (width >= BREAKPOINTS.md) return "md";
  return "sm";
}

export function getCalendarDayCount(mode: LayoutMode): number {
  if (mode === "xl") return 7;
  if (mode === "lg" || mode === "md") return 5;
  return 3;
}

export function shouldHideSidebar(mode: LayoutMode): boolean {
  return mode === "md" || mode === "sm";
}

export function shouldOverlayPageList(mode: LayoutMode): boolean {
  return mode === "sm";
}
