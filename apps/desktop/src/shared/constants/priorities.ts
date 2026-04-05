// Shared priority labels and display config.
// Single source of truth — used by popovers, search, import, dropdowns.

import type { PagePriority } from "@pikos/core";

/** Human-readable priority labels keyed by numeric priority. */
export const PRIORITY_LABELS: Record<PagePriority, string> = {
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

/** Maps NLP priority words to numeric PagePriority values. Used by QuickAdd and import parsers. */
export const NLP_PRIORITY_MAP: Record<string, PagePriority> = {
  high: 2,
  low: 4,
  medium: 3,
  urgent: 1,
};

/** Tailwind text color classes for each priority level. */
export const PRIORITY_COLORS: Record<PagePriority, string> = {
  0: "text-muted-foreground",
  1: "text-red-500",
  2: "text-orange-500",
  3: "text-yellow-500",
  4: "text-blue-500",
};
