// EditorPanel — right panel. Toggles between editor and calendar via Cmd+Shift+C.
// Sidebar toggle is a persistent button at the top-left corner of this panel —
// always accessible regardless of page state or which view is active.

import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CalendarView } from "@/features/calendar/CalendarView";
import { EditorPane } from "@/features/editor";
import { useUI } from "@/shared/context/UIContext";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

export function EditorPanel() {
  const ui = useUI();

  useKeyboardShortcut(
    "Mod+Shift+C",
    () => {
      ui.setRightPanel(ui.rightPanel === "editor" ? "calendar" : "editor");
    },
    { allowInInputs: true }
  );

  useKeyboardShortcut(
    "Mod+\\",
    () => {
      ui.setSidebarCollapsed(!ui.sidebarCollapsed);
    },
    { allowInInputs: true }
  );

  return (
    <div className="relative flex flex-1 flex-col bg-background">
      {/* Sidebar toggle — persistent, always visible, top-left corner of editor panel */}
      <div className="absolute top-2 left-2 z-10">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={ui.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="rounded p-1 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-muted-foreground"
              onClick={() => ui.setSidebarCollapsed(!ui.sidebarCollapsed)}
            >
              {ui.sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {ui.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} ⌘\
          </TooltipContent>
        </Tooltip>
      </div>

      {ui.rightPanel === "editor" ? <EditorPane /> : <CalendarView />}
    </div>
  );
}
