// MetadataHeader — page metadata panel rendered above the editor scroll area.
// key={page.id} in parent resets all state on page switch.

import type { Folder, Page, PagePriority, PageStatus } from "@pikos/core";
import { nowLocalISO, parseLocalISO } from "@pikos/core";
import { AlertTriangle, CalendarDays, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FolderChip, PriorityDropdown, TagsPopover } from "@/features/pages";
import { KeyboardShortcut } from "@/shared/components/KeyboardShortcut";
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

  return (
    <div className="type-ui-sm flex flex-wrap items-center gap-2 pt-2 pb-4 text-subtle">
      {/* Status toggle */}
      <button
        aria-label={isDone ? "Mark not done" : "Mark done"}
        className="inline-flex items-center gap-1.5 rounded transition-colors hover:text-muted-foreground focus:outline-none"
        onClick={() => onStatusChange(isDone ? "not_started" : "done")}
      >
        <span
          className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[2px] border transition-colors ${isDone ? "border-foreground/40 bg-foreground/10" : "border-muted-foreground/40 hover:border-foreground/60"}`}
        >
          {isDone && <Check size={8} strokeWidth={2.5} />}
        </span>
        <span className="inline-block w-[2.5rem]">{isDone ? "Done" : "Open"}</span>
      </button>

      {/* Folder */}
      <BylineSeparator />
      <FolderChip folders={folders} onChange={onFolderChange} value={page.folderId} />

      {/* Date — GOO-34 */}
      <BylineSeparator />
      <DateSchedulePopover page={page} />

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
                <CalendarDays size={13} />
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
  const { clearPageError, flushPage, folders, pageErrors, tags, updatePage } = useWorkspace();
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
  const [titleShake, setTitleShake] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  const [prevTitle, setPrevTitle] = useState(page.title ?? "");
  if ((page.title ?? "") !== prevTitle) {
    setPrevTitle(page.title ?? "");
    if (!titleFocused) setTitleValue(page.title ?? "");
  }

  // Auto-resize on valid value changes (no revert logic — handled in onChange/onPaste).
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [titleValue]);

  function getMaxHeight(el: HTMLTextAreaElement, lines: number): number {
    return parseFloat(getComputedStyle(el).lineHeight) * lines;
  }

  function triggerShake() {
    setTitleShake(true);
    setTimeout(() => setTitleShake(false), 300);
  }

  function handleTitleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    const next = e.target.value;
    el.style.height = "auto";
    if (el.scrollHeight > getMaxHeight(el, 2)) {
      // Revert DOM synchronously so React never sees the overflow value.
      el.value = titleValue;
      el.style.height = `${el.scrollHeight}px`;
      triggerShake();
      return;
    }
    setTitleValue(next);
    updatePage(page.id, { title: next });
  }

  function handleTitlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    const pasted = e.clipboardData.getData("text").replace(/\n/g, " ");
    const { selectionEnd: end, selectionStart: start } = el;
    const next = titleValue.slice(0, start ?? 0) + pasted + titleValue.slice(end ?? 0);

    // Measure the candidate value by temporarily writing to DOM.
    el.value = next;
    el.style.height = "auto";
    if (el.scrollHeight > getMaxHeight(el, 2)) {
      // Binary-search the longest prefix of `next` that fits.
      let lo = 0;
      let hi = next.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        el.value = next.slice(0, mid);
        el.style.height = "auto";
        if (el.scrollHeight <= getMaxHeight(el, 2)) lo = mid;
        else hi = mid - 1;
      }
      el.value = titleValue; // restore; setTitleValue below re-renders correctly
      setTitleValue(next.slice(0, lo));
      updatePage(page.id, { title: next.slice(0, lo) });
      triggerShake();
    } else {
      el.value = titleValue;
      setTitleValue(next);
      updatePage(page.id, { title: next });
    }
  }

  // ── Subtitle ───────────────────────────────────────────────────────────────

  const [subtitleValue, setSubtitleValue] = useState(page.subtitle ?? "");
  const [subtitleFocused, setSubtitleFocused] = useState(false);
  const [subtitleShake, setSubtitleShake] = useState(false);
  const subtitleRef = useRef<HTMLTextAreaElement>(null);

  const [prevSubtitle, setPrevSubtitle] = useState(page.subtitle ?? "");
  if ((page.subtitle ?? "") !== prevSubtitle) {
    setPrevSubtitle(page.subtitle ?? "");
    if (!subtitleFocused) setSubtitleValue(page.subtitle ?? "");
  }

  useEffect(() => {
    const el = subtitleRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [subtitleValue]);

  function handleSubtitleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    const next = e.target.value;
    el.style.height = "auto";
    if (el.scrollHeight > getMaxHeight(el, 3)) {
      el.value = subtitleValue;
      el.style.height = `${el.scrollHeight}px`;
      setSubtitleShake(true);
      setTimeout(() => setSubtitleShake(false), 300);
      return;
    }
    setSubtitleValue(next);
    updatePage(page.id, { subtitle: next });
  }

  function handleSubtitlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    const pasted = e.clipboardData.getData("text").replace(/\n/g, " ");
    const { selectionEnd: end, selectionStart: start } = el;
    const next = subtitleValue.slice(0, start ?? 0) + pasted + subtitleValue.slice(end ?? 0);

    el.value = next;
    el.style.height = "auto";
    if (el.scrollHeight > getMaxHeight(el, 3)) {
      let lo = 0;
      let hi = next.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        el.value = next.slice(0, mid);
        el.style.height = "auto";
        if (el.scrollHeight <= getMaxHeight(el, 3)) lo = mid;
        else hi = mid - 1;
      }
      el.value = subtitleValue;
      setSubtitleValue(next.slice(0, lo));
      updatePage(page.id, { subtitle: next.slice(0, lo) });
      setSubtitleShake(true);
      setTimeout(() => setSubtitleShake(false), 300);
    } else {
      el.value = subtitleValue;
      setSubtitleValue(next);
      updatePage(page.id, { subtitle: next });
    }
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
      <div className="mx-auto max-w-[720px] px-8">
        <div className="pt-12 pb-1">
          <textarea
            aria-label="Page title"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className={`type-display max-h-20 w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-faint ${titleShake ? "animate-shake" : ""}`}
            onBlur={() => setTitleFocused(false)}
            onChange={handleTitleChange}
            onFocus={(e) => {
              setTitleFocused(true);
              requestAnimationFrame(() =>
                e.target.setSelectionRange(e.target.value.length, e.target.value.length)
              );
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                subtitleRef.current?.focus();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onFocusEditor();
              }
            }}
            onPaste={handleTitlePaste}
            placeholder="Untitled"
            ref={titleRef}
            rows={1}
            value={titleValue}
          />
        </div>

        <textarea
          aria-label="Page description"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className={`type-body mt-1 max-h-[4.5rem] w-full resize-none overflow-hidden bg-transparent leading-relaxed text-muted-foreground outline-none placeholder:text-faint ${subtitleShake ? "animate-shake" : ""}`}
          onBlur={() => setSubtitleFocused(false)}
          onChange={handleSubtitleChange}
          onFocus={() => setSubtitleFocused(true)}
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
          onPaste={handleSubtitlePaste}
          placeholder="Add a description…"
          ref={subtitleRef}
          rows={1}
          value={subtitleValue}
        />

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
