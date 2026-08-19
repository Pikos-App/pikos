import { getLayoutMode, type LayoutMode } from "@pikos/core";

import { useWindowWidth } from "@/shared/hooks/useWindowWidth";

export function useLayoutMode(): LayoutMode {
  return getLayoutMode(useWindowWidth());
}
