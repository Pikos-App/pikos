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
    <span className="text-muted-foreground/20" aria-hidden="true">
      ·
    </span>
  );
}

// ── QuickAddDialog ────────────────────────────────────────────────────────────

export function QuickAddDialog() {
  const { folders, createPage, updatePage, scheduleOnce } = useWorkspace();
  const { activeViewId, setActivePage } = useUI();

  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [inputValue, setInputValue] = useState("");
  const [shake, setShake] = useState(false);

  const defaultFolderId = folders.find((folder) => folder.id === activeViewId)?.id ?? null;

  // ── Chip state (last-write-wins: NLP or manual override) ─────────────────────

  const [dateValue, setDateValue] = useState<string | null>(null);
  const [endDateValue, setEndDateValue] = useState<string | null>(null);
  const [priorityValue, setPriorityValue] = useState<PagePriority>(0);
  const [folderValue, setFolderValue] = useState<string | null>(null);

  // ── Open handler ─────────────────────────────────────────────────────────────

  function openDialog() {
    setInputValue("");
    setDateValue(null);
    setEndDateValue(null);
    setPriorityValue(0);
    setFolderValue(defaultFolderId);
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

  // ── Preview (parse-only, never modifies input) ──────────────────────────────
  // Runs on debounce. Parses the full input and updates chip previews.
  // Last-write-wins: this overwrites chip state including any manual overrides,
  // because the input text is the source of truth for token values.

  function runPreview(raw: string) {
    const result = parseInput(raw);
    const parsed =
      result.type === "single"
        ? result.input
        : result.type === "finite"
          ? result.inputs[0]
          : result.input;
    if (!parsed) return;

    // Always set all chip values from the parse result so removing a token resets the chip.
    setDateValue(parsed.scheduledStart ?? null);
    const hasTime = parsed.scheduledStart?.includes("T") ?? false;
    setEndDateValue(hasTime ? (parsed.scheduledEnd ?? null) : null);
    setPriorityValue(
      parsed.priority === undefined ? 0 : parsed.priority === null ? 0 : NLP_PRIORITY_MAP[parsed.priority]
    );

    if (parsed.folderQuery) {
      const match = fuzzyMatchFolder(parsed.folderQuery, folders);
      setFolderValue(match ? match.id : parsed.folderQuery.toLowerCase() === "inbox" ? null : folderValue);
    } else {
      setFolderValue(defaultFolderId);
    }
  }

  // ── Debounce preview ─────────────────────────────────────────────────────────
  // Fires 200ms after the user stops typing. Parses the full input and updates
  // chip previews — never modifies the input text.

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!inputValue.trim()) {
        setDateValue(null);
        setEndDateValue(null);
        setPriorityValue(0);
        setFolderValue(defaultFolderId);
        return;
      }
      runPreview(inputValue);
    }, 200);

    return () => clearTimeout(timer);
  }, [inputValue, folders, defaultFolderId]);

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

    const patch: PageUpdate = {};
    if (resolvedPriority !== 0) patch.priority = resolvedPriority;
    if (parsed?.tags && parsed.tags.length > 0) patch.tags = parsed.tags;
    if (Object.keys(patch).length > 0) updatePage(page.id, patch);

    if (resolvedDate) {
      // End time: parsed scheduledEnd takes precedence over chip state.
      const hasTime = resolvedDate.includes("T");
      const resolvedEnd = hasTime ? (parsed?.scheduledEnd ?? endDateValue ?? undefined) : undefined;
      await scheduleOnce(page.id, resolvedDate, resolvedEnd);
    }

    setOpen(false);
    setActivePage(page.id);
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-label="Quick add"
        className="top-[22%] max-w-[600px] translate-y-0 gap-0 border-border/60 bg-card p-0 shadow-2xl"
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
          <FolderChip folders={folders} value={folderValue} onChange={setFolderValue} />

          <BylineSeparator />

          <DateTimePicker
            value={dateValue}
            onChange={setDateValue}
            endValue={endDateValue}
            onEndChange={setEndDateValue}
          />

          <BylineSeparator />

          <PriorityDropdown priority={priorityValue} onSelect={setPriorityValue} variant="byline" />

          <button
            onClick={() => void handleSubmit()}
            className="ml-auto cursor-pointer rounded bg-primary px-3 py-1 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Add
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
