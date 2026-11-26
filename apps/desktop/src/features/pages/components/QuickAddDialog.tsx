// NLP parsing previews on type (debounced 200ms) and never modifies the input; on submit the parser
// extracts the title and metadata from the full input.
//
// A thin shell plus a body that unmounts on close, so reopening resets all state via useState
// initializers with no reset effect.

import type { PagePriority, ParsedInput, ParseResult } from "@pikos/core";
import {
  datesNewPageToday,
  DAY_BEFORE_MINUTES,
  folderIdForNewPage,
  fuzzyMatchFolder,
  getLocalTimezone,
  localToday,
  NLP_PRIORITY_MAP,
  parseInput,
  PRIORITY_COLORS,
  quickAddHighlightTokens,
  snapScheduleToRule,
  storageErrorUserMessage,
  toStorageError,
  writableFolders,
} from "@pikos/core";
import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type React from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { PageMetadataChips } from "@/shared/components/PageMetadataChips";
import { MOD_KEY_SPOKEN } from "@/shared/constants/platform";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import type { NewPageFields } from "@/shared/context/usePageWrites";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";
import { createLogger } from "@/shared/logger";

import { useQuickAddPlaceholder } from "../hooks/useQuickAddPlaceholder";
import { QuickAddInput } from "./QuickAddInput";

const log = createLogger("QuickAddDialog");

/**
 * Plain body text to the Tiptap document a page stores, one paragraph per line: the same shape
 * `pikos_db::build_tiptap_doc` writes, so the page is indistinguishable from one the CLI wrote.
 */
function bodyToTiptap(text: string): string {
  const content = text
    .split("\n")
    .map((line) =>
      line ? { content: [{ text: line, type: "text" }], type: "paragraph" } : { type: "paragraph" }
    );
  return JSON.stringify({ content, type: "doc" });
}

function firstParsed(result: ParseResult): ParsedInput | undefined {
  return result.type === "finite" ? result.inputs[0] : result.input;
}

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

