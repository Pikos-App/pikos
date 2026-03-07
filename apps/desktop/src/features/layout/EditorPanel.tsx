// EditorPanel — right panel. Toggles between editor and calendar via Cmd+Shift+C.

import { useUI } from "@/shared/context/UIContext";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";
import { useCallback } from "react";

export function EditorPanel() {
  const ui = useUI();

  const togglePanel = useCallback(() => {
    ui.setRightPanel(ui.rightPanel === "editor" ? "calendar" : "editor");
  }, [ui]);

  useKeyboardShortcut("Mod+Shift+C", togglePanel);

  return (
    <div className="flex flex-1 flex-col bg-background">
      <div className="p-4 text-xs text-muted-foreground">
        {ui.rightPanel === "editor" ? "Editor" : "Calendar"}
      </div>
    </div>
  );
}
