// NLP parsing previews on-type (debounced 200ms) — chips update as you type
// but input text is never modified. On submit, the parser extracts the clean
// title and all metadata from the full input.
//
// Split into a thin shell + body so the body unmounts on close. Reopening
// remounts the body, which resets all its state via useState initializers —
// no reset effect, no eslint-disable, no flicker.

import type { PagePriority, PageUpdate, ParsedInput, ParseResult } from "@pikos/core";
import {
  DAY_BEFORE_MINUTES,
  fuzzyMatchFolder,
  getLocalTimezone,
  localToday,
  NLP_PRIORITY_MAP,
  parseInput,
  snapScheduleToRule,
} from "@pikos/core";
import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type React from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { PageMetadataChips } from "@/shared/components/PageMetadataChips";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

import { useQuickAddPlaceholder } from "../hooks/useQuickAddPlaceholder";

/**
 * Plain body text → the Tiptap document a page stores, one paragraph per line —
 * the same shape `pikos_db::build_tiptap_doc` writes, so a page the dialog gave
 * a body to is indistinguishable from one the CLI or the reconciler wrote, and
 * projects back through `extractText` to exactly the text that went in.
 */
function bodyToTiptap(text: string): string {
  const content = text
    .split("\n")
    .map((line) =>
      line ? { content: [{ text: line, type: "text" }], type: "paragraph" } : { type: "paragraph" }
    );
  return JSON.stringify({ content, type: "doc" });
}

/** How a parsed reminder lead reads on the preview chip. */
function reminderChipLabel(minutes: number): string {
  if (minutes === DAY_BEFORE_MINUTES) return "Day before";
  if (minutes === 0) return "At time";
  if (minutes < 60) return `${minutes} min before`;
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? "" : "s"} before`;
  }
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? "" : "s"} before`;
}

// ── QuickAddDialog (shell) ────────────────────────────────────────────────────

