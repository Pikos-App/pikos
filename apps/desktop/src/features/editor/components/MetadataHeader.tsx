// key={page.id} in parent resets all state on page switch.

import type { Page, PagePriority, PageStatus } from "@pikos/core";
import {
  getLocalTimezone,
  isTimedIso,
  localToday,
  parseLocalISO,
  snapAnchorToRule,
  storageErrorUserMessage,
  toStorageError,
} from "@pikos/core";
import { CalendarOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SyncedEventDetails } from "@/shared/components/SyncedEventDetails";
import { SyncedLockHint } from "@/shared/components/SyncedLockHint";
import { LINE_WIDTH_CLASS } from "@/shared/constants/editor";
import { useEditorSettings } from "@/shared/context/EditorSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useRecurringStatusToggle } from "@/shared/hooks/useRecurringStatusToggle";

import { Byline } from "./Byline";
import { CalendarDescriptionNotice } from "./CalendarDescriptionNotice";
import { FocusTimer } from "./FocusTimer";

interface MetadataHeaderProps {
  page: Page;
  onFocusEditor: () => void;
  /** Appends text to the end of the body through the editor's own insert path,
   *  so the write marks the page owned exactly as typing would. */
  onAppendToBody: (text: string) => void;
  contentSaveError?: Error | null;
  onRetryContent?: () => void;
}

export function MetadataHeader({
  contentSaveError,
  onAppendToBody,
  onFocusEditor,
  onRetryContent,
  page,
}: MetadataHeaderProps) {
  const {
    clearPageError,
    clearPendingDescription,
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
  const togglePageStatus = useRecurringStatusToggle();
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
    togglePageStatus(page, status);
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

  // A missing scheduleLocked flag defaults to editable (native); detached pages
  // unlock (sync_state !== 'active') but stay flagged as disconnected.
  const titleLocked = page.scheduleLocked;
  const detached = page.syncState === "detached";
  const calendarName = folders.find((f) => f.id === page.folderId)?.name ?? "the calendar";
  // Only a locked (active-sync) page ever carries a withheld upstream description.
  const showDescriptionNotice = titleLocked && !!page.pendingDescription;

  return (
    <div className="shrink-0">
      <div className={`mx-auto ${LINE_WIDTH_CLASS[lineWidth] ?? "max-w-[720px]"} px-8`}>
        {detached && (
          <div className="mt-10 flex items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-amber-600/90 dark:text-amber-400/90">
            <CalendarOff aria-hidden="true" className="shrink-0" size={14} />
            <span className="type-ui-sm">
              Disconnected from {calendarName} — this is now a regular page you can edit.
            </span>
          </div>
        )}
        {showDescriptionNotice && (
          <CalendarDescriptionNotice
            onAppend={() => {
              onAppendToBody(page.pendingDescription!);
              void clearPendingDescription(page.id);
            }}
            onDismiss={() => void clearPendingDescription(page.id)}
            text={page.pendingDescription!}
          />
        )}
        <div className={detached || showDescriptionNotice ? "pt-2 pb-1" : "pt-12 pb-1"}>
          {titleFocused && !titleLocked ? (
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
          ) : titleLocked ? (
            <div className="flex items-center gap-2">
              <div
                aria-label="Page title"
                className="type-display line-clamp-2 min-w-0 cursor-default bg-transparent outline-none"
                ref={titleDivRef}
              >
                {titleValue || <span className="text-faint">Untitled</span>}
              </div>
              <SyncedLockHint size={14} />
            </div>
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

        {/* The timer repeats the byline's own `pt-2 pb-4` so both boxes have the
            same vertical padding: `items-center` aligns boxes, not text, and the
            byline's asymmetric padding would otherwise push the timer below the
            copy it sits beside. `min-w-0` lets the byline keep truncating its
            chips instead of pushing the timer off. */}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
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
          <div className="pt-2 pb-4">
            <FocusTimer pageId={page.id} />
          </div>
        </div>

        {titleLocked && (
          <SyncedEventDetails
            attendees={page.mirrorAttendees}
            className="pb-4"
            location={page.mirrorLocation}
          />
        )}
      </div>
    </div>
  );
}
