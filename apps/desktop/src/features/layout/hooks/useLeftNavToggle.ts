import { useUI } from "@/shared/context/UIContext";

import { shouldOverlayPageList, useLayoutMode } from "../breakpoints";

interface LeftNavToggle {
  isOpen: boolean;
  /** Toggle visibility — routes to the right state for the current layout mode. */
  toggle: () => void;
}

/**
 * Unified toggle for the left nav. At xl/lg, `sidebarCollapsed` hides both
 * the folder sidebar and the page list. At md, the folder sidebar is force-
 * hidden so `sidebarCollapsed` only affects the inline page list. At sm, the
 * page list is an overlay drawer controlled by `pageListDrawerOpen`.
 */
export function useLeftNavToggle(): LeftNavToggle {
  const { pageListDrawerOpen, setPageListDrawerOpen, setSidebarCollapsed, sidebarCollapsed } =
    useUI();
  const mode = useLayoutMode();

  if (shouldOverlayPageList(mode)) {
    return {
      isOpen: pageListDrawerOpen,
      toggle: () => setPageListDrawerOpen(!pageListDrawerOpen),
    };
  }

  return {
    isOpen: !sidebarCollapsed,
    toggle: () => setSidebarCollapsed(!sidebarCollapsed),
  };
}
