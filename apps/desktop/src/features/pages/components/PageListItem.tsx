import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
import { useInlineRename } from "@/shared/hooks/useInlineRename";
import { useMinuteTick } from "@/shared/hooks/useMinuteTick";
import type { Folder, PagePriority, PageSummary } from "@pikos/core";

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
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : date.toLocaleString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });

  // Timed events today always show the time (past ones in red, upcoming as muted).
  // This keeps them visually distinct from any all-day event on the same date.
  if (!isAllDay && isToday) {
    return { label: formatTime(date), isPast, tooltip };
  }

  const dateLabel = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });

  // Timed non-today: show date only; time is available on hover via tooltip
  const label = dateLabel;
  return { label, isPast, tooltip };
}

function formatRelativeTime(iso: string): { label: string; isPast: boolean; tooltip: string } {
  const isAllDay = iso.length === 10;
  const tooltip = isAllDay
    ? new Date(
        parseInt(iso.slice(0, 4)),
        parseInt(iso.slice(5, 7)) - 1,
        parseInt(iso.slice(8, 10))
      ).toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : new Date(iso).toLocaleString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
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
    if (diffDays === 0) return { label: "today", isPast: false, tooltip };
    if (diffDays < 0) return { label: `${Math.abs(diffDays)}d`, isPast: true, tooltip };
    return { label: `${diffDays}d`, isPast: false, tooltip };
  }

  // Timed event
  const date = new Date(iso);
  const diffMs = date.getTime() - Date.now();
  const isPast = diffMs < 0;
  const abs = Math.abs(diffMs);
  const absMins = Math.round(abs / 60000);

  // Within the hour → relative only (already time-informative)
  if (absMins < 60)
    return { label: absMins === 0 ? "now" : `${absMins}m`, isPast: isPast && absMins > 0, tooltip };
  const absHours = Math.round(abs / 3600000);
  // Within the day → relative only
  if (absHours < 24) return { label: `${absHours}hr`, isPast, tooltip };
  const days = Math.round(abs / 86400000);
  return { label: `${days}d`, isPast, tooltip };
}

interface PageListItemProps {
  page: PageSummary;
  isActive: boolean;
  isHighlighted?: boolean;
  isRenaming: boolean;
  dragDisabled?: boolean;
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
  page,
  isActive,
  isHighlighted = false,
  isRenaming,
  dragDisabled = false,
  folders,
  onSelect,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onDelete,
  onMoveToFolder,
  onToggleStatus,
  onPriorityChange: _onPriorityChange,
  showRelative = false,
  onToggleDateFormat,
}: PageListItemProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: page.id,
    data: { type: "page" },
    disabled: isRenaming || dragDisabled,
    transition: null,
  });
  const { inputRef, prepareRenameFromMenu, contextMenuContentProps } = useInlineRename(isRenaming);

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
          ref={setNodeRef}
          data-page-id={page.id}
          style={{
            transform: CSS.Transform.toString(transform),
            opacity: isDragging ? 0 : 1,
          }}
          {...attributes}
          {...listeners}
          className={cn(
            "flex cursor-pointer items-start gap-3 border-b border-border px-3 py-3 text-sm select-none",
            isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
            isHighlighted && !isActive && "ring-1 ring-primary/50 ring-inset"
          )}
          onClick={isRenaming ? undefined : onSelect}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onRenameStart();
          }}
        >
          {/* Checkbox — border color encodes priority when not done */}
          <button
            className={cn(
              "mt-0.5 flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[2px] border transition-colors",
              page.status === "done"
                ? "border-foreground/40 bg-foreground/10"
                : page.priority === 1
                  ? "border-red-500 hover:border-red-400"
                  : page.priority === 2
                    ? "border-orange-500 hover:border-orange-400"
                    : "border-muted-foreground/40 hover:border-foreground/60"
            )}
            aria-label={page.status === "done" ? "Mark not done" : "Mark done"}
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
                    ref={inputRef}
                    autoComplete="off"
                    className="absolute inset-0 w-full border-0 bg-transparent p-0 text-sm leading-snug font-medium text-foreground outline-none"
                    defaultValue={page.title}
                    onChange={(e) => onRenameChange?.(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        onRenameCancel();
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {page.scheduledStart &&
                  (() => {
                    const { label, isPast, tooltip } = showRelative
                      ? formatRelativeTime(page.scheduledStart)
                      : formatDate(page.scheduledStart);
                    return (
                      <span
                        title={tooltip}
                        className={cn(
                          "shrink-0 cursor-pointer text-[11px] leading-snug hover:opacity-80",
                          isPast ? "text-red-500" : "text-muted-foreground"
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleDateFormat?.();
                        }}
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
              onSelect={() => onMoveToFolder(null)}
              className={cn(page.folderId === null && "font-medium")}
            >
              Inbox
            </ContextMenuItem>
            {folders.map((folder) => (
              <ContextMenuItem
                key={folder.id}
                onSelect={() => onMoveToFolder(folder.id)}
                className={cn(page.folderId === folder.id && "font-medium")}
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
