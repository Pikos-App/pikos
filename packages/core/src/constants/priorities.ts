import type { PagePriority } from "../types";

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

// Every surface that draws a priority reads these two tables, so a level is one colour wherever it
// appears. Only Urgent and High take a hue; Medium and Low are told apart by their marks, because a
// third and fourth hue either fail contrast as text or land beside due-soon amber.
export const PRIORITY_COLORS: Record<PagePriority, string> = {
  0: "text-subtle",
  1: "text-priority-urgent",
  2: "text-due-soon",
  3: "text-muted-foreground",
  4: "text-subtle",
};

// A checkbox's outline, where High takes the bright amber: dark amber is for text only. These go
// in an inline style, so they name the raw tokens: `--color-status-*` live in `@theme inline`,
// which Tailwind folds into its classes without defining them on the page.
export const PRIORITY_CHECKBOX_COLORS: Record<PagePriority, string | undefined> = {
  0: undefined,
  1: "var(--priority-urgent)",
  2: "var(--status-due-soon)",
  3: undefined,
  4: undefined,
};
