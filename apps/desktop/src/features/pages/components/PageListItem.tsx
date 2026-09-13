import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Folder, PagePriority, PageSummary } from "@pikos/core";
import {
  folderMoveTargets,
  formatDateRange,
  formatLongDate,
  formatPageDate,
  formatPageRelativeTime,
  isAllDayIso,
  isDone,
  isDueSoon,
  isOpen,
  parseLocalISO,
} from "@pikos/core";
import type React from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { SyncSourceIcon } from "@/shared/components/SyncSourceIcon";
import { TaskCheckbox } from "@/shared/components/TaskCheckbox";
import { useListSettings } from "@/shared/context/ListSettingsContext";
import { useUI } from "@/shared/context/UIContext";
import { useInlineRename } from "@/shared/hooks/useInlineRename";
import { useMinuteTick } from "@/shared/hooks/useMinuteTick";
interface PageListItemProps {
  page: PageSummary;
  isActive: boolean;
  isSelected: boolean;
  isRenaming: boolean;
  folders: Folder[];
  onClearDate?: () => void;
  onSelect: (e: React.MouseEvent) => void;
  onRenameStart: () => void;
  onRenameChange?: (title: string) => void;
  onRenameCommit: (title: string) => void;
  onRenameCancel: () => void;
  onDelete: () => void;
  onMoveToFolder: (folderId: string | null) => void;
  onToggleStatus: () => void;
  onPriorityChange: (priority: PagePriority) => void;
  showRelative?: boolean;
  onToggleDateFormat?: () => void;
}

