// NLP parsing previews on-type (debounced 200ms) — chips update as you type
// but input text is never modified. On submit, the parser extracts the clean
// title and all metadata from the full input.
//
// Split into a thin shell + body so the body unmounts on close. Reopening
// remounts the body, which resets all its state via useState initializers —
// no reset effect, no eslint-disable, no flicker.

import { getLocalTimezone, localToday, parseInput, snapAnchorToRule } from "@pikos/core";
import type { PagePriority, PageUpdate, ParseResult } from "@pikos/core";
import { useEffect, useRef, useState } from "react";
import type React from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { DateTimePicker } from "@/shared/components/DateTimePicker";
import { FolderChip } from "@/shared/components/FolderChip";
import { PriorityDropdown } from "@/shared/components/PriorityDropdown";
import { RecurrencePopover } from "@/shared/components/RecurrencePopover";
import { TagsPopover } from "@/shared/components/TagsPopover";
import { NLP_PRIORITY_MAP } from "@/shared/constants/priorities";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

import { useQuickAddPlaceholder } from "../hooks/useQuickAddPlaceholder";
import { fuzzyMatchFolder } from "../utils/fuzzyMatchFolder";

function BylineSeparator() {
  return (
    <span aria-hidden="true" className="shrink-0 text-muted-foreground/20">
      ·
    </span>
  );
}

// ── QuickAddDialog (shell) ────────────────────────────────────────────────────

export function QuickAddDialog() {
  const { openDialog, setOpenDialog } = useUI();
  const isOpen = openDialog === "quick-add";

  // Mod+N from anywhere opens the dialog. Idempotent when already open —
  // focus is kept on the input by each chip's onClose handler, so no inner
  // refocus shortcut is needed.
  useKeyboardShortcut("Mod+N", () => setOpenDialog("quick-add"), { allowInInputs: true });

  function handleOpenChange(next: boolean) {
    setOpenDialog(next ? "quick-add" : null);
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={isOpen}>
      <DialogContent
        aria-label="Quick add"
        className="top-[22%] translate-y-0 gap-0 border-border/60 bg-card p-0 shadow-2xl sm:max-w-[540px]"
        showCloseButton={false}
      >
        {/* Radix requires a title + description for screen readers; sr-only
            keeps the input-first surface visually clean. */}
        <DialogTitle className="sr-only">Quick add</DialogTitle>
        <DialogDescription className="sr-only">
          Type a title with optional date, time, tags, folder, and recurrence shortcuts. Enter
          commits, Cmd+Enter commits and stays open for the next page, Shift+Enter commits and opens
          the new page.
        </DialogDescription>
        {isOpen && <QuickAddDialogBody onClose={() => setOpenDialog(null)} />}
      </DialogContent>
    </Dialog>
  );
}

// ── QuickAddDialogBody (mounted only while open) ──────────────────────────────

interface QuickAddDialogBodyProps {
  onClose: () => void;
}

