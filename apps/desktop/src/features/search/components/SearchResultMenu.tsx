import type { PageActionId, PageSummary } from "@pikos/core";
import { pageActions, toPageSummary } from "@pikos/core";
import { CalendarDays, Sun, Sunrise } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { MoveToFolderSub } from "@/shared/components/MoveToFolderSub";
import { usePages } from "@/shared/context/PagesContext";
import { type SendDay, usePageRowActions } from "@/shared/hooks/usePageRowActions";

/**
 * A search result's right-click menu: the list menu's moves, so a page found is sent to a day or
 * a folder from where it was found. The page is read when the menu opens, since a result is a
 * snapshot of the search and lacks what a move keeps, like the page's own stored time.
 */
export function SearchResultMenu({
  children,
  onMoved,
  pageId,
}: {
  children: ReactNode;
  onMoved: () => void;
  pageId: string;
}) {
  const { clearSchedule, folders, getPageAfterWrites, updatePage } = usePages();
  const { sendToDay } = usePageRowActions();
  const [page, setPage] = useState<PageSummary | null>(null);

  function handleOpenChange(open: boolean) {
    if (!open) return;

    void getPageAfterWrites(pageId).then((found) => setPage(found && toPageSummary(found)));
  }

  const offered = new Set(
    page
      ? pageActions(page)
          .filter((a) => a.offered)
          .map((a) => a.id)
      : []
  );
  const offers = (id: PageActionId) => offered.has(id);
  const hasDayRow = offers("send-today") || offers("send-tomorrow");
  const hasWhen = offers("next-week") || offers("clear-date");

  function sendTo(day: SendDay) {
    if (!page) return;

    sendToDay([page], day);
    onMoved();
  }

  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {page && (
        <ContextMenuContent>
          {offers("send-today") && (
            <ContextMenuItem onSelect={() => sendTo("send-today")}>
              <Sun aria-hidden />
              Today
            </ContextMenuItem>
          )}
          {offers("send-tomorrow") && (
            <ContextMenuItem onSelect={() => sendTo("send-tomorrow")}>
              <Sunrise aria-hidden />
              Tomorrow
            </ContextMenuItem>
          )}
          {hasDayRow && <ContextMenuSeparator />}

          {hasWhen && (
            <ContextMenuSub>
              <ContextMenuSubTrigger className="gap-2">
                <CalendarDays aria-hidden />
                When
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {offers("next-week") && (
                  <ContextMenuItem onSelect={() => sendTo("next-week")}>Next week</ContextMenuItem>
                )}
                {offers("clear-date") && (
                  <ContextMenuItem
                    onSelect={() => {
                      void clearSchedule(page.id);
                      onMoved();
                    }}
                  >
                    No date
                  </ContextMenuItem>
                )}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}

          {offers("move-to-folder") && (
            <MoveToFolderSub
              currentFolderId={page.folderId}
              folders={folders}
              onMoveToFolder={(folderId) => {
                updatePage(page.id, { folderId });
                onMoved();
              }}
            />
          )}
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}