export function PageListItem({
  folders,
  isActive,
  isRenaming,
  isSelected,
  onClearDate,
  onDelete,
  onMoveToFolder,
  onPriorityChange: _onPriorityChange,
  onRenameCancel,
  onRenameChange: _onRenameChange,
  onRenameCommit,
  onRenameStart,
  onSelect,
  onToggleDateFormat,
  onToggleStatus,
  page,
  showRelative = false,
}: PageListItemProps) {
  const { attributes, isDragging, listeners, setNodeRef, transform } = useSortable({
    data: { type: "page" },
    disabled: isRenaming,
    id: page.id,
    transition: null,
  });
  const { contextMenuContentProps, inputRef, prepareRenameFromMenu } = useInlineRename(isRenaming);
  const { openPage } = useUI();
  const { density } = useListSettings();
  const showSubtitle = density !== "compact" && Boolean(page.subtitle);

  useMinuteTick();

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- @dnd-kit/sortable injects role="button" + tabIndex via {...attributes}; ESLint can't see through the spread. Proper listbox/option pattern deferred to the post-launch a11y backlog. */}
        <div
          aria-current={isActive ? "true" : undefined}
          aria-label={page.title || "Untitled"}
          data-active={isActive ? "true" : undefined}
          data-page-id={page.id}
          data-page-list-item
          ref={setNodeRef}
          style={{
            opacity: isDragging ? 0 : 1,
            transform: CSS.Transform.toString(transform),
          }}
          {...attributes}
          {...listeners}
          className={cn(
            "flex cursor-pointer items-start border-b border-l-2 border-border px-3 transition-[background-color] duration-[120ms] ease-out outline-none select-none",
            density === "compact"
              ? "gap-2 py-2.5"
              : density === "spacious"
                ? "gap-3 py-4"
                : "gap-3 py-3",
            isActive
              ? "border-l-interactive-primary bg-surface-selected text-accent-foreground"
              : isSelected
                ? "border-l-transparent bg-surface-selected/50 text-accent-foreground"
                : "border-l-transparent hover:bg-surface-hover"
          )}
          data-page-item
          data-selected={isSelected ? "true" : undefined}
          onClick={isRenaming ? undefined : onSelect}
          onDoubleClick={(e) => {
            e.stopPropagation();
            // Synced mirror: title is calendar-owned; the backend rejects the write.
            if (page.scheduleLocked) return;
            onRenameStart();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isRenaming) {
              e.preventDefault();
              openPage(page.id);
              // Defer focus to let the editor mount/update
              requestAnimationFrame(() => {
                const editor = document.querySelector<HTMLElement>(".editor-content");
                editor?.focus();
              });
            }
          }}
          // Strip dnd-kit's injected role="button". The row contains nested
          // interactive children (checkbox, date-toggle, context menu); leaving
          // role="button" trips axe's nested-interactive at runtime. The row
          // is still keyboard-reachable via tabIndex (also from {...attributes})
          // and labeled via aria-label; the parent's onKeyDown handles
          // Enter/Space. Proper listbox/option modeling lands with the post-launch a11y refactor.
          role={undefined}
          tabIndex={isActive ? 0 : -1}
        >
          {/* Checkbox — border color encodes priority when not done */}
          <TaskCheckbox
            borderColor={
              isOpen(page)
                ? page.priority === 1
                  ? "var(--color-status-overdue)"
                  : page.priority === 2
                    ? "var(--color-status-due-soon)"
                    : undefined
                : undefined
            }
            checked={isDone(page)}
            className="mt-px"
            onChange={() => onToggleStatus()}
          />

          {/* Content */}
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <span
                  className={cn(
                    "type-body block leading-none font-medium outline-none",
                    isRenaming
                      ? "cursor-text overflow-hidden whitespace-nowrap caret-foreground"
                      : "truncate",
                    isDone(page) && !isRenaming && "text-muted-foreground"
                  )}
                  contentEditable={isRenaming}
                  key={isRenaming ? "editing" : "display"}
                  onBlur={
                    isRenaming
                      ? (e) => {
                          const trimmed = e.currentTarget.textContent?.trim() ?? "";
                          if (trimmed) onRenameCommit(trimmed);
                          else onRenameCancel();
                        }
                      : undefined
                  }
                  onClick={isRenaming ? (e) => e.stopPropagation() : undefined}
                  onKeyDown={
                    isRenaming
                      ? (e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            e.currentTarget.blur();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            onRenameCancel();
                          }
                        }
                      : undefined
                  }
                  onPaste={
                    isRenaming
                      ? (e) => {
                          e.preventDefault();
                          const text = e.clipboardData.getData("text/plain").replace(/\n/g, " ");
                          document.execCommand("insertText", false, text);
                        }
                      : undefined
                  }
                  ref={inputRef as React.RefObject<HTMLSpanElement>}
                  role={isRenaming ? "textbox" : undefined}
                  suppressContentEditableWarning
                >
                  {page.title || "Untitled"}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <SyncSourceIcon className="h-3 w-3" syncState={page.syncState} />
                {page.scheduledStart &&
                  (() => {
                    const isCompleted = isDone(page);
                    // Multi-day all-day span: show the explicit range ("May 2 – 10").
                    // Falls back to single-date formatting for timed events or
                    // when end is missing/equal to start.
                    const isAllDaySpan =
                      isAllDayIso(page.scheduledStart) &&
                      typeof page.scheduledEnd === "string" &&
                      isAllDayIso(page.scheduledEnd) &&
                      page.scheduledEnd > page.scheduledStart;
                    const { isPast, label, tooltip } = isAllDaySpan
                      ? (() => {
                          const d = formatPageDate(page.scheduledStart);
                          return {
                            isPast: d.isPast,
                            label: formatDateRange(page.scheduledStart, page.scheduledEnd),
                            tooltip: `${d.tooltip} – ${formatLongDate(
                              parseLocalISO(page.scheduledEnd!)
                            )}`,
                          };
                        })()
                      : !isCompleted && showRelative
                        ? formatPageRelativeTime(page.scheduledStart)
                        : formatPageDate(page.scheduledStart);
                    const dueSoon = !isCompleted && !isPast && isDueSoon(page.scheduledStart);
                    return (
                      <button
                        aria-label={`Toggle date format: ${label}`}
                        className={cn(
                          "type-ui-sm shrink-0 cursor-pointer hover:opacity-80",
                          isPast && !isCompleted
                            ? "text-status-overdue"
                            : dueSoon
                              ? "text-status-due-soon"
                              : "text-subtle"
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleDateFormat?.();
                        }}
                        tabIndex={-1}
                        title={tooltip}
                        type="button"
                      >
                        {label}
                      </button>
                    );
                  })()}
              </div>
            </div>
            {showSubtitle && (
              <p className="type-body-sm mt-0.5 truncate text-subtle">{page.subtitle}</p>
            )}
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent {...contextMenuContentProps}>
        {!page.scheduleLocked && (
          <ContextMenuItem onSelect={() => prepareRenameFromMenu(onRenameStart)}>
            Rename
          </ContextMenuItem>
        )}
        {!page.scheduleLocked && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>Move to Folder</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem
                className={cn(page.folderId === null && "font-medium")}
                onSelect={() => onMoveToFolder(null)}
              >
                Inbox
              </ContextMenuItem>
              {folderMoveTargets(folders).map((folder) => (
                <ContextMenuItem
                  className={cn(page.folderId === folder.id && "font-medium")}
                  key={folder.id}
                  onSelect={() => onMoveToFolder(folder.id)}
                >
                  <span
                    className="mr-2 h-2 w-2 shrink-0 rounded-full"
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
        {page.scheduledStart && onClearDate && !page.scheduleLocked && (
          <ContextMenuItem onSelect={onClearDate}>Clear Date</ContextMenuItem>
        )}
        <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
