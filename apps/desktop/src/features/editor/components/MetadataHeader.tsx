// key={page.id} in parent resets all state on page switch.

import type { Folder, Page, PagePriority, PageStatus } from "@pikos/core";
import {
  getLocalTimezone,
  isDone,
  isTimedIso,
  localToday,
  nowLocalISO,
  parseLocalISO,
  snapAnchorToRule,
  storageErrorUserMessage,
  toStorageError,
} from "@pikos/core";
import { AlertTriangle, CalendarDays } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FolderChip } from "@/shared/components/FolderChip";
import { KeyboardShortcut } from "@/shared/components/KeyboardShortcut";
import { PriorityDropdown } from "@/shared/components/PriorityDropdown";
import { RecurrencePopover } from "@/shared/components/RecurrencePopover";
import { ReminderDropdown } from "@/shared/components/ReminderDropdown";
import { TagsPopover } from "@/shared/components/TagsPopover";
import { TaskCheckbox } from "@/shared/components/TaskCheckbox";
import { LINE_WIDTH_CLASS } from "@/shared/constants/editor";
import { useEditorSettings } from "@/shared/context/EditorSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import { useRecurringCompleteDialog } from "@/shared/context/RecurringCompleteDialogContext";
import { useUI } from "@/shared/context/UIContext";

import { DateSchedulePopover } from "./DateSchedulePopover";

function BylineSeparator() {
  return (
    <span aria-hidden="true" className="text-muted-foreground/20">
      ·
    </span>
  );
}

