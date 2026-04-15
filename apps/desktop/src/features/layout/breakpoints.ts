// Layout breakpoints — drive panel visibility and calendar density as the
// window shrinks. Pure functions so behavior is testable without React.

import { useWindowWidth } from "@/shared/hooks/useWindowWidth";

/** Layout modes, ordered from most → least space. */
export type LayoutMode = "xl" | "lg" | "md" | "sm";

/** Width thresholds in px. A mode applies when width ≥ its threshold. */
export const BREAKPOINTS = {
  lg: 1024,
  md: 760,
  sm: 0,
  xl: 1280,
} as const;

/** Pure: maps a window width to the active layout mode. */
export function getLayoutMode(width: number): LayoutMode {
  if (width >= BREAKPOINTS.xl) return "xl";
  if (width >= BREAKPOINTS.lg) return "lg";
  if (width >= BREAKPOINTS.md) return "md";
  return "sm";
}

/** Pure: how many calendar days to show for a given layout mode. */
export function getCalendarDayCount(mode: LayoutMode): number {
  if (mode === "xl") return 7;
  if (mode === "lg" || mode === "md") return 5;
  return 3;
}

/** Pure: true when the left folder sidebar should be hidden. */
export function shouldHideSidebar(mode: LayoutMode): boolean {
  return mode === "md" || mode === "sm";
}

/** Pure: true when the middle page list should become an overlay drawer. */
export function shouldOverlayPageList(mode: LayoutMode): boolean {
  return mode === "sm";
}

/** React hook: current layout mode, updating on window resize. */
export function useLayoutMode(): LayoutMode {
  return getLayoutMode(useWindowWidth());
}