export function QuickAddDialog() {
  const { openDialog, setOpenDialog } = useUI();
  const isOpen = openDialog === "quick-add";

  // Mod+N opens the dialog from anywhere; idempotent when already open.
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
          commits, {MOD_KEY_SPOKEN}+Enter commits and stays open for the next page, Shift+Enter
          commits and opens the new page.
        </DialogDescription>
        {isOpen && <QuickAddDialogBody onClose={() => setOpenDialog(null)} />}
      </DialogContent>
    </Dialog>
  );
}

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

  const creatableFolders = writableFolders(folders);
  const initialFolderId = folderIdForNewPage(activeViewId, folders, settingsDefaultFolder);
  const dateActiveToday = datesNewPageToday(activeViewId);

  const [inputValue, setInputValue] = useState(() => dialogPrefill ?? "");
  const [shake, setShake] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  // A refused write needs words on screen. The empty-title case explains itself
  // through the shake and the input the user is still looking at; a storage
  // failure leaves nothing to look at, so it renders rather than only announcing.
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [addedFeedback, setAddedFeedback] = useState<string | null>(null);

  // Each field has an NLP-set value and a "manually set" flag; runPreview updates only fields the user
  // hasn't touched. Tags split into nlpTags and manualTags (union displayed).

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

  // Parsed every keystroke rather than on the chips' debounce, so a colour never trails its word.
  const liveParse = inputValue.trim() ? firstParsed(parseInput(inputValue)) : undefined;
  const highlightTokens = liveParse ? quickAddHighlightTokens(inputValue, liveParse.title) : [];
  const highlightPriorityClass =
    PRIORITY_COLORS[liveParse?.priority ? (NLP_PRIORITY_MAP[liveParse.priority] ?? 0) : 0];

  function refocusInput() {
    inputRef.current?.focus();
  }

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
      const parsed = firstParsed(result);
      if (!parsed) return;

      // Finite recurrence stays a separate label: it produces N independent pages, not a rule.
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
    setSubmitError(null);

    const result = parseInput(trimmed);
    try {
      return await executeCreate(result);
    } catch (e) {
      log.error("quick add failed", e);
      setSubmitError(storageErrorUserMessage(toStorageError(e), "adding the page"));
      inputRef.current?.focus();
      return null;
    }
  }

  async function executeCreate(result: ParseResult): Promise<{ id: string; title: string } | null> {
    const parsed = firstParsed(result);

    let resolvedFolderId = folderValue;
    if (parsed?.folderQuery) {
      const match = fuzzyMatchFolder(parsed.folderQuery, creatableFolders);
      if (match) {
        resolvedFolderId = match.id;
      } else if (parsed.folderQuery.toLowerCase() === "inbox") {
        resolvedFolderId = null;
      }
    }

    const resolvedDate = parsed?.scheduledStart ?? dateValue;
    const resolvedPriority =
      parsed?.priority !== undefined
        ? parsed.priority === null
          ? 0
          : (NLP_PRIORITY_MAP[parsed.priority] ?? 0)
        : priorityValue;

    // parsed.title already has tokens stripped. If the input was only tokens ("tomorrow"), the title is
    // empty and shows as "Untitled": falling back to inputValue would persist the raw tokens.
    const title = parsed?.title ?? "";

    const finalTags = [...new Set([...(parsed?.tags ?? []), ...manualTags])];

    const patch: NewPageFields = {};
    if (resolvedPriority !== 0) patch.priority = resolvedPriority;
    if (finalTags.length > 0) patch.tags = finalTags;
    if (parsed?.content) {
      patch.content = bodyToTiptap(parsed.content);
    }

    async function writeReminders(pageId: string, inp: ParsedInput | undefined) {
      if (!storage) return;
      for (const minutesBefore of inp?.reminderMinutes ?? []) {
        await storage.createPageReminder({ minutesBefore, pageId });
      }
    }

    // Chip-set rrule takes precedence. Otherwise take the rule from *this*
    // submit's parse rather than the chip's debounced preview: an Enter inside
    // the 200ms window would otherwise read a preview that never ran and commit
    // a plain page. Every other field below already reads the fresh parse.
    const resolvedRrule = rruleManual
      ? rruleValue
      : result.type === "recurring"
        ? result.rrule
        : null;

    if (resolvedRrule) {
      const page = await createPage({ folderId: resolvedFolderId, title, ...patch });

      const tz = getLocalTimezone();
      // Snap onto the first date the rule permits: a chip-set M/W/F rule on a Sunday must start Monday. An
      // NLP rrule can land off-pattern too ("on wednesday every monday"); the end travels with the start.
      const { end: ruleEnd, start: ruleStart } = snapScheduleToRule(
        resolvedRrule,
        resolvedDate ?? localToday(),
        parsed?.scheduledEnd
      );
      await createRecurrence({
        pageId: page.id,
        rrule: resolvedRrule,
        scheduledStart: ruleStart,
        ...(ruleEnd ? { scheduledEnd: ruleEnd } : {}),
        timezone: tz,
      });
      updatePage(page.id, {
        scheduledStart: ruleStart,
        ...(ruleEnd ? { scheduledEnd: ruleEnd } : {}),
      });
      await writeReminders(page.id, parsed);
      return { id: page.id, title };
    }

    if (result.type === "finite") {
      let firstId: string | null = null;
      for (const inp of result.inputs) {
        const finPatch: NewPageFields = {};
        if (resolvedPriority !== 0) finPatch.priority = resolvedPriority;
        const finTags = [...new Set([...inp.tags, ...manualTags])];
        if (finTags.length > 0) finPatch.tags = finTags;
        if (inp.content) {
          finPatch.content = bodyToTiptap(inp.content);
        }
        const pg = await createPage({
          folderId: resolvedFolderId,
          title: inp.title || title,
          ...finPatch,
        });
        if (firstId === null) firstId = pg.id;
        if (inp.scheduledStart) {
          await scheduleOnce(pg.id, inp.scheduledStart, inp.scheduledEnd);
        }
        await writeReminders(pg.id, inp);
      }
      return firstId ? { id: firstId, title } : null;
    }

    const page = await createPage({ folderId: resolvedFolderId, title, ...patch });

    if (resolvedDate) {
      const resolvedEnd = parsed?.scheduledEnd ?? endDateValue ?? undefined;
      await scheduleOnce(page.id, resolvedDate, resolvedEnd);
    }
    await writeReminders(page.id, parsed);

    return { id: page.id, title };
  }

  async function handleSubmit() {
    const result = await submitPage();
    if (result !== null) onClose();
  }

  async function handleSubmitAndOpen() {
    const result = await submitPage();
    if (result === null) return;
    openPage(result.id, { focusBody: true });
    onClose();
  }

  /** Cmd+Enter: commit, show brief confirmation, then reset fields to add another in the same folder scope. */
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
    setTimeout(() => {
      setAddedFeedback(null);
    }, 1000);
  }

  return (
    <>
      <div className="px-4 pt-4 pb-3">
        {addedFeedback !== null ? (
          <p className="animate-in truncate text-base text-muted-foreground fade-in-0">
            <span className="mr-1.5 text-action">✓</span>
            {addedFeedback}
          </p>
        ) : (
          <QuickAddInput
            aria-describedby="quick-add-error"
            aria-invalid={validationError !== null || submitError !== null}
            aria-label="Quick add input"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className={cn("placeholder:text-subtle", shake && "animate-shake")}
            onChange={(event) => {
              setInputValue(event.target.value);
              if (validationError !== null) setValidationError(null);
              if (submitError !== null) setSubmitError(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            priorityClass={highlightPriorityClass}
            ref={inputRef}
            tokens={highlightTokens}
            value={inputValue}
          />
        )}
        {submitError !== null && (
          <p className="mt-1.5 text-xs text-destructive" role="alert">
            {submitError}
          </p>
        )}
        {/* Screen-reader-only; sighted users see the shake. aria-live="assertive" interrupts. A refused write
            announces through its own visible `role="alert"` instead, so it stays one copy. */}
        <div aria-atomic="true" aria-live="assertive" className="sr-only" id="quick-add-error">
          {validationError ?? ""}
        </div>
      </div>

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
                      // Synchronous refocus: onCloseAutoFocus fires later, and "pick folder, press Enter" needs focus on the
                      // input before the next keypress.
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
                      if (rrule && !dateValue) {
                        setDateValue(localToday());
                        setDateManual(true);
                      }
                      refocusInput();
                    },
                    onClose: refocusInput,
                    rrule: rruleValue,
                    variant: "compact",
                    ...(finiteLabel ? { overrideLabel: finiteLabel } : {}),
                  },
                },
                // Read-only echo: the reminder picker needs a page, so before there is one the input is the only way
                // to set this, and the chip shows it landed.
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
          className="ml-auto shrink-0 rounded bg-interactive-fill px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-interactive-fill/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => void handleSubmit()}
        >
          Add
        </button>
      </div>
    </>
  );
}