function Byline({
  allTags,
  folders,
  onErrorClick,
  onFolderChange,
  onOpenInCalendar,
  onPriorityChange,
  onRecurrenceChange,
  onStatusChange,
  onTagToggle,
  page,
  saveError,
}: {
  page: Page;
  folders: Folder[];
  allTags: string[];
  onStatusChange: (status: PageStatus) => void;
  onFolderChange: (folderId: string | null) => void;
  onPriorityChange: (priority: PagePriority) => void;
  onTagToggle: (name: string) => void;
  onRecurrenceChange: (rrule: string | null) => void;
  onOpenInCalendar?: () => void;
  saveError?: string | null;
  onErrorClick?: () => void;
}) {
  const done = isDone(page);
  const { recurrenceRules } = usePages();
  const recurrenceRule = recurrenceRules.find((r) => r.pageId === page.id);

  return (
    <div className="type-ui-sm flex items-center gap-2 overflow-hidden pt-2 pb-4 text-subtle">
      <button
        aria-label={done ? "Mark not done" : "Mark done"}
        className="group/status inline-flex items-center gap-1.5 rounded transition-colors hover:text-muted-foreground focus:outline-none"
        onClick={() => onStatusChange(done ? "not_started" : "done")}
      >
        <TaskCheckbox
          as="span"
          checked={done}
          className={!done ? "group-hover/status:border-foreground/60" : undefined}
          onChange={() => onStatusChange(done ? "not_started" : "done")}
        />
        <span className="inline-block w-[2.5rem]">{done ? "Done" : "Open"}</span>
      </button>

      <BylineSeparator />
      <FolderChip folders={folders} onChange={onFolderChange} value={page.folderId} />

      <BylineSeparator />
      <div className="inline-flex shrink-0 items-center gap-2">
        <DateSchedulePopover page={page} />
        {/* Reminders only apply to timed events — all-day schedules have no
            start time to fire "minutes before" against, so the scheduler
            ignores them (see notifications/scheduler). Hide the bell to match. */}
        {!!page.scheduledStart && isTimedIso(page.scheduledStart) && (
          <ReminderDropdown pageId={page.id} />
        )}
        <RecurrencePopover
          anchorDate={page.scheduledStart ?? null}
          onChange={onRecurrenceChange}
          rrule={recurrenceRule?.rrule ?? null}
          variant="icon"
        />
        {onOpenInCalendar && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="View in calendar"
                className="inline-flex items-center rounded transition-colors hover:text-muted-foreground focus:outline-none"
                onClick={onOpenInCalendar}
              >
                <CalendarDays size={13} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <span className="inline-flex items-center gap-1.5">
                View in calendar <KeyboardShortcut shortcut="mod+shift+c" />
              </span>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <BylineSeparator />
      <PriorityDropdown onSelect={onPriorityChange} priority={page.priority} variant="byline" />

      <BylineSeparator />
      <TagsPopover allTags={allTags} onToggle={onTagToggle} selected={page.tags} />

      {saveError != null && (
        <>
          <BylineSeparator />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="Save failed — click to retry"
                className="inline-flex items-center gap-1 rounded text-amber-500/70 transition-colors hover:text-amber-500 focus:outline-none"
                onClick={onErrorClick}
              >
                <AlertTriangle size={12} strokeWidth={2} />
                <span>Not saved</span>
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px]" side="bottom">
              {saveError}
            </TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  );
}

interface MetadataHeaderProps {
  page: Page;
  onFocusEditor: () => void;
  contentSaveError?: Error | null;
  onRetryContent?: () => void;
}

export function MetadataHeader({
  contentSaveError,
  onFocusEditor,
  onRetryContent,
  page,
}: MetadataHeaderProps) {
  const {
    clearPageError,
    createRecurrence,
    deleteRecurrence,
    flushPage,
    folders,
    pageErrors,
    recurrenceRules,
    scheduleOnce,
    tags,
    updatePage,
    updateRecurrence,
  } = usePages();
  const { request: requestRecurringComplete } = useRecurringCompleteDialog();
  const { lineWidth } = useEditorSettings();
  const { flashPageBlock, requestCalendarScroll, setReferenceDate, setRightPanel } = useUI();
  const allTagNames = tags.map((t) => t.name);

  const metadataError = pageErrors.get(page.id) ?? null;
  const hasError = !!(metadataError ?? contentSaveError);
  // Friendly per-kind copy from @pikos/core — never echoes raw sqlx/Tauri text.
  const errorMessage = metadataError
    ? storageErrorUserMessage(metadataError, "saving page metadata")
    : contentSaveError
      ? storageErrorUserMessage(toStorageError(contentSaveError), "saving page content")
      : null;

  function handleErrorClick() {
    clearPageError(page.id);
    onRetryContent?.();
  }

  function handleStatusChange(status: PageStatus) {
    // Recurring pages route through the gap-resolution dialog. The dialog
    // fast-paths when there's no gap between head and today.
    if (status === "done" && recurrenceRules.some((r) => r.pageId === page.id)) {
      requestRecurringComplete(page.id);
      return;
    }
    updatePage(page.id, {
      completedAt: status === "done" ? nowLocalISO() : null,
      status,
    });
  }

  function handleFolderChange(folderId: string | null) {
    updatePage(page.id, { folderId });
  }

  function handlePriorityChange(priority: PagePriority) {
    updatePage(page.id, { priority });
  }

  function handleOpenInCalendar() {
    const start = page.scheduledStart!;
    setReferenceDate(parseLocalISO(start));
    // Date-only (all-day) strings have no time component — the chip sits in the
    // always-visible all-day strip, so no timed-grid scroll needed.
    if (isTimedIso(start)) {
      const startDate = parseLocalISO(start);
      const pageHour = startDate.getHours() + startDate.getMinutes() / 60;
      requestCalendarScroll(Math.max(0, pageHour - 1));
    }
    setRightPanel("calendar");
    flashPageBlock(page.id);
  }

  function handleTagToggle(name: string) {
    const next = page.tags.includes(name)
      ? page.tags.filter((t) => t !== name)
      : [...page.tags, name];
    updatePage(page.id, { tags: next });
  }

  async function handleRecurrenceChange(rrule: string | null) {
    const existing = recurrenceRules.find((r) => r.pageId === page.id);
    if (!rrule) {
      if (existing) await deleteRecurrence(existing.id);
      return;
    }
    if (existing) {
      await updateRecurrence(existing.id, { rrule });
      // Changing BYDAY can leave the head on a weekday the rule now excludes;
      // snap it (and the rule anchor, via scheduleOnce) onto the first allowed
      // occurrence so no stray "first run" lingers on the old day.
      const snapped = snapAnchorToRule(rrule, existing.scheduledStart);
      if (snapped !== existing.scheduledStart) {
        await scheduleOnce(page.id, snapped, page.scheduledEnd ?? undefined);
      }
      return;
    }
    // No existing rule. If the page has no date yet, anchor to today so the
    // first occurrence is concrete. Snap the anchor onto the first date the
    // rule permits (e.g. a Sunday date under an M/W/F rule moves to Monday).
    // Await scheduleOnce so the rule's anchor and the head's scheduledStart
    // commit together — otherwise a failed scheduleOnce leaves a rule
    // referencing a date the head doesn't carry.
    const anchorStart = snapAnchorToRule(rrule, page.scheduledStart ?? localToday());
    if (anchorStart !== page.scheduledStart) {
      await scheduleOnce(page.id, anchorStart, page.scheduledEnd ?? undefined);
    }
    const tz = getLocalTimezone();
    await createRecurrence({
      pageId: page.id,
      rrule,
      scheduledStart: anchorStart,
      ...(page.scheduledEnd ? { scheduledEnd: page.scheduledEnd } : {}),
      timezone: tz,
    });
  }

  const [titleValue, setTitleValue] = useState(page.title ?? "");
  const [titleFocused, setTitleFocused] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const titleDivRef = useRef<HTMLDivElement>(null);
  const titleHeightRef = useRef<number | undefined>(undefined);

  const [prevTitle, setPrevTitle] = useState(page.title ?? "");
  if ((page.title ?? "") !== prevTitle) {
    setPrevTitle(page.title ?? "");
    if (!titleFocused) setTitleValue(page.title ?? "");
  }

  function handleTitleFocus() {
    // Measure div height before swapping so textarea starts at exactly the same size.
    if (titleDivRef.current) {
      titleHeightRef.current = titleDivRef.current.offsetHeight;
    }
    setTitleFocused(true);
  }

  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    // Shrink to 0 to measure true scrollHeight (avoids stale height inflating it).
    // On first mount after focus, start from the div's measured height so the
    // initial frame has no shift — scrollHeight will only grow from there.
    el.style.height = titleHeightRef.current !== undefined ? `${titleHeightRef.current}px` : "0";
    titleHeightRef.current = undefined;
    el.style.height = `${el.scrollHeight}px`;
    if (titleFocused) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [titleValue, titleFocused]);

  function handleTitleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    setTitleValue(next);
    updatePage(page.id, { title: next });
  }

  const [subtitleValue, setSubtitleValue] = useState(page.subtitle ?? "");
  const [subtitleFocused, setSubtitleFocused] = useState(false);
  const subtitleRef = useRef<HTMLTextAreaElement>(null);
  const subtitleDivRef = useRef<HTMLDivElement>(null);
  const subtitleHeightRef = useRef<number | undefined>(undefined);

  const [prevSubtitle, setPrevSubtitle] = useState(page.subtitle ?? "");
  if ((page.subtitle ?? "") !== prevSubtitle) {
    setPrevSubtitle(page.subtitle ?? "");
    if (!subtitleFocused) setSubtitleValue(page.subtitle ?? "");
  }

  function handleSubtitleFocus() {
    if (subtitleDivRef.current) {
      subtitleHeightRef.current = subtitleDivRef.current.offsetHeight;
    }
    setSubtitleFocused(true);
  }

  useEffect(() => {
    const el = subtitleRef.current;
    if (!el) return;
    el.style.height =
      subtitleHeightRef.current !== undefined ? `${subtitleHeightRef.current}px` : "0";
    subtitleHeightRef.current = undefined;
    el.style.height = `${el.scrollHeight}px`;
    if (subtitleFocused) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [subtitleValue, subtitleFocused]);

  function handleSubtitleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    setSubtitleValue(next);
    updatePage(page.id, { subtitle: next });
  }

  useEffect(() => {
    function handleBlur() {
      void flushPage(page.id);
    }
    window.addEventListener("blur", handleBlur);
    return () => window.removeEventListener("blur", handleBlur);
  }, [flushPage, page.id]);

  return (
    <div className="shrink-0">
      <div className={`mx-auto ${LINE_WIDTH_CLASS[lineWidth] ?? "max-w-[720px]"} px-8`}>
        <div className="pt-12 pb-1">
          {titleFocused ? (
            <textarea
              aria-label="Page title"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              className="type-display [margin:0] block w-full resize-none overflow-hidden bg-transparent [padding:0] outline-none [border:none] placeholder:text-faint"
              onBlur={() => setTitleFocused(false)}
              onChange={handleTitleChange}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setTitleFocused(false);
                  handleSubtitleFocus();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  onFocusEditor();
                }
              }}
              placeholder="Untitled"
              ref={titleRef}
              rows={1}
              value={titleValue}
            />
          ) : (
            <div
              aria-label="Page title"
              className="type-display line-clamp-2 w-full cursor-text bg-transparent outline-none"
              onClick={handleTitleFocus}
              onFocus={handleTitleFocus}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleTitleFocus();
                }
              }}
              ref={titleDivRef}
              role="button"
              tabIndex={0}
            >
              {titleValue || <span className="text-faint">Untitled</span>}
            </div>
          )}
        </div>

        {subtitleFocused ? (
          <textarea
            aria-label="Page description"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className="type-body [margin-inline:0] mt-1 [margin-bottom:0] block min-h-[23px] w-full resize-none overflow-hidden bg-transparent [padding:0] leading-[23px] text-muted-foreground outline-none [border:none] placeholder:text-faint"
            onBlur={() => setSubtitleFocused(false)}
            onChange={handleSubtitleChange}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onFocusEditor();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onFocusEditor();
              }
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                onFocusEditor();
              }
            }}
            placeholder="Add a description…"
            ref={subtitleRef}
            rows={1}
            value={subtitleValue}
          />
        ) : (
          <div
            aria-label="Page description"
            className="type-body mt-1 min-h-[23px] w-full cursor-text leading-[23px] text-muted-foreground outline-none"
            onClick={handleSubtitleFocus}
            onFocus={handleSubtitleFocus}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleSubtitleFocus();
              }
            }}
            ref={subtitleDivRef}
            role="button"
            tabIndex={0}
          >
            {subtitleValue ? (
              <span className="line-clamp-3">{subtitleValue}</span>
            ) : (
              <span className="text-faint">Add a description…</span>
            )}
          </div>
        )}

        <Byline
          allTags={allTagNames}
          folders={folders}
          onErrorClick={handleErrorClick}
          onFolderChange={handleFolderChange}
          {...(page.scheduledStart ? { onOpenInCalendar: handleOpenInCalendar } : {})}
          onPriorityChange={handlePriorityChange}
          onRecurrenceChange={(rrule) => void handleRecurrenceChange(rrule)}
          onStatusChange={handleStatusChange}
          onTagToggle={handleTagToggle}
          page={page}
          saveError={hasError ? (errorMessage ?? "Save failed") : null}
        />
      </div>
    </div>
  );
}
