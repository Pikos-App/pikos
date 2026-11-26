// How the view cache loads and keeps lists. An e2e lane can set the global below, which shrinks the
// window and budget so every test pages, evicts and refetches, and checks each list against the
// database.

import { IS_TEST_MODE } from "@/shared/constants/testMode";

export interface ViewCacheConfig {
  windowSize: number;
  budgetBytes: number;
  bodyBudgetBytes: number;
  shadow: boolean;
}

declare global {
  interface Window {
    __PIKOS_VIEW_CACHE__?: Partial<ViewCacheConfig>;
    __PIKOS_SHADOW_MISMATCHES__?: string[];
    __PIKOS_LIST_FETCHES__?: number;
    __PIKOS_BODY_READS__?: { hits: number; misses: number };
  }
}

const DEFAULTS: ViewCacheConfig = {
  bodyBudgetBytes: 32 * 1024 * 1024,
  budgetBytes: 64 * 1024 * 1024,
  shadow: false,
  windowSize: 100,
};

function readConfig(): ViewCacheConfig {
  const lane =
    IS_TEST_MODE && typeof window !== "undefined" ? window.__PIKOS_VIEW_CACHE__ : undefined;
  if (lane) return { ...DEFAULTS, shadow: true, ...lane };
  return DEFAULTS;
}

/** Read once: a lane's settings can't change under a running app. */
export const VIEW_CACHE: ViewCacheConfig = readConfig();