export function QuickAddDialog() {
  const { openDialog, setOpenDialog } = useUI();
  const isOpen = openDialog === "quick-add";

  // Mod+N from anywhere opens the dialog. Idempotent when already open —
  // focus is kept on the input by each chip's onClose handler, so no inner
  // refocus shortcut is needed.
  useKeyboardShortcut("Mod+N", () => setOpenDialog("quick-add"), {
    allowInInputs: true,
    group: "Navigation",
    label: "New page",
  });

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
  // Reminder rows are raw CRUD — PagesContext doesn't carry them, so the new
  // page's leads go straight to the adapter, the same call the reminder
  // dropdown makes once the page is open.
  const { storage } = useWorkspace();

  // External-calendar folders are placement-locked — a new native page can't land
  // in one, so they're never a quick-add target (chip, NLP, or active-view default).
  const creatableFolders = folders.filter((f) => !f.isExternalCalendar);

  // Active sidebar folder takes precedence, then settings default, then Inbox (null).
  const initialFolderId =
    creatableFolders.find((folder) => folder.id === activeViewId)?.id ?? settingsDefaultFolder;
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
  // Preview only — reminders have no chip to set them from here (the picker
  // needs a page id), so the parse is the single source and submit re-reads it.
  const [reminderPreview, setReminderPreview] = useState<number[]>([]);

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
    { allowInInputs: true, group: "Quick add", label: "Schedule for today", preventDefault: true }
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
        setReminderPreview([]);
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
          const match = fuzzyMatchFolder(parsed.folderQuery, creatableFolders);
          setFolderValue(
            match ? match.id : parsed.folderQuery.toLowerCase() === "inbox" ? null : folderValue
          );
        } else {
          setFolderValue(initialFolderId);
        }
      }

      setNlpTags(parsed.tags.length > 0 ? [...new Set(parsed.tags)] : []);
      setReminderPreview(parsed.reminderMinutes ?? []);
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
      const match = fuzzyMatchFolder(parsed.folderQuery, creatableFolders);
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
    // Body from the "//" separator, written as the page's document so opening
    // the page shows the note already typed out.
    if (parsed?.content) {
      patch.content = bodyToTiptap(parsed.content);
      patch.contentText = parsed.content;
    }

    /** The parsed reminder leads, written as rows on a page that now exists. */
    async function writeReminders(pageId: string, inp: ParsedInput | undefined) {
      if (!storage) return;
      for (const minutesBefore of inp?.reminderMinutes ?? []) {
        await storage.createPageReminder({ minutesBefore, pageId });
      }
    }

    // Chip-set rrule takes precedence. Falls back to NLP-derived rrule when
    // the user hasn't touched the chip.
    if (rruleValue) {
      // Infinite recurrence: 1 template page + recurrence rule.
      const page = await createPage({ folderId: resolvedFolderId, title });
      if (Object.keys(patch).length > 0) updatePage(page.id, patch);

      const tz = getLocalTimezone();
      // Snap onto the first date the rule permits — a chip-set M/W/F rule on a
      // Sunday date must start Monday, not render a stray Sunday head. An NLP
      // rrule can land here off-pattern too, when the input names a date *and* a
      // cadence ("on wednesday every monday"); the end travels with the start so
      // it can't end up before it.
      const { end: ruleEnd, start: ruleStart } = snapScheduleToRule(
        rruleValue,
        resolvedDate ?? localToday(),
        parsed?.scheduledEnd
      );
      await createRecurrence({
        pageId: page.id,
        rrule: rruleValue,
        scheduledStart: ruleStart,
        ...(ruleEnd ? { scheduledEnd: ruleEnd } : {}),
        timezone: tz,
      });
      // Set head's scheduledStart denorm so it appears in Today/calendar
      updatePage(page.id, {
        scheduledStart: ruleStart,
        ...(ruleEnd ? { scheduledEnd: ruleEnd } : {}),
      });
      await writeReminders(page.id, parsed);
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
        if (inp.content) {
          finPatch.content = bodyToTiptap(inp.content);
          finPatch.contentText = inp.content;
        }
        if (Object.keys(finPatch).length > 0) updatePage(pg.id, finPatch);
        if (inp.scheduledStart) {
          await scheduleOnce(pg.id, inp.scheduledStart, inp.scheduledEnd);
        }
        await writeReminders(pg.id, inp);
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
    await writeReminders(page.id, parsed);

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
    setReminderPreview([]);
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
        <PageMetadataChips
          groups={[
            {
              chips: [
                {
                  kind: "folder",
                  props: {
                    folders,
                    onChange: (id) => {
                      setFolderValue(id);
                      setFolderManual(true);
                      // Synchronous refocus on selection — onCloseAutoFocus fires later
                      // (async, after Radix processes the close), so the keyboard-only
                      // flow "pick folder → press Enter to submit" needs this to land
                      // focus on the main input before the next keypress arrives.
                      refocusInput();
                    },
                    onClose: refocusInput,
                    value: folderValue,
                  },
                },
              ],
              key: "folder",
            },
            {
              chips: [
                {
                  kind: "date",
                  props: {
                    endValue: endDateValue,
                    onChange: (d) => {
                      setDateValue(d);
                      setDateManual(true);
                    },
                    onClose: refocusInput,
                    onEndChange: (d) => {
                      setEndDateValue(d);
                      setDateManual(true);
                    },
                    value: dateValue,
                  },
                },
                {
                  kind: "recurrence",
                  props: {
                    anchorDate: dateValue,
                    onChange: (rrule) => {
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
                    },
                    onClose: refocusInput,
                    rrule: rruleValue,
                    variant: "compact",
                    ...(finiteLabel ? { overrideLabel: finiteLabel } : {}),
                  },
                },
                // Read-only echo of the parsed lead: the reminder picker needs a
                // page to attach to, so before there is one the input is the only
                // way to set this, and the chip is only here to show it landed.
                reminderPreview.length > 0 && {
                  id: "reminder-preview",
                  kind: "node" as const,
                  node: (
                    <span
                      className="inline-flex shrink-0 items-center gap-1.5"
                      title="Reminder from the text you typed"
                    >
                      <Bell className="h-3.5 w-3.5 shrink-0" />
                      {reminderPreview.map(reminderChipLabel).join(", ")}
                    </span>
                  ),
                },
              ],
              key: "schedule",
            },
            {
              chips: [
                {
                  kind: "priority",
                  props: {
                    onClose: refocusInput,
                    onSelect: (p) => {
                      setPriorityValue(p);
                      setPriorityManual(true);
                    },
                    priority: priorityValue,
                    variant: "byline",
                  },
                },
              ],
              key: "priority",
            },
            {
              chips: [
                {
                  kind: "tags",
                  props: {
                    allTags: allTagNames,
                    onClose: refocusInput,
                    onToggle: (name) => {
                      if (tagsValue.includes(name)) {
                        setNlpTags((prev) => prev.filter((t) => t !== name));
                        setManualTags((prev) => prev.filter((t) => t !== name));
                      } else {
                        setManualTags((prev) => [...prev, name]);
                      }
                    },
                    selected: tagsValue,
                  },
                },
              ],
              key: "tags",
            },
          ]}
          layout="byline"
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
