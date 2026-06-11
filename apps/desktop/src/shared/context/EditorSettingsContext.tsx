import { createContext, type ReactNode, useContext } from "react";

import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

export type LineWidth = "narrow" | "default" | "wide" | "full";

export interface EditorSettingsValue {
  lineWidth: LineWidth;
  setLineWidth: (v: LineWidth) => void;
}

const EditorSettingsContext = createContext<EditorSettingsValue | null>(null);

export function EditorSettingsProvider({ children }: { children: ReactNode }) {
  const [lineWidth, setLineWidth] = useLocalStorage<LineWidth>("pikos:lineWidth", "default");

  const value: EditorSettingsValue = {
    lineWidth,
    setLineWidth,
  };

  return <EditorSettingsContext.Provider value={value}>{children}</EditorSettingsContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useEditorSettings(): EditorSettingsValue {
  const ctx = useContext(EditorSettingsContext);
  if (!ctx) throw new Error("useEditorSettings must be used within <EditorSettingsProvider>");
  return ctx;
}
