import type { Folder, PageActionId, PagePriority, PageSummary } from "@pikos/core";
import {
  isDone,
  pageActions,
  PRIORITY_COLORS,
  rruleEditWouldDegrade,
  writableFolders,
} from "@pikos/core";
import {
  Ban,
  CalendarDays,
  Check,
  CircleCheck,
  Download,
  Flag,
  FolderOpen,
  Hash,
  Pencil,
  Repeat2,
  RotateCcw,
  Sun,
  Sunrise,
  Trash2,
} from "lucide-react";

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
import { usePages } from "@/shared/context/PagesContext";

import { useExportPage } from "../hooks/useExportPage";
import type { SendDay } from "../hooks/usePageRowActions";
import type { RowPickerKind } from "../hooks/useRowPicker";

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
  onOpenPicker: (kind: RowPickerKind) => void;
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
  onOpenPicker,
  onPriorityChange,
  onRename,
  onSendToDay,
  onStopRepeating,
  onToggleStatus,
  page,
}: PageRowMenuProps) {
  const { exportPage } = useExportPage();
  const { recurrenceRules } = usePages();
  const isOnePage = actsOn === 1;
  const offered = new Set(
    pageActions(page, actsOn)
      .filter((a) => a.offered)
      .map((a) => a.id)
  );
  const offers = (id: PageActionId) => offered.has(id);
  const canClearDate = offers("clear-date") && onClearDate !== undefined;
  const hasTopRow = offers("complete") || offers("send-today") || offers("send-tomorrow");
  const hasWhen = offers("next-week") || offers("pick-date") || canClearDate;
  // The repeat picker refuses to open on a rule it would degrade, so the menu doesn't offer it.
  const rule = recurrenceRules.find((r) => r.pageId === page.id);
  const canEditRepeat = offers("repeat") && !(rule && rruleEditWouldDegrade(rule.rrule));

  return (
    <ContextMenuContent onCloseAutoFocus={onCloseAutoFocus}>
      {offers("complete") && (
        <ContextMenuItem onSelect={onToggleStatus}>
          {isDone(page) ? <RotateCcw aria-hidden /> : <CircleCheck aria-hidden />}
          {isDone(page) ? "Reopen" : "Complete"}
        </ContextMenuItem>
      )}
      {offers("send-today") && (
        <ContextMenuItem onSelect={() => onSendToDay("send-today")}>
          <Sun aria-hidden />
          Today
        </ContextMenuItem>
      )}
      {offers("send-tomorrow") && (
        <ContextMenuItem onSelect={() => onSendToDay("send-tomorrow")}>
          <Sunrise aria-hidden />
          Tomorrow
        </ContextMenuItem>
      )}
      {hasTopRow && <ContextMenuSeparator />}

      <ContextMenuSub>
        <ContextMenuSubTrigger className="gap-2">
          <Flag aria-hidden />
          Priority
        </ContextMenuSubTrigger>
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

      {hasWhen && (
        <ContextMenuSub>
          <ContextMenuSubTrigger className="gap-2">
            <CalendarDays aria-hidden />
            When
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {offers("next-week") && (
              <ContextMenuItem onSelect={() => onSendToDay("next-week")}>Next week</ContextMenuItem>
            )}
            {offers("pick-date") && (
              <ContextMenuItem onSelect={() => onOpenPicker("pick-date")}>
                Pick a date…
              </ContextMenuItem>
            )}
            {canClearDate && <ContextMenuItem onSelect={onClearDate}>No date</ContextMenuItem>}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}

      {offers("move-to-folder") && (
        <ContextMenuSub>
          <ContextMenuSubTrigger className="gap-2">
            <FolderOpen aria-hidden />
            Move to folder
          </ContextMenuSubTrigger>
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

      {offers("tags") && (
        <ContextMenuItem onSelect={() => onOpenPicker("tags")}>
          <Hash aria-hidden />
          Tags…
        </ContextMenuItem>
      )}
      {canEditRepeat && (
        <ContextMenuItem onSelect={() => onOpenPicker("repeat")}>
          <Repeat2 aria-hidden />
          Repeat…
        </ContextMenuItem>
      )}

      {offers("stop-repeating") && (
        <ContextMenuItem onSelect={onStopRepeating}>
          <Ban aria-hidden />
          Stop repeating
        </ContextMenuItem>
      )}

      <ContextMenuSeparator />

      {offers("rename") && (
        <ContextMenuItem onSelect={onRename}>
          <Pencil aria-hidden />
          Rename
        </ContextMenuItem>
      )}
      {/* Export reads the page and refuses nothing, so it has no place in the shared action
          rules; it sits above Delete to keep the destructive item last. */}
      {isOnePage && (
        <ContextMenuItem onSelect={() => void exportPage(page)}>
          <Download aria-hidden />
          Export as Markdown
        </ContextMenuItem>
      )}
      {offers("delete") && (
        <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
          <Trash2 aria-hidden className="text-destructive" />
          {isOnePage ? "Delete" : `Delete ${actsOn} pages`}
        </ContextMenuItem>
      )}
    </ContextMenuContent>
  );
}
