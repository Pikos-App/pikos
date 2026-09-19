import { STORAGE_KEYS } from "@/shared/constants/storage";
import { createSettingsContext } from "@/shared/context/createSettingsContext";
import { stepTextSize, TEXT_SIZES, type TextSize } from "@/shared/context/textSizes";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

export type LineWidth = "narrow" | "default" | "wide" | "full";

export const EDITOR_FONT_SIZES = TEXT_SIZES;

export type EditorFontSize = TextSize;

export const DEFAULT_EDITOR_FONT_SIZE: EditorFontSize = 14;

export const stepEditorFontSize = stepTextSize;

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
