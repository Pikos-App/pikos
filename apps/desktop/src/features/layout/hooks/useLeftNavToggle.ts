import { shouldOverlayPageList } from "@pikos/core";

import { useUI } from "@/shared/context/UIContext";

import { useLayoutMode } from "../breakpoints";
interface LeftNavToggle {
  isOpen: boolean;
  toggle: () => void;
}

/**
 * Unified toggle for the left nav. At xl/lg, `sidebarCollapsed` hides the folder sidebar and page list;
 * at md the sidebar is force-hidden, so it only affects the page list; at sm the page list is an
 * overlay drawer controlled by `pageListDrawerOpen`.
 */
export function useLeftNavToggle(): LeftNavToggle {
  const {
    focusZen,
    pageListDrawerOpen,
    setFocusZen,
    setPageListDrawerOpen,
    setSidebarCollapsed,
    sidebarCollapsed,
  } = useUI();
  const mode = useLayoutMode();

  if (shouldOverlayPageList(mode)) {
    return {
      isOpen: pageListDrawerOpen,
      toggle: () => setPageListDrawerOpen(!pageListDrawerOpen),
    };
  }

  const hidden = sidebarCollapsed || focusZen;
  return {
    isOpen: !hidden,
    toggle: () => {
      setFocusZen(false);
      setSidebarCollapsed(!hidden);
    },
  };
}
