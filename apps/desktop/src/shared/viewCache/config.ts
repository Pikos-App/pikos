// Whether lists load a window at a time from the view cache, and how big a window is. Off unless a
// build sets VITE_VIEW_CACHE, or an e2e lane sets the global below, which also shrinks the window
// and budget so every test pages, evicts and refetches. The full in-memory list goes when this
// becomes the only path.

import { IS_TEST_MODE } from "@/shared/constants/testMode";

export interface ViewCacheConfig {
  /** Rows per window. */
  windowSize: number;
  /** Bytes of rows and ids kept for views not on screen. */
  budgetBytes: number;
  /** Compare every cached view shown against a fresh query, and record a difference. */
  shadow: boolean;
}

declare global {
  interface Window {
    __PIKOS_VIEW_CACHE__?: Partial<ViewCacheConfig>;
    /** Every shadow check that found a cached view differing from the database. */
    __PIKOS_SHADOW_MISMATCHES__?: string[];
  }
}

const DEFAULTS: ViewCacheConfig = {
  budgetBytes: 64 * 1024 * 1024,
  shadow: false,
  windowSize: 100,
};

function readConfig(): ViewCacheConfig | null {
  const lane =
    IS_TEST_MODE && typeof window !== "undefined" ? window.__PIKOS_VIEW_CACHE__ : undefined;
  if (lane) return { ...DEFAULTS, shadow: true, ...lane };
  if (import.meta.env["VITE_VIEW_CACHE"] === "true") return DEFAULTS;
  return null;
}

/** Null while lists still come from the full in-memory list. Read once: the flag can't change
 *  under a running app. */
export const VIEW_CACHE: ViewCacheConfig | null = readConfig();
