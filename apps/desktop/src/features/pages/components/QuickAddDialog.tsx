// QuickAddDialog
// Cmd+N (macOS) / Ctrl+N opens a centered dialog for quick page creation.
// NLP parsing previews on-type (debounced 200ms) — chips update as you type
// but input text is never modified. On submit, the parser extracts the clean
// title and all metadata from the full input.

import { localToday, parseInput, rruleToLabel } from "@pikos/core";
import type { Folder, PagePriority, PageUpdate, ParseResult } from "@pikos/core";
import { Repeat2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type React from "react";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { FolderChip } from "@/features/pages/components/FolderChip";
import { PriorityDropdown } from "@/features/pages/components/PriorityDropdown";
import { TagsPopover } from "@/features/pages/components/TagsPopover";
import { cn } from "@/lib/utils";
import { DateTimePicker } from "@/shared/components/DateTimePicker";
import { NLP_PRIORITY_MAP } from "@/shared/constants/priorities";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

// ── Folder fuzzy match ────────────────────────────────────────────────────────

function fuzzyMatchFolder(query: string, folders: Folder[]): Folder | null {
  if (!query) return null;
  const normalizedQuery = query.toLowerCase();
  return (
    folders.find((folder) => folder.name.toLowerCase() === normalizedQuery) ??
    folders.find((folder) => folder.name.toLowerCase().startsWith(normalizedQuery)) ??
    folders.find((folder) => folder.name.toLowerCase().includes(normalizedQuery)) ??
    null
  );
}

// ── BylineSeparator ───────────────────────────────────────────────────────────

function BylineSeparator() {
  return (
    <span aria-hidden="true" className="shrink-0 text-muted-foreground/20">
      ·
    </span>
  );
}

// ── QuickAddDialog ────────────────────────────────────────────────────────────

export function QuickAddDialog() {
  const { createPage, createRecurrence, folders, scheduleOnce, tags, updatePage } = useWorkspace();
  const allTagNames = tags.map((t) => t.name);
  const { activeViewId, openDialog, setOpenDialog } = useUI();
  const { defaultFolderId: settingsDefaultFolder } = useAppSettings();

  const isOpen = openDialog === "quick-add";
  const inputRef = useRef<HTMLInputElement>(null);

  const [inputValue, setInputValue] = useState("");
  const [shake, setShake] = useState(false);
  const [addedFeedback, setAddedFeedback] = useState<string | null>(null);

  // Active sidebar folder takes precedence, then settings default, then Inbox (null).
  const defaultFolderId =
    folders.find((folder) => folder.id === activeViewId)?.id ?? settingsDefaultFolder;

  // ── Chip state ───────────────────────────────────────────────────────────────
  // Each field has an NLP-set value and a "manually set" flag. runPreview only
  // updates fields the user hasn't touched directly — manual selections survive typing.
  // Tags are split further: nlpTags vs manualTags (union displayed).

  const [dateValue, setDateValue] = useState<string | null>(null);
  const [endDateValue, setEndDateValue] = useState<string | null>(null);
  const [priorityValue, setPriorityValue] = useState<PagePriority>(0);
  const [folderValue, setFolderValue] = useState<string | null>(null);
  const [nlpTags, setNlpTags] = useState<string[]>([]);
  const [manualTags, setManualTags] = useState<string[]>([]);
  const tagsValue = [...new Set([...nlpTags, ...manualTags])];

  const [dateManual, setDateManual] = useState(false);
  const [priorityManual, setPriorityManual] = useState(false);
  const [folderManual, setFolderManual] = useState(false);
  const [recurrenceLabel, setRecurrenceLabel] = useState<string | null>(null);

  // ── Reset form fields when the dialog opens ───────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInputValue("");
    setDateValue(activeViewId === "today" ? localToday() : null);
    setEndDateValue(null);
    setPriorityValue(0);
    setFolderValue(defaultFolderId);
    setNlpTags([]);
    setManualTags([]);
    setDateManual(activeViewId === "today");
    setPriorityManual(false);
    setFolderManual(false);
    setRecurrenceLabel(null);
    setAddedFeedback(null);
  }, [isOpen]);

  // ── Focus input when dialog opens or feedback clears ─────────────────────────
  // Also fires after batch submit clears addedFeedback, remounting the input.

  useEffect(() => {
    if (!isOpen || addedFeedback !== null) return;
    inputRef.current?.focus();
  }, [isOpen, addedFeedback]);

  // ── Keyboard shortcut: Mod+N from anywhere ───────────────────────────────────

  useKeyboardShortcut(
    "Mod+N",
    () => {
      if (isOpen) {
        inputRef.current?.focus();
      } else {
        setOpenDialog("quick-add");
      }
    },
    { allowInInputs: true }
  );

  function handleOpenChange(next: boolean) {
    if (next) {
      setOpenDialog("quick-add");
    } else {
      setOpenDialog(null);
    }
  }

  // ── Debounce preview ─────────────────────────────────────────────────────────
  // Fires 200ms after the user stops typing. Parses the full input and updates
  // chip previews — never modifies the input text. Manual fields are preserved.

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!inputValue.trim()) {
        if (!dateManual) {
          setDateValue(null);
          setEndDateValue(null);
        }
        if (!priorityManual) setPriorityValue(0);
        if (!folderManual) setFolderValue(defaultFolderId);
        setNlpTags([]);
        setRecurrenceLabel(null);
        return;
      }

      const result = parseInput(inputValue);
      const parsed =
        result.type === "single"
          ? result.input
          : result.type === "finite"
            ? result.inputs[0]
            : result.input;
      if (!parsed) return;

      // Show recurrence preview label
      if (result.type === "recurring") {
        setRecurrenceLabel(rruleToLabel(result.rrule));
      } else if (result.type === "finite") {
        setRecurrenceLabel(`${result.count} occurrence${result.count === 1 ? "" : "s"}`);
      } else {
        setRecurrenceLabel(null);
      }

      if (!dateManual) {
        setDateValue(parsed.scheduledStart ?? null);
        const hasTime = parsed.scheduledStart?.includes("T") ?? false;
        setEndDateValue(hasTime ? (parsed.scheduledEnd ?? null) : null);
      }

      if (!priorityManual) {
        setPriorityValue(
          parsed.priority === undefined || parsed.priority === null
            ? 0
            : (NLP_PRIORITY_MAP[parsed.priority] ?? 0)
        );
      }

      if (!folderManual) {
        if (parsed.folderQuery) {
          const match = fuzzyMatchFolder(parsed.folderQuery, folders);
          setFolderValue(
            match ? match.id : parsed.folderQuery.toLowerCase() === "inbox" ? null : folderValue
          );
        } else {
          setFolderValue(defaultFolderId);
        }
      }

      setNlpTags(parsed.tags.length > 0 ? [...new Set(parsed.tags)] : []);
    }, 200);

    return () => clearTimeout(timer);
  }, [inputValue, folders, defaultFolderId, folderValue, dateManual, priorityManual, folderManual]);

  // ── Key handler ───────────────────────────────────────────────────────────────

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) {
        void handleSubmitBatch();
      } else {
        void handleSubmit();
      }
    }
  }

  // ── Submit ────────────────────────────────────────────────────────────────────

  /** Shared submission logic. Returns the created page title, or null if validation failed. */
  async function submitPage(): Promise<string | null> {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setShake(true);
      setTimeout(() => setShake(false), 300);
      inputRef.current?.focus();
      return null;
    }

    // Parse the full, unstripped input on submit.
    const result = parseInput(trimmed);
    return executeCreate(result);
  }

  /** Actually creates the page(s) from a parse result (after any confirmation). */
  async function executeCreate(result: ParseResult): Promise<string | null> {
    const parsed =
      result.type === "single"
        ? result.input
        : result.type === "finite"
          ? result.inputs[0]
          : result.input;

    // Folder: NLP folderQuery takes precedence over chip selection.
    let resolvedFolderId = folderValue;
    if (parsed?.folderQuery) {
      const match = fuzzyMatchFolder(parsed.folderQuery, folders);
      if (match) {
        resolvedFolderId = match.id;
      } else if (parsed.folderQuery.toLowerCase() === "inbox") {
        resolvedFolderId = null;
      }
    }

    // Merge: parsed values override chip state; chip state is the fallback.
    const resolvedDate = parsed?.scheduledStart ?? dateValue;
    const resolvedPriority =
      parsed?.priority !== undefined
        ? parsed.priority === null
          ? 0
          : (NLP_PRIORITY_MAP[parsed.priority] ?? 0)
        : priorityValue;

    // Use parsed.title (tokens already stripped by parser) as the page title.
    const title = parsed?.title || inputValue.trim();

    // Fresh NLP tags from re-parse + manual additions.
    const finalTags = [...new Set([...(parsed?.tags ?? []), ...manualTags])];

    const patch: PageUpdate = {};
    if (resolvedPriority !== 0) patch.priority = resolvedPriority;
    if (finalTags.length > 0) patch.tags = finalTags;

    if (result.type === "recurring") {
      // Infinite recurrence: 1 template page + recurrence rule.
      const page = await createPage({ folderId: resolvedFolderId, title });
      if (Object.keys(patch).length > 0) updatePage(page.id, patch);

      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const ruleStart = resolvedDate ?? localToday();
      await createRecurrence({
        pageId: page.id,
        rrule: result.rrule,
        scheduledStart: ruleStart,
        ...(parsed?.scheduledEnd ? { scheduledEnd: parsed.scheduledEnd } : {}),
        timezone: tz,
      });
      // Set head's scheduledStart denorm so it appears in Today/calendar
      updatePage(page.id, {
        scheduledStart: ruleStart,
        ...(parsed?.scheduledEnd ? { scheduledEnd: parsed.scheduledEnd } : {}),
      });
      return title;
    }

    if (result.type === "finite") {
      // Finite recurrence: N independent pages, each with its own schedule.
      for (const inp of result.inputs) {
        const pg = await createPage({ folderId: resolvedFolderId, title: inp.title || title });
        const finPatch: PageUpdate = {};
        if (resolvedPriority !== 0) finPatch.priority = resolvedPriority;
        const finTags = [...new Set([...inp.tags, ...manualTags])];
        if (finTags.length > 0) finPatch.tags = finTags;
        if (Object.keys(finPatch).length > 0) updatePage(pg.id, finPatch);
        if (inp.scheduledStart) {
          await scheduleOnce(pg.id, inp.scheduledStart, inp.scheduledEnd);
        }
      }
      return title;
    }

    // Single page
    const page = await createPage({ folderId: resolvedFolderId, title });
    if (Object.keys(patch).length > 0) updatePage(page.id, patch);

    if (resolvedDate) {
      const hasTime = resolvedDate.includes("T");
      const resolvedEnd = hasTime ? (parsed?.scheduledEnd ?? endDateValue ?? undefined) : undefined;
      await scheduleOnce(page.id, resolvedDate, resolvedEnd);
    }

    return title;
  }

  /** Enter — commit and close. */
  async function handleSubmit() {
    const title = await submitPage();
    if (title !== null) setOpenDialog(null);
  }

  /**
   * Cmd+Enter — commit, show brief confirmation, then reset fields so the user
   * can immediately add another page in the same folder scope.
   */
  async function handleSubmitBatch() {
    const title = await submitPage();
    if (title === null) return;

    setAddedFeedback(title);
    setInputValue("");
    setDateValue(null);
    setEndDateValue(null);
    setPriorityValue(0);
    setNlpTags([]);
    setManualTags([]);
    setDateManual(false);
    setPriorityManual(false);
    // Keep folderValue and folderManual — user stays in same folder scope.
    setTimeout(() => {
      setAddedFeedback(null);
    }, 1000);
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <Dialog onOpenChange={handleOpenChange} open={isOpen}>
      <DialogContent
        aria-label="Quick add"
        className="top-[22%] translate-y-0 gap-0 border-border/60 bg-card p-0 shadow-2xl sm:max-w-[540px]"
        showCloseButton={false}
      >
        <div className="px-4 pt-4 pb-3">
          {addedFeedback !== null ? (
            <p className="animate-in truncate text-base text-muted-foreground fade-in-0">
              <span className="mr-1.5 text-primary">✓</span>
              {addedFeedback}
            </p>
          ) : (
            <input
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              className={cn(
                "w-full bg-transparent text-base text-foreground outline-none",
                "placeholder:text-muted-foreground/40",
                shake && "animate-shake"
              )}
              onChange={(event) => setInputValue(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="What's on your mind?"
              ref={inputRef}
              value={inputValue}
            />
          )}
        </div>

        {/* Metadata chips + Add button */}
        <div className="flex items-center gap-2 border-t border-border/40 px-4 py-2.5 text-sm text-muted-foreground/60">
          <FolderChip
            folders={folders}
            onChange={(id) => {
              setFolderValue(id);
              setFolderManual(true);
            }}
            value={folderValue}
          />

          <BylineSeparator />

          <DateTimePicker
            endValue={endDateValue}
            onChange={(d) => {
              setDateValue(d);
              setDateManual(true);
            }}
            onEndChange={(d) => {
              setEndDateValue(d);
              setDateManual(true);
            }}
            value={dateValue}
          />

          <BylineSeparator />

          <PriorityDropdown
            onSelect={(p) => {
              setPriorityValue(p);
              setPriorityManual(true);
            }}
            priority={priorityValue}
            variant="byline"
          />

          <BylineSeparator />

          <TagsPopover
            allTags={allTagNames}
            onToggle={(name) => {
              if (tagsValue.includes(name)) {
                setNlpTags((prev) => prev.filter((t) => t !== name));
                setManualTags((prev) => prev.filter((t) => t !== name));
              } else {
                setManualTags((prev) => [...prev, name]);
              }
            }}
            selected={tagsValue}
          />

          {recurrenceLabel && (
            <>
              <BylineSeparator />
              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <Repeat2 className="h-3 w-3" />
                {recurrenceLabel}
              </span>
            </>
          )}

          <button
            className="ml-auto shrink-0 rounded bg-primary px-3 py-1 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => void handleSubmit()}
          >
            Add
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
