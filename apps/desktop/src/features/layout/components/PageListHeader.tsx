// Sort is hidden on the Today view — it's always grouped overdue → today,
// not user-sortable.

import type { Folder } from "@pikos/core";
import {
  ArrowUpDown,
  CalendarDays,
  CaseSensitive,
  Flag,
  GripVertical,
  Plus,
  Search,
} from "lucide-react";
import type React from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FolderSwitcher } from "@/features/folders";
import type { SortMode } from "@/features/pages";
import { IconToolbar } from "@/shared/components/IconToolbar";
import { TooltipIconButton } from "@/shared/components/TooltipIconButton";

interface PageListHeaderProps {
  activeViewId: string;
  folders: Folder[];
  sidebarHidden: boolean;
  sortMode: SortMode;
  setSortMode: (viewId: string, mode: SortMode) => void;
  openSortMenu: string | null;
  setOpenSortMenu: (id: string | null) => void;
  onOpenDialog: (dialog: "search" | "quick-add") => void;
}

const SORT_OPTIONS: { value: SortMode; label: string; icon: React.ReactNode }[] = [
  { icon: <CalendarDays size={13} />, label: "Date", value: "date" },
  { icon: <CaseSensitive size={13} />, label: "Title", value: "title" },
  { icon: <Flag size={13} />, label: "Priority", value: "priority" },
  { icon: <GripVertical size={13} />, label: "Manual", value: "manual" },
];

function viewName(activeViewId: string, folders: Folder[]): string {
  if (activeViewId === "today") return "Today";
  if (activeViewId === "inbox") return "Inbox";
  return folders.find((f) => f.id === activeViewId)?.name ?? "Pages";
}

export function PageListHeader({
  activeViewId,
  folders,
  onOpenDialog,
  openSortMenu,
  setOpenSortMenu,
  setSortMode,
  sidebarHidden,
  sortMode,
}: PageListHeaderProps) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
      {sidebarHidden ? (
        <FolderSwitcher />
      ) : (
        <span className="type-ui min-w-0 truncate text-foreground">
          {viewName(activeViewId, folders)}
        </span>
      )}
      <IconToolbar aria-label="Page actions" className="flex items-center gap-0.5">
        <TooltipIconButton
          icon={<Search size={13} />}
          label="Search"
          onClick={() => onOpenDialog("search")}
          shortcut="mod+k"
          tabIndex={0}
        />
        {activeViewId !== "today" && (
          <DropdownMenu
            onOpenChange={(open) => setOpenSortMenu(open ? "page-sort" : null)}
            open={openSortMenu === "page-sort"}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label={`Sort: ${sortMode}`}
                    className="rounded p-1 text-text-tertiary transition-[background-color,color] duration-[var(--transition-fast)] hover:bg-surface-hover hover:text-text-secondary"
                    tabIndex={0}
                  >
                    <ArrowUpDown size={13} />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">Sort: {sortMode}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-40">
              {SORT_OPTIONS.map(({ icon, label, value }) => (
                <DropdownMenuItem
                  className="gap-2"
                  key={value}
                  onSelect={() => setSortMode(activeViewId, value)}
                >
                  {icon}
                  {label}
                  {sortMode === value && <span className="ml-auto text-primary">✓</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <TooltipIconButton
          icon={<Plus size={15} />}
          label="New Page"
          onClick={() => onOpenDialog("quick-add")}
          shortcut="mod+n"
          tabIndex={activeViewId === "today" ? 0 : -1}
        />
      </IconToolbar>
    </div>
  );
}

export { viewName };
