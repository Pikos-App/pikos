// How the view cache loads and keeps lists. An e2e lane can set the global below, which shrinks the
// window and budget so every test pages, evicts and refetches, and checks each list against the
// database.

import { IS_TEST_MODE } from "@/shared/constants/testMode";

export interface ViewCacheConfig {
  /** Rows per window. */
  windowSize: number;
  /** Bytes of rows and ids kept for views not on screen. */
  budgetBytes: number;
  /** Bytes of full pages kept for opening without a database call. */
  bodyBudgetBytes: number;
  /** Compare every cached view shown against a fresh query, and record a difference. */
  shadow: boolean;
}

declare global {
  interface Window {
    __PIKOS_VIEW_CACHE__?: Partial<ViewCacheConfig>;
    /** Every shadow check that found a cached view differing from the database. */
    __PIKOS_SHADOW_MISMATCHES__?: string[];
    /** List windows fetched so far, in a lane with the shadow check. */
    __PIKOS_LIST_FETCHES__?: number;
    /** Page opens served from memory or a prefetch, and those that waited on the database. */
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
