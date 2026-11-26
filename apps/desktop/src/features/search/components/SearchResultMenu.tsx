import type { PageActionId, PageSummary } from "@pikos/core";
import { pageActions, toPageSummary } from "@pikos/core";
import { CalendarDays, Sun, Sunrise } from "lucide-react";
import type { ReactNode } from "react";
import { useRef, useState } from "react";

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
import { ScheduleDateButton } from "@/shared/components/ScheduleDateButton";
import { usePages } from "@/shared/context/PagesContext";
import { type SendDay, usePageRowActions } from "@/shared/hooks/usePageRowActions";

/**
 * A search result's right-click menu: the list menu's moves, so a page found is sent to a day or
 * a folder from where it was found. The page is read when the menu opens, since a result is a
 * snapshot of the search and lacks what a move keeps, like the page's own stored time.
 *
 * Pick a date… opens beside the result once the menu has handed focus back to it, and keeps the
 * palette open until a day is picked, since the result it sits beside goes with the palette.
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
  const resultRef = useRef<HTMLElement | null>(null);
  const datePickRequested = useRef(false);
  const [datePickerAnchor, setDatePickerAnchor] = useState<HTMLElement | null>(null);

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
  const hasWhen = offers("next-week") || offers("pick-date") || offers("clear-date");

  function sendTo(day: SendDay) {
    if (!page) return;

    sendToDay([page], day);
    onMoved();
  }

  function openRequestedPicker() {
    if (!datePickRequested.current) return;

    datePickRequested.current = false;
    setDatePickerAnchor(resultRef.current);
  }

  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger
        asChild
        onContextMenu={(e) => {
          resultRef.current = e.currentTarget;
        }}
      >
        {children}
      </ContextMenuTrigger>
      {page && (
        <ContextMenuContent onCloseAutoFocus={openRequestedPicker}>
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
                {offers("pick-date") && (
                  <ContextMenuItem
                    onSelect={() => {
                      datePickRequested.current = true;
                    }}
                  >
                    Pick a date…
                  </ContextMenuItem>
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
      {page && datePickerAnchor && (
        <ScheduleDateButton
          anchored={{
            anchor: datePickerAnchor,
            onClose: () => setDatePickerAnchor(null),
            onPicked: onMoved,
          }}
          page={page}
        />
      )}
    </ContextMenu>
  );
}
