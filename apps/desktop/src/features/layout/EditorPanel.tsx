// EditorPanel — right panel. Toggles between editor and calendar via Cmd+Shift+C.
// SidebarToggle button (top-left) collapses/expands both left panels via Cmd+\.

import { useUI } from "@/shared/context/UIContext";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useCallback } from "react";

export function EditorPanel() {
  const ui = useUI();

  const togglePanel = useCallback(() => {
    ui.setRightPanel(ui.rightPanel === "editor" ? "calendar" : "editor");
  }, [ui]);

  const toggleSidebar = useCallback(() => {
    ui.setSidebarCollapsed(!ui.sidebarCollapsed);
  }, [ui]);

  useKeyboardShortcut("Mod+Shift+C", togglePanel);
  useKeyboardShortcut("Mod+\\", toggleSidebar);

  return (
    <div className="flex flex-1 flex-col bg-background">
      <div className="flex items-center border-b border-border px-2 py-1.5">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={toggleSidebar}
                aria-label="Toggle sidebar"
              >
                {ui.sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Toggle sidebar ⌘\</TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <div className="flex-1" />

        <span className="pr-2 text-xs text-muted-foreground">
          {ui.rightPanel === "editor" ? "Editor" : "Calendar"}
        </span>
      </div>
    </div>
  );
}
