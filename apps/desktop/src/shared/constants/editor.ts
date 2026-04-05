// Editor layout and attribute constants.

import type { LineWidth } from "@/shared/context/EditorSettingsContext";

/** Tailwind max-width classes for editor line width settings. */
export const LINE_WIDTH_CLASS: Record<LineWidth, string> = {
  default: "max-w-[720px]",
  full: "max-w-none",
  narrow: "max-w-[560px]",
  wide: "max-w-[880px]",
};

/** HTML attributes applied to the ProseMirror contenteditable element. */
export const EDITOR_ATTRIBUTES = {
  "aria-label": "Page content",
  "aria-multiline": "true",
  "aria-placeholder": "Start writing, or press / for commands",
  autocapitalize: "off",
  autocomplete: "off",
  autocorrect: "off",
  class: "editor-content",
  role: "textbox",
} as const;
