import type { Folder, PageActionId, PagePriority, PageSummary } from "@pikos/core";
import { isDone, pageActions, PRIORITY_COLORS, writableFolders } from "@pikos/core";
import { Check } from "lucide-react";

import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { ALL_PRIORITIES, PRIORITY_CONFIG } from "@/shared/components/PriorityDropdown";

import { useExportPage } from "../hooks/useExportPage";
import type { SendDay } from "../hooks/usePageRowActions";

interface PageRowMenuProps {
  page: PageSummary;
  folders: Folder[];
  /** How many pages the menu acts on: the selection the row belongs to, or 1. */
  actsOn: number;
  onCloseAutoFocus: (e: Event) => void;
  onToggleStatus: () => void;
  onSendToDay: (day: SendDay) => void;
  onPriorityChange: (priority: PagePriority) => void;
  onMoveToFolder: (folderId: string | null) => void;
  onStopRepeating: () => void;
  onRename: () => void;
  /** Absent where the list can't clear a date, which withholds No date. */
  onClearDate?: (() => void) | undefined;
  onDelete: () => void;
}

/**
 * A page row's right-click menu, in the phone's order: the commonest edits first, then what
 * needs a choice from a list, then Rename and Delete. `pageActions` decides what is offered.
 */
export function PageRowMenu({
  actsOn,
  folders,
  onClearDate,
  onCloseAutoFocus,
  onDelete,
  onMoveToFolder,
  onPriorityChange,
  onRename,
  onSendToDay,
  onStopRepeating,
  onToggleStatus,
  page,
}: PageRowMenuProps) {
  const { exportPage } = useExportPage();
  const isOnePage = actsOn === 1;
  const offered = new Set(
    pageActions(page, actsOn)
      .filter((a) => a.offered)
      .map((a) => a.id)
  );
  const offers = (id: PageActionId) => offered.has(id);
  const canClearDate = offers("clear-date") && onClearDate !== undefined;
  const hasTopRow = offers("complete") || offers("send-today") || offers("send-tomorrow");

  return (
    <ContextMenuContent onCloseAutoFocus={onCloseAutoFocus}>
      {offers("complete") && (
        <ContextMenuItem onSelect={onToggleStatus}>
          {isDone(page) ? "Reopen" : "Complete"}
        </ContextMenuItem>
      )}
      {offers("send-today") && (
        <ContextMenuItem onSelect={() => onSendToDay("send-today")}>Today</ContextMenuItem>
      )}
      {offers("send-tomorrow") && (
        <ContextMenuItem onSelect={() => onSendToDay("send-tomorrow")}>Tomorrow</ContextMenuItem>
      )}
      {hasTopRow && <ContextMenuSeparator />}

      <ContextMenuSub>
        <ContextMenuSubTrigger>Priority</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {ALL_PRIORITIES.map((p) => (
            <ContextMenuItem
              className="justify-between"
              key={p}
              onSelect={() => onPriorityChange(p)}
            >
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "w-5 shrink-0 text-center text-sm font-semibold",
                    PRIORITY_COLORS[p]
                  )}
                >
                  {PRIORITY_CONFIG[p].icon}
                </span>
                {PRIORITY_CONFIG[p].label}
              </span>
              {isOnePage && page.priority === p && <Check aria-hidden size={12} />}
            </ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>

      {(offers("next-week") || canClearDate) && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>When</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {offers("next-week") && (
              <ContextMenuItem onSelect={() => onSendToDay("next-week")}>Next week</ContextMenuItem>
            )}
            {canClearDate && <ContextMenuItem onSelect={onClearDate}>No date</ContextMenuItem>}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}

      {offers("move-to-folder") && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>Move to folder</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem
              className={cn(page.folderId === null && "font-medium")}
              onSelect={() => onMoveToFolder(null)}
            >
              Inbox
            </ContextMenuItem>
            {writableFolders(folders).map((folder) => (
              <ContextMenuItem
                className={cn(page.folderId === folder.id && "font-medium")}
                key={folder.id}
                onSelect={() => onMoveToFolder(folder.id)}
              >
                <span
                  className="color-dot mr-2 h-2 w-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor: folder.color ?? "hsl(var(--muted-foreground) / 0.4)",
                  }}
                />
                {folder.name}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}

      {offers("stop-repeating") && (
        <ContextMenuItem onSelect={onStopRepeating}>Stop repeating</ContextMenuItem>
      )}

      <ContextMenuSeparator />

      {offers("rename") && <ContextMenuItem onSelect={onRename}>Rename</ContextMenuItem>}
      {/* Export reads the page and refuses nothing, so it has no place in the shared action
          rules; it sits above Delete to keep the destructive item last. */}
      {isOnePage && (
        <ContextMenuItem onSelect={() => void exportPage(page)}>Export as Markdown</ContextMenuItem>
      )}
      {offers("delete") && (
        <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
          {isOnePage ? "Delete" : `Delete ${actsOn} pages`}
        </ContextMenuItem>
      )}
    </ContextMenuContent>
  );
}
