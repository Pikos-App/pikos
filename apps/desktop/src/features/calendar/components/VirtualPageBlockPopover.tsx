// VirtualPageBlockPopover — read-only metadata popover for virtual rrule occurrences.
// Shows page metadata without editing. Actions: open page, skip this occurrence.

import type { VirtualOccurrence } from "@pikos/core";
import { rruleToLabel } from "@pikos/core";
import { CalendarX, ExternalLink } from "lucide-react";

import { TooltipIconButton } from "@/shared/components/TooltipIconButton";
import { PRIORITY_LABELS } from "@/shared/constants/priorities";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useKeyboardScope, useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

interface VirtualPageBlockPopoverProps {
  page: VirtualOccurrence;
  onSkip: () => void;
}

export function VirtualPageBlockPopover({ onSkip, page }: VirtualPageBlockPopoverProps) {
  const { folders, recurrenceRules } = useWorkspace();
  const { openPage } = useUI();

  useKeyboardScope("modal");
  useKeyboardShortcut("Mod+Shift+D", () => onSkip(), { allowInInputs: true, scope: "modal" });

  const rule = recurrenceRules.find((r) => r.id === page.ruleId);
  const folder = folders.find((f) => f.id === page.folderId);
  const cadenceLabel = rule ? rruleToLabel(rule.rrule) : null;

  return (
    <div className="flex flex-col gap-3">
      {/* Title (read-only) */}
      <p className="text-sm font-medium text-foreground">{page.title || "Untitled"}</p>

      {/* Metadata rows (read-only) */}
      <div className="flex flex-col gap-2">
        {folder && (
          <div className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Folder</span>
            <span className="text-sm text-muted-foreground">{folder.name}</span>
          </div>
        )}

        <div className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Date</span>
          <span className="text-sm text-muted-foreground">{page.scheduledStart}</span>
        </div>

        {page.priority > 0 && (
          <div className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Priority</span>
            <span className="text-sm text-muted-foreground">
              {PRIORITY_LABELS[page.priority] ?? "None"}
            </span>
          </div>
        )}

        {cadenceLabel && (
          <div className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Repeats</span>
            <span className="text-sm text-muted-foreground">{cadenceLabel}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between border-t border-border/40 pt-1">
        <button
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/60 transition-colors hover:text-foreground focus:outline-none"
          onClick={(e) => {
            e.stopPropagation();
            openPage(page.id);
          }}
        >
          <ExternalLink size={11} />
          Open page
        </button>
        <div className="flex items-center gap-2">
          <TooltipIconButton
            className="inline-flex items-center gap-1 text-xs text-muted-foreground/40 transition-colors hover:text-destructive focus:outline-none"
            icon={<CalendarX size={11} />}
            label="Skip this occurrence"
            onClick={onSkip}
            shortcut="mod+shift+d"
          />
        </div>
      </div>
    </div>
  );
}
