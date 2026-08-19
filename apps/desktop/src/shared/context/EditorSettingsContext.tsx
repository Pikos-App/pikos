import { createSettingsContext } from "@/shared/context/createSettingsContext";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

export type LineWidth = "narrow" | "default" | "wide" | "full";

export interface EditorSettingsValue {
  lineWidth: LineWidth;
  setLineWidth: (v: LineWidth) => void;
}

function useEditorSettingsValue(): EditorSettingsValue {
  const [lineWidth, setLineWidth] = useLocalStorage<LineWidth>("pikos:lineWidth", "default");

  return { lineWidth, setLineWidth };
}

const editorSettings = createSettingsContext("EditorSettings", useEditorSettingsValue);

export const EditorSettingsProvider = editorSettings.Provider;
export const useEditorSettings = editorSettings.useSettings;
