import type { PagePriority } from "@pikos/core";

export const PRIORITY_LABELS: Record<PagePriority, string> = {
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

export const NLP_PRIORITY_MAP: Record<string, PagePriority> = {
  high: 2,
  low: 4,
  medium: 3,
  urgent: 1,
};

export const PRIORITY_COLORS: Record<PagePriority, string> = {
  0: "text-muted-foreground",
  1: "text-red-500",
  2: "text-orange-500",
  3: "text-yellow-500",
  4: "text-blue-500",
};
