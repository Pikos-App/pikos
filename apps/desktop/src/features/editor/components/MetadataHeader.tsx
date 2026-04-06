// MetadataHeader — page metadata panel rendered above the editor scroll area.
// key={page.id} in parent resets all state on page switch.

import type { Folder, Page, PagePriority, PageStatus } from "@pikos/core";
import { nowLocalISO, parseLocalISO, rruleToLabel } from "@pikos/core";
import { AlertTriangle, CalendarDays, Repeat2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FolderChip, PriorityDropdown, TagsPopover } from "@/features/pages";
import { KeyboardShortcut } from "@/shared/components/KeyboardShortcut";
import { ReminderDropdown } from "@/shared/components/ReminderDropdown";
import { TaskCheckbox } from "@/shared/components/TaskCheckbox";
import { LINE_WIDTH_CLASS } from "@/shared/constants/editor";
import { useEditorSettings } from "@/shared/context/EditorSettingsContext";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import { DateSchedulePopover } from "./DateSchedulePopover";

// ─── Byline ───────────────────────────────────────────────────────────────────
// Flat inline metadata row. No pill backgrounds — reads as a document byline.

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
  onOpenInCalendar?: () => void;
  saveError?: string | null;
  onErrorClick?: () => void;
}) {
  const isDone = page.status === "done";
  const { recurrenceRules } = useWorkspace();
  const recurrenceRule = recurrenceRules.find((r) => r.pageId === page.id);
  const cadenceLabel = recurrenceRule ? rruleToLabel(recurrenceRule.rrule) : null;

  return (
    <div className="type-ui-sm flex items-center gap-2 overflow-hidden pt-2 pb-4 text-subtle">
      {/* Status toggle */}
      <button
        aria-label={isDone ? "Mark not done" : "Mark done"}
        className="group/status inline-flex items-center gap-1.5 rounded transition-colors hover:text-muted-foreground focus:outline-none"
        onClick={() => onStatusChange(isDone ? "not_started" : "done")}
      >
        <TaskCheckbox
          as="span"
          checked={isDone}
          className={!isDone ? "group-hover/status:border-foreground/60" : undefined}
          onChange={() => onStatusChange(isDone ? "not_started" : "done")}
        />
        <span className="inline-block w-[2.5rem]">{isDone ? "Done" : "Open"}</span>
      </button>

      {/* Folder */}
      <BylineSeparator />
      <FolderChip folders={folders} onChange={onFolderChange} value={page.folderId} />

      {/* Date — GOO-34 */}
      <BylineSeparator />
      <DateSchedulePopover page={page} />

      {/* Reminder bell — per-page reminder override */}
      {!!page.scheduledStart && (
        <>
          <BylineSeparator />
          <ReminderDropdown pageId={page.id} />
        </>
      )}

      {/* Recurrence cadence label */}
      {cadenceLabel && (
        <>
          <BylineSeparator />
          <span className="inline-flex shrink-0 items-center gap-1">
            <Repeat2 className="h-3 w-3" />
            {cadenceLabel}
          </span>
        </>
      )}

      {/* Jump to calendar at scheduled date */}
      {onOpenInCalendar && (
        <>
          <BylineSeparator />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="View in calendar"
                className="inline-flex items-center gap-1 rounded transition-colors hover:text-muted-foreground focus:outline-none"
                onClick={onOpenInCalendar}
              >
                <CalendarDays size={14} />
                <span>View</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <span className="inline-flex items-center gap-1.5">
                View in calendar <KeyboardShortcut shortcut="mod+shift+c" />
              </span>
            </TooltipContent>
          </Tooltip>
        </>
      )}

      {/* Priority selector — GOO-35 */}
      <BylineSeparator />
      <PriorityDropdown onSelect={onPriorityChange} priority={page.priority} variant="byline" />

      {/* Tags popover */}
      <BylineSeparator />
      <TagsPopover allTags={allTags} onToggle={onTagToggle} selected={page.tags} />

      {/* Save error — sticky, click to retry */}
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

// ─── MetadataHeader ──────────────────────────────────────────────────────────

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
    completeRecurringPage,
    flushPage,
    folders,
    pageErrors,
    recurrenceRules,
    tags,
    updatePage,
  } = useWorkspace();
  const { lineWidth } = useEditorSettings();
  const { setReferenceDate, setRightPanel } = useUI();
  const allTagNames = tags.map((t) => t.name);

  const metadataError = pageErrors.get(page.id) ?? null;
  const hasError = !!(metadataError ?? contentSaveError);
  const errorMessage = metadataError ?? contentSaveError?.message ?? null;

  function handleErrorClick() {
    clearPageError(page.id);
    onRetryContent?.();
  }

  function handleStatusChange(status: PageStatus) {
    // Recurring pages use the clone-and-advance flow on completion
    if (status === "done" && recurrenceRules.some((r) => r.pageId === page.id)) {
      void completeRecurringPage(page.id);
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
    setReferenceDate(parseLocalISO(page.scheduledStart!));
    setRightPanel("calendar");
  }

  function handleTagToggle(name: string) {
    const next = page.tags.includes(name)
      ? page.tags.filter((t) => t !== name)
      : [...page.tags, name];
    updatePage(page.id, { tags: next });
  }

  // ── Title ──────────────────────────────────────────────────────────────────

  const [titleValue, setTitleValue] = useState(page.title ?? "");
  const [titleFocused, setTitleFocused] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  const [prevTitle, setPrevTitle] = useState(page.title ?? "");
  if ((page.title ?? "") !== prevTitle) {
    setPrevTitle(page.title ?? "");
    if (!titleFocused) setTitleValue(page.title ?? "");
  }

  // Auto-resize and focus when the textarea mounts (titleFocused becomes true).
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "auto";
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

  // ── Subtitle ───────────────────────────────────────────────────────────────

  const [subtitleValue, setSubtitleValue] = useState(page.subtitle ?? "");
  const [subtitleFocused, setSubtitleFocused] = useState(false);
  const subtitleRef = useRef<HTMLTextAreaElement>(null);

  const [prevSubtitle, setPrevSubtitle] = useState(page.subtitle ?? "");
  if ((page.subtitle ?? "") !== prevSubtitle) {
    setPrevSubtitle(page.subtitle ?? "");
    if (!subtitleFocused) setSubtitleValue(page.subtitle ?? "");
  }

  // Auto-resize and focus when the subtitle textarea mounts.
  useEffect(() => {
    const el = subtitleRef.current;
    if (!el) return;
    el.style.height = "auto";
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

  // ── Flush on window blur ───────────────────────────────────────────────────

  useEffect(() => {
    function handleBlur() {
      void flushPage(page.id);
    }
    window.addEventListener("blur", handleBlur);
    return () => window.removeEventListener("blur", handleBlur);
  }, [flushPage, page.id]);

  // ── Render ─────────────────────────────────────────────────────────────────

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
              className="type-display w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-faint"
              onBlur={() => setTitleFocused(false)}
              onChange={handleTitleChange}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setTitleFocused(false);
                  setSubtitleFocused(true);
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
              className="type-display line-clamp-2 w-full cursor-text bg-transparent outline-none placeholder:text-faint"
              onClick={() => setTitleFocused(true)}
              onFocus={() => setTitleFocused(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setTitleFocused(true);
                }
              }}
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
            className="type-body mt-1 w-full resize-none overflow-hidden bg-transparent leading-relaxed text-muted-foreground outline-none placeholder:text-faint"
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
            className="type-body mt-1 w-full cursor-text leading-relaxed text-muted-foreground outline-none"
            onClick={() => setSubtitleFocused(true)}
            onFocus={() => setSubtitleFocused(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setSubtitleFocused(true);
              }
            }}
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
          onStatusChange={handleStatusChange}
          onTagToggle={handleTagToggle}
          page={page}
          saveError={hasError ? (errorMessage ?? "Save failed") : null}
        />
      </div>
    </div>
  );
}
