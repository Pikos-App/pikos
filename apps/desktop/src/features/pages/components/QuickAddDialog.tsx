// QuickAddDialog — GOO-60
// Cmd+N (macOS) / Ctrl+N opens a centered dialog for quick page creation.
// NLP parsing previews on-type (debounced 200ms) — chips update as you type
// but input text is never modified. On submit, the parser extracts the clean
// title and all metadata from the full input.

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useUI } from "@/shared/context/UIContext";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";
import { DateTimePicker } from "@/shared/components/DateTimePicker";
import { PriorityDropdown } from "@/features/pages/components/PriorityDropdown";
import { FolderChip } from "@/features/pages/components/FolderChip";
import { TagsPopover } from "@/features/pages/components/TagsPopover";
import { parseInput } from "@pikos/core";
import { cn } from "@/lib/utils";
import type { Folder, PagePriority, PageUpdate } from "@pikos/core";

// ── NLP priority mapping ──────────────────────────────────────────────────────

type NLPPriority = "urgent" | "high" | "medium" | "low";

const NLP_PRIORITY_MAP: Record<NLPPriority, PagePriority> = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};

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
    <span className="shrink-0 text-muted-foreground/20" aria-hidden="true">
      ·
    </span>
  );
}

// ── QuickAddDialog ────────────────────────────────────────────────────────────

export function QuickAddDialog() {
  const { folders, tags, createPage, updatePage, scheduleOnce } = useWorkspace();
  const allTagNames = tags.map((t) => t.name);
  const { activeViewId } = useUI();

  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [inputValue, setInputValue] = useState("");
  const [shake, setShake] = useState(false);

  const defaultFolderId = folders.find((folder) => folder.id === activeViewId)?.id ?? null;

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

  // ── Open handler ─────────────────────────────────────────────────────────────

  function openDialog() {
    setInputValue("");
    setDateValue(null);
    setEndDateValue(null);
    setPriorityValue(0);
    setFolderValue(defaultFolderId);
    setNlpTags([]);
    setManualTags([]);
    setDateManual(false);
    setPriorityManual(false);
    setFolderManual(false);
    setOpen(true);
  }

  // ── Keyboard shortcut: Mod+N from anywhere ───────────────────────────────────

  useKeyboardShortcut(
    "Mod+N",
    () => {
      if (open) {
        inputRef.current?.focus();
      } else {
        openDialog();
      }
    },
    { allowInInputs: true }
  );

  function handleOpenChange(next: boolean) {
    if (next) {
      openDialog();
    } else {
      setOpen(false);
    }
  }

  // ── Focus input when dialog opens ─────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [open]);

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

      if (!dateManual) {
        setDateValue(parsed.scheduledStart ?? null);
        const hasTime = parsed.scheduledStart?.includes("T") ?? false;
        setEndDateValue(hasTime ? (parsed.scheduledEnd ?? null) : null);
      }

      if (!priorityManual) {
        setPriorityValue(
          parsed.priority === undefined || parsed.priority === null
            ? 0
            : NLP_PRIORITY_MAP[parsed.priority]
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
      void handleSubmit();
    }
  }

  // ── Submit ────────────────────────────────────────────────────────────────────

  async function handleSubmit() {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setShake(true);
      setTimeout(() => setShake(false), 300);
      inputRef.current?.focus();
      return;
    }

    // Parse the full, unstripped input on submit.
    const result = parseInput(trimmed);
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
          : NLP_PRIORITY_MAP[parsed.priority]
        : priorityValue;

    // Use parsed.title (tokens already stripped by parser) as the page title.
    const title = parsed?.title || trimmed;

    const page = await createPage({ title, folderId: resolvedFolderId });

    // Fresh NLP tags from re-parse + manual additions.
    // manualTags is never overwritten by NLP, so this correctly handles removals.
    const finalTags = [...new Set([...(parsed?.tags ?? []), ...manualTags])];

    const patch: PageUpdate = {};
    if (resolvedPriority !== 0) patch.priority = resolvedPriority;
    if (finalTags.length > 0) patch.tags = finalTags;
    if (Object.keys(patch).length > 0) updatePage(page.id, patch);

    if (resolvedDate) {
      // End time: parsed scheduledEnd takes precedence over chip state.
      const hasTime = resolvedDate.includes("T");
      const resolvedEnd = hasTime ? (parsed?.scheduledEnd ?? endDateValue ?? undefined) : undefined;
      await scheduleOnce(page.id, resolvedDate, resolvedEnd);
    }

    setOpen(false);
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-label="Quick add"
        className="top-[22%] translate-y-0 gap-0 border-border/60 bg-card p-0 shadow-2xl sm:max-w-[540px]"
      >
        <div className="px-4 pt-4 pb-3">
          <input
            ref={inputRef}
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What's on your mind?"
            autoComplete="off"
            className={cn(
              "w-full bg-transparent text-base text-foreground outline-none",
              "placeholder:text-muted-foreground/40",
              shake && "animate-shake"
            )}
          />
        </div>

        {/* Metadata chips + Add button */}
        <div className="flex items-center gap-2 border-t border-border/40 px-4 py-2.5 text-sm text-muted-foreground/60">
          <FolderChip
            folders={folders}
            value={folderValue}
            onChange={(id) => {
              setFolderValue(id);
              setFolderManual(true);
            }}
          />

          <BylineSeparator />

          <DateTimePicker
            value={dateValue}
            onChange={(d) => {
              setDateValue(d);
              setDateManual(true);
            }}
            endValue={endDateValue}
            onEndChange={(d) => {
              setEndDateValue(d);
              setDateManual(true);
            }}
          />

          <BylineSeparator />

          <PriorityDropdown
            priority={priorityValue}
            onSelect={(p) => {
              setPriorityValue(p);
              setPriorityManual(true);
            }}
            variant="byline"
          />

          <BylineSeparator />

          <TagsPopover
            allTags={allTagNames}
            selected={tagsValue}
            onToggle={(name) => {
              if (tagsValue.includes(name)) {
                setNlpTags((prev) => prev.filter((t) => t !== name));
                setManualTags((prev) => prev.filter((t) => t !== name));
              } else {
                setManualTags((prev) => [...prev, name]);
              }
            }}
          />

          <button
            onClick={() => void handleSubmit()}
            className="ml-auto shrink-0 cursor-pointer rounded bg-primary px-3 py-1 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Add
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
