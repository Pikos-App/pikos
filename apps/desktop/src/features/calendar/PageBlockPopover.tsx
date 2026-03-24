// PageBlockPopover — metadata inspector popover for calendar blocks.
// Opens on single click. Does NOT set activePageId (calendar context preserved).
// "Open page" button is the bridge to full editor.

import type { PagePriority, PageStatus, PageSummary } from "@pikos/core";
import { format } from "date-fns";
import { Check, ExternalLink } from "lucide-react";
import { useState } from "react";

import { FolderChip } from "@/features/pages/components/FolderChip";
import { PriorityDropdown } from "@/features/pages/components/PriorityDropdown";
import { DateTimePicker } from "@/shared/components/DateTimePicker";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { nowLocalISO } from "@/shared/utils/dates";

interface PageBlockPopoverProps {
  page: PageSummary;
}

export function PageBlockPopover({ page }: PageBlockPopoverProps) {
  const { clearSchedule, folders, scheduleOnce, updatePage } = useWorkspace();
  const { openPage } = useUI();

  // Local title state — popover mounts fresh on each open so no sync needed.
  const [titleValue, setTitleValue] = useState(page.title);

  const isDone = page.status === "done";

  function handleStatusToggle() {
    const newStatus: PageStatus = isDone ? "not_started" : "done";
    updatePage(page.id, {
      completedAt: newStatus === "done" ? nowLocalISO() : null,
      status: newStatus,
    });
  }

  function handleTitleBlur(e: React.FocusEvent<HTMLInputElement>) {
    const value = e.currentTarget.value.trim();
    if (value !== page.title) {
      updatePage(page.id, { title: value || page.title });
    }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    }
  }

  function handlePriorityChange(priority: PagePriority) {
    updatePage(page.id, { priority });
  }

  function handleFolderChange(folderId: string | null) {
    updatePage(page.id, { folderId });
  }

  function handleDateChange(iso: string | null) {
    if (!iso) {
      void clearSchedule(page.id);
      return;
    }
    // Preserve duration when shifting start time on a timed event.
    let endIso = page.scheduledEnd ?? undefined;
    if (
      iso.includes("T") &&
      page.scheduledStart?.includes("T") &&
      page.scheduledEnd?.includes("T")
    ) {
      const durationMs =
        new Date(page.scheduledEnd).getTime() - new Date(page.scheduledStart).getTime();
      if (durationMs > 0) {
        endIso = format(new Date(new Date(iso).getTime() + durationMs), "yyyy-MM-dd'T'HH:mm:ss");
      }
    }
    void scheduleOnce(page.id, iso, endIso);
  }

  function handleEndChange(endIso: string | null) {
    if (page.scheduledStart) {
      void scheduleOnce(page.id, page.scheduledStart, endIso ?? undefined);
    }
  }

  function handleOpenPage(e: React.MouseEvent) {
    e.stopPropagation();
    openPage(page.id);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Title */}
      <input
        autoFocus
        className="w-full border-0 bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground/40"
        onBlur={handleTitleBlur}
        onChange={(e) => setTitleValue(e.target.value)}
        onFocus={(e) => {
          const el = e.currentTarget;
          requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
        }}
        onKeyDown={handleTitleKeyDown}
        placeholder="Untitled"
        value={titleValue}
      />

      {/* Metadata rows */}
      <div className="flex flex-col gap-2">
        {/* Status */}
        <div className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Status</span>
          <button
            aria-label={isDone ? "Mark not done" : "Mark done"}
            className="inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
            onClick={handleStatusToggle}
          >
            <span
              className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[2px] border transition-colors ${
                isDone ? "border-foreground/40 bg-foreground/10" : "border-muted-foreground/40"
              }`}
            >
              {isDone && <Check size={8} strokeWidth={2.5} />}
            </span>
            <span>{isDone ? "Done" : "Open"}</span>
          </button>
        </div>

        {/* Folder */}
        <div className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Folder</span>
          <FolderChip folders={folders} onChange={handleFolderChange} value={page.folderId} />
        </div>

        {/* Date / time */}
        <div className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Date</span>
          <DateTimePicker
            endValue={page.scheduledEnd ?? null}
            isDone={isDone}
            onChange={handleDateChange}
            onEndChange={handleEndChange}
            value={page.scheduledStart ?? null}
          />
        </div>

        {/* Priority */}
        <div className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Priority</span>
          <PriorityDropdown
            onSelect={handlePriorityChange}
            priority={page.priority}
            variant="byline"
          />
        </div>
      </div>

      {/* Open page */}
      <div className="border-t border-border/40 pt-1">
        <button
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/60 transition-colors hover:text-foreground focus:outline-none"
          onClick={handleOpenPage}
        >
          <ExternalLink size={11} />
          Open page
        </button>
      </div>
    </div>
  );
}
