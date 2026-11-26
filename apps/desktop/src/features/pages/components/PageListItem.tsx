import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Folder, PagePriority, PageSummary } from "@pikos/core";
import {
  formatDateRange,
  formatLongDate,
  formatPageDate,
  formatPageRelativeTime,
  isAllDayIso,
  isDone,
  isDueSoon,
  isOpen,
  parseLocalISO,
  PRIORITY_CHECKBOX_COLORS,
  viewerEnd,
  viewerStart,
} from "@pikos/core";
import type React from "react";

import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { SyncSourceIcon } from "@/shared/components/SyncSourceIcon";
import { TaskCheckbox } from "@/shared/components/TaskCheckbox";
import { useInterfaceSettings } from "@/shared/context/InterfaceSettingsContext";
import { useUI } from "@/shared/context/UIContext";
import { useInlineRename } from "@/shared/hooks/useInlineRename";
import { useNow } from "@/shared/hooks/useNow";
import { usePrefetchOnHover } from "@/shared/viewCache/usePrefetchOnHover";

import { PageRowMenu } from "./PageRowMenu";

interface PageListItemProps {
  page: PageSummary;
  isActive: boolean;
  isSelected: boolean;
  isRenaming: boolean;
  folders: Folder[];
  onClearDate?: () => void;
  onSelect: (e: React.MouseEvent) => void;
  onRenameStart: () => void;
  /** How many pages this row's context menu acts on: the selection it belongs to, or 1. A menu that
   *  reads the same on one page and on five can't say what Delete is about to do. */
  menuActsOn?: number;
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
  menuActsOn = 1,
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
  const prefetch = usePrefetchOnHover(page.id);
  const { attributes, isDragging, listeners, setNodeRef, transform } = useSortable({
    data: { type: "page" },
    disabled: isRenaming,
    id: page.id,
    transition: null,
  });
  const { contextMenuContentProps, inputRef, prepareRenameFromMenu } = useInlineRename(isRenaming);
  const { openPage } = useUI();
  const { density } = useInterfaceSettings();
  const showSubtitle = density !== "compact" && Boolean(page.subtitle);

  const now = useNow();

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
          {...prefetch}
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
            if (page.scheduleLocked) return;
            onRenameStart();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isRenaming) {
              e.preventDefault();
              openPage(page.id);
              requestAnimationFrame(() => {
                const editor = document.querySelector<HTMLElement>(".editor-content");
                editor?.focus();
              });
            }
          }}
          // Strip dnd-kit's injected role="button": the row contains nested interactive children, which trips
          // axe's nested-interactive. It stays keyboard-reachable via tabIndex, labeled via aria-label, and the
          // parent's onKeyDown handles Enter/Space.
          role={undefined}
          tabIndex={isActive ? 0 : -1}
        >
          {/* Border colour encodes priority when not done. Centred on the title's line, not the row's top edge:
              the row is `items-start`, so a two-line row keeps the box beside the title. */}
          <span className="type-body flex h-[1em] shrink-0 items-center leading-none">
            <TaskCheckbox
              borderColor={isOpen(page) ? PRIORITY_CHECKBOX_COLORS[page.priority] : undefined}
              checked={isDone(page)}
              onChange={() => onToggleStatus()}
            />
          </span>

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
                    // A synced event's stored time is its source calendar's; the row reads the viewer's.
                    const start = viewerStart(page)!;
                    const end = viewerEnd(page);
                    const isAllDaySpan =
                      isAllDayIso(start) &&
                      typeof end === "string" &&
                      isAllDayIso(end) &&
                      end > start;
                    const { isPast, label, tooltip } = isAllDaySpan
                      ? (() => {
                          const d = formatPageDate(start, now);
                          return {
                            isPast: d.isPast,
                            label: formatDateRange(start, end),
                            tooltip: `${d.tooltip} – ${formatLongDate(parseLocalISO(end))}`,
                          };
                        })()
                      : !isCompleted && showRelative
                        ? formatPageRelativeTime(start, now)
                        : formatPageDate(start, now);
                    const dueSoon = !isCompleted && !isPast && isDueSoon(start, now);
                    // Where someone looks after Move to today leaves a page behind;
                    // the toast only has room for the count.
                    const title = page.scheduleLocked
                      ? `${tooltip} · Its calendar sets this date`
                      : tooltip;

                    return (
                      <button
                        aria-label={`Toggle date format: ${label}`}
                        className={cn(
                          "type-ui-sm shrink-0 cursor-pointer hover:opacity-80",
                          isPast && !isCompleted
                            ? "text-status-overdue"
                            : dueSoon
                              ? "text-due-soon"
                              : "text-subtle"
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleDateFormat?.();
                        }}
                        tabIndex={-1}
                        title={title}
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

      <PageRowMenu
        actsOn={menuActsOn}
        folders={folders}
        onClearDate={onClearDate}
        onCloseAutoFocus={(e) => contextMenuContentProps.onCloseAutoFocus(e)}
        onDelete={onDelete}
        onMoveToFolder={onMoveToFolder}
        onRename={() => prepareRenameFromMenu(onRenameStart)}
        page={page}
      />
    </ContextMenu>
  );
}
