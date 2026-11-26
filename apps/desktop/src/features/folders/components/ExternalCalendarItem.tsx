import type { Folder } from "@pikos/core";
import { CalendarSync } from "lucide-react";

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { SidebarListItem } from "@/shared/components/SidebarListItem";

import { FolderColorSubmenu } from "./FolderColorSubmenu";

// External-calendar folders never inline-rename — the calendar display name is
// authoritative. SidebarListItem still requires the rename hooks, so pass no-ops.
const NOOP = () => {};

export interface ExternalCalendarItemProps {
  folder: Folder;
  pageCount?: number;
  isActive: boolean;
  onSelect: () => void;
  onColorChange: (color: string) => void;
}

/**
 * A synced external-calendar folder in the sidebar. Unlike a regular `FolderItem`
 * it's not draggable or a page drop target, and can't be renamed or deleted from
 * here — the Calendar Sync panel toggle is the only teardown path. Recolor is
 * allowed.
 */
export function ExternalCalendarItem({
  folder,
  isActive,
  onColorChange,
  onSelect,
  pageCount,
}: ExternalCalendarItemProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SidebarListItem
          className="items-center gap-2"
          id={folder.id}
          inputRef={{ current: null }}
          isActive={isActive}
          isRenaming={false}
          label={folder.name}
          onRenameCancel={NOOP}
          onRenameCommit={NOOP}
          onRenameStart={NOOP}
          onSelect={onSelect}
          prefix={
            <CalendarSync
              className="mt-0.5 shrink-0"
              data-testid="calendar-color"
              size={13}
              style={{ color: folder.color ?? "var(--text-tertiary)" }}
            />
          }
          tabIndex={-1}
        >
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
          {pageCount !== undefined && pageCount > 0 && (
            <span className="type-ui-sm shrink-0 text-subtle">
              {pageCount > 99 ? "99+" : pageCount}
            </span>
          )}
        </SidebarListItem>
      </ContextMenuTrigger>

      <ContextMenuContent>
        <FolderColorSubmenu current={folder.color} onColorChange={onColorChange} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
