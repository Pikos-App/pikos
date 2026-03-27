import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Folder, PagePriority, PageSummary } from "@pikos/core";
import { Check } from "lucide-react";

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
import { useUI } from "@/shared/context/UIContext";
import { useInlineRename } from "@/shared/hooks/useInlineRename";
import { useMinuteTick } from "@/shared/hooks/useMinuteTick";

// Always-minutes format: 2:00p, 2:30p, 10:00a, 12:15p
function formatTime(date: Date): string {
  const h = date.getHours() % 12 || 12;
  const m = date.getMinutes().toString().padStart(2, "0");
  const ampm = date.getHours() >= 12 ? "p" : "a";
  return `${h}:${m}${ampm}`;
}

function formatDate(iso: string): { label: string; isPast: boolean; tooltip: string } {
  // Date-only strings ('YYYY-MM-DD') must be parsed as local, not UTC.
  // new Date('YYYY-MM-DD') treats them as UTC midnight, shifting the displayed
  // date by one day for users west of UTC (e.g. Pacific = Mar 8 → Mar 7).
  const isAllDay = iso.length === 10;
  const date = isAllDay
    ? new Date(parseInt(iso.slice(0, 4)), parseInt(iso.slice(5, 7)) - 1, parseInt(iso.slice(8, 10)))
    : new Date(iso);
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowMidnight = new Date(todayMidnight.getTime() + 86400000);
  const isPast = isAllDay ? date < todayMidnight : date < now;
  const isToday = date >= todayMidnight && date < tomorrowMidnight;

  const tooltip = isAllDay
    ? date.toLocaleDateString("en-US", {
        day: "numeric",
        month: "long",
        weekday: "long",
        year: "numeric",
      })
    : date.toLocaleString("en-US", {
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        month: "long",
        weekday: "long",
        year: "numeric",
      });

  // Timed events today always show the time (past ones in red, upcoming as muted).
  // This keeps them visually distinct from any all-day event on the same date.
  if (!isAllDay && isToday) {
    return { isPast, label: formatTime(date), tooltip };
  }

  const dateLabel = date.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });

  // Timed non-today: show date only; time is available on hover via tooltip
  const label = dateLabel;
  return { isPast, label, tooltip };
}

function formatRelativeTime(iso: string): { label: string; isPast: boolean; tooltip: string } {
  const isAllDay = iso.length === 10;
  const tooltip = isAllDay
    ? new Date(
        parseInt(iso.slice(0, 4)),
        parseInt(iso.slice(5, 7)) - 1,
        parseInt(iso.slice(8, 10))
      ).toLocaleDateString("en-US", {
        day: "numeric",
        month: "long",
        weekday: "long",
        year: "numeric",
      })
    : new Date(iso).toLocaleString("en-US", {
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        month: "long",
        weekday: "long",
        year: "numeric",
      });

  if (isAllDay) {
    const date = new Date(
      parseInt(iso.slice(0, 4)),
      parseInt(iso.slice(5, 7)) - 1,
      parseInt(iso.slice(8, 10))
    );
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    const diffDays = Math.round((date.getTime() - todayMidnight.getTime()) / 86400000);
    if (diffDays === 0) return { isPast: false, label: "today", tooltip };
    if (diffDays < 0) return { isPast: true, label: `${Math.abs(diffDays)}d`, tooltip };
    return { isPast: false, label: `${diffDays}d`, tooltip };
  }

  // Timed event
  const date = new Date(iso);
  const diffMs = date.getTime() - Date.now();
  const isPast = diffMs < 0;
  const abs = Math.abs(diffMs);
  const absMins = Math.round(abs / 60000);

  // Within the hour → relative only (already time-informative)
  if (absMins < 60)
    return { isPast: isPast && absMins > 0, label: absMins === 0 ? "now" : `${absMins}m`, tooltip };
  const absHours = Math.round(abs / 3600000);
  // Within the day → relative only
  if (absHours < 24) return { isPast, label: `${absHours}hr`, tooltip };
  const days = Math.round(abs / 86400000);
  return { isPast, label: `${days}d`, tooltip };
}

interface PageListItemProps {
  page: PageSummary;
  isActive: boolean;
  isRenaming: boolean;
  folders: Folder[];
  onSelect: () => void;
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
  onDelete,
  onMoveToFolder,
  onPriorityChange: _onPriorityChange,
  onRenameCancel,
  onRenameChange,
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

  useMinuteTick();

  function commit() {
    const trimmed = inputRef.current?.value.trim() ?? "";
    if (trimmed) onRenameCommit(trimmed);
    else onRenameCancel();
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
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
            "flex cursor-pointer items-start gap-3 border-b border-border px-3 py-3 text-sm outline-none select-none",
            isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
          )}
          onClick={isRenaming ? undefined : onSelect}
          onDoubleClick={(e) => {
            e.stopPropagation();
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
          tabIndex={isActive ? 0 : -1}
        >
          {/* Checkbox — border color encodes priority when not done */}
          <button
            aria-label={page.status === "done" ? "Mark not done" : "Mark done"}
            className={cn(
              "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[2px] border transition-colors",
              page.status === "done"
                ? "border-foreground/40 bg-foreground/10"
                : page.priority === 1
                  ? "border-red-500 hover:border-red-400"
                  : page.priority === 2
                    ? "border-orange-500 hover:border-orange-400"
                    : "border-muted-foreground/40 hover:border-foreground/60"
            )}
            onClick={(e) => {
              e.stopPropagation();
              onToggleStatus();
            }}
          >
            {page.status === "done" && <Check size={8} strokeWidth={2.5} />}
          </button>

          {/* Content */}
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="relative min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate leading-snug font-medium",
                    isRenaming && "invisible",
                    page.status === "done" && "text-muted-foreground line-through"
                  )}
                >
                  {page.title || "Untitled"}
                </span>
                {isRenaming && (
                  <input
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    className="absolute inset-0 w-full border-0 bg-transparent p-0 text-sm leading-snug font-medium text-foreground outline-none"
                    defaultValue={page.title}
                    onBlur={commit}
                    onChange={(e) => onRenameChange?.(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        onRenameCancel();
                      }
                    }}
                    ref={inputRef}
                  />
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {page.scheduledStart &&
                  (() => {
                    const isCompleted = page.status === "done";
                    const { isPast, label, tooltip } =
                      !isCompleted && showRelative
                        ? formatRelativeTime(page.scheduledStart)
                        : formatDate(page.scheduledStart);
                    return (
                      <span
                        className={cn(
                          "shrink-0 cursor-pointer text-sm leading-snug hover:opacity-80",
                          isPast && !isCompleted ? "text-red-500" : "text-muted-foreground"
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleDateFormat?.();
                        }}
                        title={tooltip}
                      >
                        {label}
                      </span>
                    );
                  })()}
              </div>
            </div>
            {page.subtitle && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{page.subtitle}</p>
            )}
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent {...contextMenuContentProps}>
        <ContextMenuItem onSelect={() => prepareRenameFromMenu(onRenameStart)}>
          Rename
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Move to Folder</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem
              className={cn(page.folderId === null && "font-medium")}
              onSelect={() => onMoveToFolder(null)}
            >
              Inbox
            </ContextMenuItem>
            {folders.map((folder) => (
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
        <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
