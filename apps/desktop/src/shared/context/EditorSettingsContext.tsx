import { STORAGE_KEYS } from "@/shared/constants/storage";
import { createSettingsContext } from "@/shared/context/createSettingsContext";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

export type LineWidth = "narrow" | "default" | "wide" | "full";

/** Body type sizes in px, ascending. This ladder is both what Settings offers
 *  and what ⌘+/⌘− step through, so a size missing here is reachable by neither.
 *  The top is 2× the default because that is the size the accessibility
 *  guidance asks text to reach, not because 28 renders particularly well. */
export const EDITOR_FONT_SIZES = [12, 14, 16, 18, 20, 22, 24, 28] as const;

export type EditorFontSize = (typeof EDITOR_FONT_SIZES)[number];

export const DEFAULT_EDITOR_FONT_SIZE: EditorFontSize = 14;

/** The next rung above (`1`) or below (`-1`) `size`, or `size` itself at either
 *  end. Matching on the value rather than on a ladder position keeps a size
 *  persisted by an older ladder steppable instead of stranding the shortcuts. */
export function stepEditorFontSize(size: EditorFontSize, direction: 1 | -1): EditorFontSize {
  if (direction === 1) return EDITOR_FONT_SIZES.find((s) => s > size) ?? size;
  const smaller = EDITOR_FONT_SIZES.filter((s) => s < size);
  return smaller[smaller.length - 1] ?? size;
}

export interface EditorSettingsValue {
  lineWidth: LineWidth;
  setLineWidth: (v: LineWidth) => void;
  /** Body type size in px. The editor's whole type scale is relative to it. */
  fontSize: EditorFontSize;
  setFontSize: (v: EditorFontSize) => void;
  stepFontSize: (direction: 1 | -1) => void;
}

function useEditorSettingsValue(): EditorSettingsValue {
  const [lineWidth, setLineWidth] = useLocalStorage<LineWidth>(STORAGE_KEYS.lineWidth, "default");
  const [fontSize, setFontSize] = useLocalStorage<EditorFontSize>(
    STORAGE_KEYS.editorFontSize,
    DEFAULT_EDITOR_FONT_SIZE
  );

  return {
    fontSize,
    lineWidth,
    setFontSize,
    setLineWidth,
    stepFontSize: (direction) => setFontSize((prev) => stepEditorFontSize(prev, direction)),
  };
}

const editorSettings = createSettingsContext("EditorSettings", useEditorSettingsValue);

export const EditorSettingsProvider = editorSettings.Provider;
export const useEditorSettings = editorSettings.useSettings;