function QuickAddDialogBody({ onClose }: QuickAddDialogBodyProps) {
  const { createPage, createRecurrence, folders, scheduleOnce, tags, updatePage } = usePages();
  const allTagNames = tags.map((t) => t.name);
  const { activeViewId, dialogPrefill, openPage } = useUI();
  const { defaultFolderId: settingsDefaultFolder } = useAppSettings();

  // Active sidebar folder takes precedence, then settings default, then Inbox (null).
  const initialFolderId =
    folders.find((folder) => folder.id === activeViewId)?.id ?? settingsDefaultFolder;
  const dateActiveToday = activeViewId === "today";

  const [inputValue, setInputValue] = useState(() => dialogPrefill ?? "");
  const [shake, setShake] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [addedFeedback, setAddedFeedback] = useState<string | null>(null);

  // ── Chip state ───────────────────────────────────────────────────────────────
  // Each field has an NLP-set value and a "manually set" flag. runPreview only
  // updates fields the user hasn't touched directly — manual selections survive typing.
  // Tags are split further: nlpTags vs manualTags (union displayed).

  const [dateValue, setDateValue] = useState<string | null>(() =>
    dateActiveToday ? localToday() : null
  );
  const [endDateValue, setEndDateValue] = useState<string | null>(null);
  const [priorityValue, setPriorityValue] = useState<PagePriority>(0);
  const [folderValue, setFolderValue] = useState<string | null>(initialFolderId);
  const [nlpTags, setNlpTags] = useState<string[]>([]);
  const [manualTags, setManualTags] = useState<string[]>([]);
  const tagsValue = [...new Set([...nlpTags, ...manualTags])];

  const [dateManual, setDateManual] = useState(dateActiveToday);
  const [priorityManual, setPriorityManual] = useState(false);
  const [folderManual, setFolderManual] = useState(false);
  const [rruleValue, setRruleValue] = useState<string | null>(null);
  const [rruleManual, setRruleManual] = useState(false);
  const [finiteLabel, setFiniteLabel] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const placeholder = useQuickAddPlaceholder(true);

  function refocusInput() {
    inputRef.current?.focus();
  }

  // Refocus the input on mount and after the batch-add feedback clears.
  useEffect(() => {
    if (addedFeedback !== null) return;
    inputRef.current?.focus();
  }, [addedFeedback]);

  // Cmd+T — schedule the new page for today (all-day). Acts as a sticky default;
  // an NLP-parsed date in the input still wins at submit (see resolvedDate below).
  useKeyboardShortcut(
    "Mod+T",
    () => {
      setDateValue(localToday());
      setEndDateValue(null);
      setDateManual(true);
      inputRef.current?.focus();
    },
    { allowInInputs: true, preventDefault: true }
  );

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
        if (!folderManual) setFolderValue(initialFolderId);
        setNlpTags([]);
        if (!rruleManual) setRruleValue(null);
        setFiniteLabel(null);
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

      // Show recurrence / finite preview.
      // Recurrence chip tracks rruleValue; finite stays as a separate label
      // since finite produces N independent pages, not a recurring rule.
      if (result.type === "recurring") {
        if (!rruleManual) setRruleValue(result.rrule);
        setFiniteLabel(null);
      } else if (result.type === "finite") {
        if (!rruleManual) setRruleValue(null);
        setFiniteLabel(`${result.count} occurrence${result.count === 1 ? "" : "s"}`);
      } else {
        if (!rruleManual) setRruleValue(null);
        setFiniteLabel(null);
      }

      if (!dateManual) {
        // Recurring results without an explicit date anchor to today so the
        // chip matches what submit will do (resolvedDate ?? localToday()).
        const effectiveStart =
          parsed.scheduledStart ?? (result.type === "recurring" ? localToday() : null);
        setDateValue(effectiveStart);
        setEndDateValue(parsed.scheduledEnd ?? null);
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
          setFolderValue(initialFolderId);
        }
      }

      setNlpTags(parsed.tags.length > 0 ? [...new Set(parsed.tags)] : []);
    }, 200);

    return () => clearTimeout(timer);
  }, [
    inputValue,
    folders,
    initialFolderId,
    folderValue,
    dateManual,
    priorityManual,
    folderManual,
    rruleManual,
  ]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) {
        void handleSubmitBatch();
      } else if (event.shiftKey) {
        void handleSubmitAndOpen();
      } else {
        void handleSubmit();
      }
    }
  }

  // ── Submit ────────────────────────────────────────────────────────────────────

  /** Shared submission logic. Returns the created page's id + title, or null on validation fail.
   *  For finite-recurrence input, `id` is the first created page. */
  async function submitPage(): Promise<{ id: string; title: string } | null> {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setShake(true);
      setValidationError("Enter a title before adding.");
      setTimeout(() => setShake(false), 300);
      inputRef.current?.focus();
      return null;
    }
    setValidationError(null);

    const result = parseInput(trimmed);
    return executeCreate(result);
  }

  /** Actually creates the page(s) from a parse result (after any confirmation). */
  async function executeCreate(result: ParseResult): Promise<{ id: string; title: string } | null> {
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
    // When the parser strips everything (input was only tokens, e.g. "tomorrow"
    // or "#work !high"), title is empty and the page shows as "Untitled" —
    // we deliberately do NOT fall back to inputValue, which would persist the
    // raw tokens as a misleading title.
    const title = parsed?.title ?? "";

    // Fresh NLP tags from re-parse + manual additions.
    const finalTags = [...new Set([...(parsed?.tags ?? []), ...manualTags])];

    const patch: PageUpdate = {};
    if (resolvedPriority !== 0) patch.priority = resolvedPriority;
    if (finalTags.length > 0) patch.tags = finalTags;

    // Chip-set rrule takes precedence. Falls back to NLP-derived rrule when
    // the user hasn't touched the chip.
    if (rruleValue) {
      // Infinite recurrence: 1 template page + recurrence rule.
      const page = await createPage({ folderId: resolvedFolderId, title });
      if (Object.keys(patch).length > 0) updatePage(page.id, patch);

      const tz = getLocalTimezone();
      // Snap onto the first date the rule permits — a chip-set M/W/F rule on a
      // Sunday date must start Monday, not render a stray Sunday head. (NLP-set
      // rrules already arrive snapped from the parser; snapping is idempotent.)
      const ruleStart = snapAnchorToRule(rruleValue, resolvedDate ?? localToday());
      await createRecurrence({
        pageId: page.id,
        rrule: rruleValue,
        scheduledStart: ruleStart,
        ...(parsed?.scheduledEnd ? { scheduledEnd: parsed.scheduledEnd } : {}),
        timezone: tz,
      });
      // Set head's scheduledStart denorm so it appears in Today/calendar
      updatePage(page.id, {
        scheduledStart: ruleStart,
        ...(parsed?.scheduledEnd ? { scheduledEnd: parsed.scheduledEnd } : {}),
      });
      return { id: page.id, title };
    }

    if (result.type === "finite") {
      // Finite recurrence: N independent pages, each with its own schedule.
      let firstId: string | null = null;
      for (const inp of result.inputs) {
        const pg = await createPage({ folderId: resolvedFolderId, title: inp.title || title });
        if (firstId === null) firstId = pg.id;
        const finPatch: PageUpdate = {};
        if (resolvedPriority !== 0) finPatch.priority = resolvedPriority;
        const finTags = [...new Set([...inp.tags, ...manualTags])];
        if (finTags.length > 0) finPatch.tags = finTags;
        if (Object.keys(finPatch).length > 0) updatePage(pg.id, finPatch);
        if (inp.scheduledStart) {
          await scheduleOnce(pg.id, inp.scheduledStart, inp.scheduledEnd);
        }
      }
      return firstId ? { id: firstId, title } : null;
    }

    // Single page
    const page = await createPage({ folderId: resolvedFolderId, title });
    if (Object.keys(patch).length > 0) updatePage(page.id, patch);

    if (resolvedDate) {
      const resolvedEnd = parsed?.scheduledEnd ?? endDateValue ?? undefined;
      await scheduleOnce(page.id, resolvedDate, resolvedEnd);
    }

    return { id: page.id, title };
  }

  /** Enter — commit and close. */
  async function handleSubmit() {
    const result = await submitPage();
    if (result !== null) onClose();
  }

  /** Shift+Enter — commit, open the new page in the editor, close the dialog. */
  async function handleSubmitAndOpen() {
    const result = await submitPage();
    if (result === null) return;
    openPage(result.id);
    onClose();
  }

  /**
   * Cmd+Enter — commit, show brief confirmation, then reset fields so the user
   * can immediately add another page in the same folder scope.
   */
  async function handleSubmitBatch() {
    const result = await submitPage();
    if (result === null) return;

    setAddedFeedback(result.title);
    setInputValue("");
    setDateValue(null);
    setEndDateValue(null);
    setPriorityValue(0);
    setNlpTags([]);
    setManualTags([]);
    setRruleValue(null);
    setRruleManual(false);
    setFiniteLabel(null);
    setDateManual(false);
    setPriorityManual(false);
    // Keep folderValue and folderManual — user stays in same folder scope.
    setTimeout(() => {
      setAddedFeedback(null);
    }, 1000);
  }

  return (
    <>
      <div className="px-4 pt-4 pb-3">
        {addedFeedback !== null ? (
          <p className="animate-in truncate text-base text-muted-foreground fade-in-0">
            <span className="mr-1.5 text-primary">✓</span>
            {addedFeedback}
          </p>
        ) : (
          <input
            aria-describedby="quick-add-error"
            aria-invalid={validationError !== null}
            aria-label="Quick add input"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className={cn(
              "w-full bg-transparent text-base text-foreground outline-none",
              "placeholder:text-muted-foreground/40",
              shake && "animate-shake"
            )}
            onChange={(event) => {
              setInputValue(event.target.value);
              if (validationError !== null) setValidationError(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            ref={inputRef}
            value={inputValue}
          />
        )}
        {/* Validation announcement — screen-reader-only; sighted users see
            the shake animation. aria-live="assertive" so it interrupts and
            reads immediately when submission fails. */}
        <div aria-atomic="true" aria-live="assertive" className="sr-only" id="quick-add-error">
          {validationError ?? ""}
        </div>
      </div>

      {/* Metadata chips + Add button */}
      <div className="flex items-center gap-2 border-t border-border/40 px-4 py-2.5 text-sm text-subtle">
        <FolderChip
          folders={folders}
          onChange={(id) => {
            setFolderValue(id);
            setFolderManual(true);
            // Synchronous refocus on selection — onCloseAutoFocus fires later
            // (async, after Radix processes the close), so the keyboard-only
            // flow "pick folder → press Enter to submit" needs this to land
            // focus on the main input before the next keypress arrives.
            refocusInput();
          }}
          onClose={refocusInput}
          value={folderValue}
        />

        <BylineSeparator />

        <DateTimePicker
          endValue={endDateValue}
          onChange={(d) => {
            setDateValue(d);
            setDateManual(true);
          }}
          onClose={refocusInput}
          onEndChange={(d) => {
            setEndDateValue(d);
            setDateManual(true);
          }}
          value={dateValue}
        />

        <RecurrencePopover
          anchorDate={dateValue}
          onChange={(rrule) => {
            setRruleValue(rrule);
            setRruleManual(true);
            // If the user picks a rule without a date set, anchor to today
            // so the chip's implicit "Starts today" becomes concrete on the
            // date chip too.
            if (rrule && !dateValue) {
              setDateValue(localToday());
              setDateManual(true);
            }
            // See FolderChip — sync refocus on selection.
            refocusInput();
          }}
          onClose={refocusInput}
          rrule={rruleValue}
          variant="compact"
          {...(finiteLabel ? { overrideLabel: finiteLabel } : {})}
        />

        <BylineSeparator />

        <PriorityDropdown
          onClose={refocusInput}
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
          onClose={refocusInput}
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

        <button
          className="ml-auto shrink-0 rounded bg-primary px-3 py-1 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => void handleSubmit()}
        >
          Add
        </button>
      </div>
    </>
  );
}
