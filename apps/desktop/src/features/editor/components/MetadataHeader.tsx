// MetadataHeader — page metadata panel rendered above the editor scroll area.
// key={page.id} in parent resets all state on page switch.

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { PriorityDropdown } from "@/features/pages/components/PriorityDropdown";
import { FolderChip } from "@/features/pages/components/FolderChip";
import { TagsPopover } from "@/features/pages/components/TagsPopover";
import { DateSchedulePopover } from "./DateSchedulePopover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Folder, Page, PagePriority, PageStatus } from "@pikos/core";

// ─── Byline ───────────────────────────────────────────────────────────────────
// Flat inline metadata row. No pill backgrounds — reads as a document byline.

function BylineSeparator() {
  return (
    <span className="text-muted-foreground/20" aria-hidden="true">
      ·
    </span>
  );
}

function Byline({
  page,
  folders,
  allTags,
  onStatusChange,
  onFolderChange,
  onPriorityChange,
  onTagToggle,
  saveError,
  onErrorClick,
}: {
  page: Page;
  folders: Folder[];
  allTags: string[];
  onStatusChange: (status: PageStatus) => void;
  onFolderChange: (folderId: string | null) => void;
  onPriorityChange: (priority: PagePriority) => void;
  onTagToggle: (name: string) => void;
  saveError?: string | null;
  onErrorClick?: () => void;
}) {
  const isDone = page.status === "done";

  return (
    <div className="flex flex-wrap items-center gap-2 pt-2 pb-4 text-sm text-muted-foreground/60">
      {/* Status toggle */}
      <button
        className="inline-flex items-center gap-1.5 rounded transition-colors hover:text-muted-foreground focus:outline-none"
        aria-label={isDone ? "Mark not done" : "Mark done"}
        onClick={() => onStatusChange(isDone ? "not_started" : "done")}
      >
        <span
          className={`flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[2px] border transition-colors ${isDone ? "border-foreground/40 bg-foreground/10" : "border-muted-foreground/40 hover:border-foreground/60"}`}
        >
          {isDone && <Check size={8} strokeWidth={2.5} />}
        </span>
        <span className="inline-block w-[2.5rem]">{isDone ? "Done" : "Open"}</span>
      </button>

      {/* Folder */}
      <BylineSeparator />
      <FolderChip folders={folders} value={page.folderId} onChange={onFolderChange} />

      {/* Date — GOO-34 */}
      <BylineSeparator />
      <DateSchedulePopover page={page} />

      {/* Priority selector — GOO-35 */}
      <BylineSeparator />
      <PriorityDropdown priority={page.priority} onSelect={onPriorityChange} variant="byline" />

      {/* Tags popover */}
      <BylineSeparator />
      <TagsPopover allTags={allTags} selected={page.tags} onToggle={onTagToggle} />

      {/* Save error — sticky, click to retry */}
      {saveError != null && (
        <>
          <BylineSeparator />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onErrorClick}
                aria-label="Save failed — click to retry"
                className="inline-flex items-center gap-1 rounded text-amber-500/70 transition-colors hover:text-amber-500 focus:outline-none"
              >
                <AlertTriangle size={12} strokeWidth={2} />
                <span>Not saved</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[260px]">
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
  page,
  onFocusEditor,
  contentSaveError,
  onRetryContent,
}: MetadataHeaderProps) {
  const { folders, tags, updatePage, flushPage, pageErrors, clearPageError } = useWorkspace();
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
      status,
      completedAt: status === "done" ? new Date().toISOString() : null,
    });
  }

  function handleFolderChange(folderId: string | null) {
    updatePage(page.id, { folderId });
  }

  function handlePriorityChange(priority: PagePriority) {
    updatePage(page.id, { priority });
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
    const { selectionStart: start, selectionEnd: end } = el;
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
    const { selectionStart: start, selectionEnd: end } = el;
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
            ref={titleRef}
            rows={1}
            value={titleValue}
            onChange={handleTitleChange}
            onPaste={handleTitlePaste}
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
            onFocus={(e) => {
              setTitleFocused(true);
              requestAnimationFrame(() =>
                e.target.setSelectionRange(e.target.value.length, e.target.value.length)
              );
            }}
            onBlur={() => setTitleFocused(false)}
            autoComplete="off"
            placeholder="Untitled"
            aria-label="Page title"
            className={`max-h-20 w-full resize-none overflow-hidden bg-transparent text-4xl font-bold tracking-tight outline-none placeholder:text-muted-foreground/30 ${titleShake ? "animate-shake" : ""}`}
          />
        </div>

        <textarea
          ref={subtitleRef}
          rows={1}
          value={subtitleValue}
          onChange={handleSubtitleChange}
          onPaste={handleSubtitlePaste}
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
          onFocus={() => setSubtitleFocused(true)}
          onBlur={() => setSubtitleFocused(false)}
          placeholder="Add a description…"
          aria-label="Page description"
          className={`mt-1 max-h-[4.5rem] w-full resize-none overflow-hidden bg-transparent text-base text-muted-foreground outline-none placeholder:text-muted-foreground/30 ${subtitleShake ? "animate-shake" : ""}`}
        />

        <Byline
          page={page}
          folders={folders}
          allTags={allTagNames}
          onStatusChange={handleStatusChange}
          onFolderChange={handleFolderChange}
          onPriorityChange={handlePriorityChange}
          onTagToggle={handleTagToggle}
          saveError={hasError ? (errorMessage ?? "Save failed") : null}
          onErrorClick={handleErrorClick}
        />
      </div>
    </div>
  );
}
