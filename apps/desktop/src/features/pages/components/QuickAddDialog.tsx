// QuickAddDialog — GOO-60
// Cmd+N (macOS) / Ctrl+N opens a centered dialog for quick page creation.
// NLP parsing fires on Space/Enter (strip-and-chip): recognized tokens are
// removed from the input and reflected in the metadata chips below.

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
  const [priorityValue, setPriorityValue] = useState<PagePriority>(0);
  const [folderValue, setFolderValue] = useState<string | null>(null);

  // ── Open handler ─────────────────────────────────────────────────────────────

  function openDialog() {
    setInputValue("");
    setDateValue(null);
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

  // ── Parse-and-strip ───────────────────────────────────────────────────────────
  // Runs after Space is pressed (or the debounce fires). Extracts recognized NLP
  // tokens from the input, updates the corresponding chips, and replaces the input
  // with the clean title.
  // Last-write-wins: this overwrites chip state including any manual overrides,
  // because the input text is the source of truth for token values.

  function runParseAndStrip(raw: string) {
    const result = parseInput(raw);
    const parsed =
      result.type === "single"
        ? result.input
        : result.type === "finite"
          ? result.inputs[0]
          : result.input;
    if (!parsed) return;

    // Only update chips for fields the parser actually found.
    if (parsed.scheduledStart !== undefined) {
      setDateValue(parsed.scheduledStart);
    }
    if (parsed.priority !== undefined) {
      setPriorityValue(NLP_PRIORITY_MAP[parsed.priority]);
    }
    if (parsed.folderQuery) {
      const match = fuzzyMatchFolder(parsed.folderQuery, folders);
      if (match) setFolderValue(match.id);
    }

    // Replace input with clean title, keeping a trailing space for continued typing.
    const cleanTitle = parsed.title.replace(/\s{2,}/g, " ").trimStart();
    const next = cleanTitle ? cleanTitle + " " : "";
    setInputValue(next);

    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input) {
        const len = input.value.length;
        input.setSelectionRange(len, len);
      }
    });
  }

  // ── Debounce parse ────────────────────────────────────────────────────────────
  // "A Space press you forgot to do." Fires 800ms after the user stops typing —
  // long enough to avoid mid-keystroke noise — then calls runParseAndStrip(),
  // identical to the Space handler. Stripping also happens on Space and Enter.

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!inputValue.trim()) {
        setDateValue(null);
        setPriorityValue(0);
        setFolderValue(defaultFolderId);
        return;
      }
      runParseAndStrip(inputValue);
    }, 800);

    return () => clearTimeout(timer);
  }, [inputValue, folders, defaultFolderId]);

  // ── Key handler ───────────────────────────────────────────────────────────────

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void handleSubmit();
      return;
    }

    if (event.key === " ") {
      // Let the space character enter the input first, then parse.
      requestAnimationFrame(() => {
        runParseAndStrip(inputRef.current?.value ?? inputValue);
      });
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

    // Final parse pass — catches tokens typed without a trailing space.
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
      if (match) resolvedFolderId = match.id;
    }

    // Merge: fresh parse results override chip state; chip state is the fallback.
    const resolvedDate = parsed?.scheduledStart ?? dateValue;
    const resolvedPriority =
      parsed?.priority !== undefined ? NLP_PRIORITY_MAP[parsed.priority] : priorityValue;

    const title = parsed?.title || trimmed;

    const page = await createPage({ title, folderId: resolvedFolderId });

    const patch: PageUpdate = {};
    if (resolvedPriority !== 0) patch.priority = resolvedPriority;
    if (parsed?.tags && parsed.tags.length > 0) patch.tags = parsed.tags;
    if (parsed?.durationMinutes) patch.durationMinutes = parsed.durationMinutes;
    if (Object.keys(patch).length > 0) updatePage(page.id, patch);

    if (resolvedDate) {
      await scheduleOnce(page.id, resolvedDate);
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

          <DateTimePicker value={dateValue} onChange={setDateValue} />

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
