// RightPanelHeader — persistent top bar for the right panel (editor and calendar).
// Sidebar collapse toggle on the left, view toggle on the right, children in the center.

import { Calendar, FileText, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { KeyboardShortcut } from "@/shared/components/KeyboardShortcut";
import { TooltipIconButton } from "@/shared/components/TooltipIconButton";
import { useUI } from "@/shared/context/UIContext";

interface RightPanelHeaderProps {
  children?: ReactNode;
}

export function RightPanelHeader({ children }: RightPanelHeaderProps) {
  const ui = useUI();

  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-border pr-3 pl-2">
      {/* Sidebar toggle */}
      <TooltipIconButton
        className="rounded p-1 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-muted-foreground"
        icon={ui.sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        label={ui.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={() => ui.setSidebarCollapsed(!ui.sidebarCollapsed)}
        shortcut="mod+\"
      />

      {/* Center slot — view-specific content */}
      <div className="flex flex-1 items-center">{children}</div>

      {/* View toggle */}
      <div className="flex items-center gap-0.5 rounded-md border border-border/50 bg-background">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label="Editor view"
              aria-pressed={ui.rightPanel === "editor"}
              className={cn(
                "rounded p-1 transition-colors",
                ui.rightPanel === "editor"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground/50 hover:bg-accent hover:text-muted-foreground"
              )}
              onClick={() => ui.setRightPanel("editor")}
            >
              <FileText size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <span className="inline-flex items-center gap-1.5">
              Editor <KeyboardShortcut shortcut="mod+shift+c" />
            </span>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label="Calendar view"
              aria-pressed={ui.rightPanel === "calendar"}
              className={cn(
                "rounded p-1 transition-colors",
                ui.rightPanel === "calendar"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground/50 hover:bg-accent hover:text-muted-foreground"
              )}
              onClick={() => ui.setRightPanel("calendar")}
            >
              <Calendar size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <span className="inline-flex items-center gap-1.5">
              Calendar <KeyboardShortcut shortcut="mod+shift+c" />
            </span>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
