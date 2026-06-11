// Sits inside the settings content area (sidebar remains visible), not a modal.

import { emojiAwareCompare, isDone, isOpen } from "@pikos/core";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  EyeOff,
  FileText,
  FolderOpen,
  Inbox,
  Tag,
} from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";
import { PRIORITY_COLORS, PRIORITY_LABELS } from "@/shared/constants/priorities";

import type { ImportPage, ImportPlan } from "../parsers/types";
import { cleanTitle, formatSchedule } from "../parsers/utils";

function sortPagesCompletedLast(pages: ImportPage[]): ImportPage[] {
  return [...pages].sort((a, b) => {
    if (isDone(a) && isOpen(b)) return 1;
    if (isOpen(a) && isDone(b)) return -1;
    return emojiAwareCompare(a.title, b.title);
  });
}

interface ImportPreviewModalProps {
  plan: ImportPlan;
  onConfirm: (skipCompleted: boolean) => void;
  onCancel: () => void;
}

export function ImportPreviewModal({ onCancel, onConfirm, plan }: ImportPreviewModalProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [skipCompleted, setSkipCompleted] = useState(false);

  const sourceLabel =
    plan.source === "markdown"
      ? "Markdown / Obsidian"
      : plan.source === "csv_ticktick"
        ? "TickTick CSV"
        : plan.source === "csv_todoist"
          ? "Todoist CSV"
          : "CSV Import";

  const completedCount = plan.pages.filter(isDone).length;
  const activeCount = plan.pages.length - completedCount;
  const scheduledCount = plan.pages.filter((p) => p.scheduledStart).length;
  const tagCount = new Set(plan.pages.flatMap((p) => p.tags)).size;
  const totalSkipped = plan.meta.skipped.reduce((sum, s) => sum + s.count, 0);

  const visiblePages = skipCompleted ? plan.pages.filter(isOpen) : plan.pages;
  const importCount = visiblePages.length;

  const grouped = new Map<string | null, ImportPage[]>();
  for (const page of visiblePages) {
    const key = page.folderKey;
    const list = grouped.get(key);
    if (list) list.push(page);
    else grouped.set(key, [page]);
  }

  // Filter out empty folders when skipping completed, sort alphabetically
  const visibleFolders = plan.folders
    .filter((f) => grouped.has(f.key))
    .sort((a, b) => emojiAwareCompare(a.name, b.name));

  function toggleFolder(key: string) {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-8 py-4">
        <button
          aria-label="Cancel import"
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onCancel}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Import Preview</h2>
          <p className="text-sm text-muted-foreground">
            {sourceLabel} — {plan.pages.length} pages in {plan.folders.length} folder
            {plan.folders.length !== 1 ? "s" : ""}
            {grouped.has(null) ? " + Inbox" : ""}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between border-b border-border px-8 py-3">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <FolderOpen className="h-3.5 w-3.5" /> {plan.folders.length} folders
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileText className="h-3.5 w-3.5" /> {plan.pages.length} pages
          </span>
          {completedCount > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5" /> {completedCount} completed
            </span>
          )}
          {scheduledCount > 0 && (
            <span className="text-xs text-muted-foreground">{scheduledCount} scheduled</span>
          )}
          {tagCount > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Tag className="h-3.5 w-3.5" /> {tagCount} tags
            </span>
          )}
          {totalSkipped > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <EyeOff className="h-3.5 w-3.5" /> {totalSkipped} skipped
            </span>
          )}
        </div>

        {completedCount > 0 && (
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-muted-foreground select-none">
            <input
              checked={skipCompleted}
              className="h-3.5 w-3.5 cursor-pointer rounded border-border accent-primary"
              onChange={(e) => setSkipCompleted(e.target.checked)}
              type="checkbox"
            />
            Skip {completedCount} completed
            {activeCount > 0 && <span className="text-xs">({activeCount} remaining)</span>}
          </label>
        )}
      </div>

      {(plan.warnings.length > 0 || totalSkipped > 0 || plan.meta.transformations.length > 0) && (
        <div className="shrink-0 border-b border-border px-8 py-3">
          <div className="rounded-md border border-yellow-500/20 bg-yellow-500/5 px-3 py-2">
            <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-yellow-600 dark:text-yellow-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              Import notes
            </p>
            <ul className="max-h-40 space-y-0.5 overflow-y-auto">
              {plan.meta.skipped.map((s, i) => (
                <li className="text-xs text-muted-foreground" key={`skip-${i}`}>
                  {s.count} {s.reason} skipped
                </li>
              ))}
              {plan.meta.transformations.map((t, i) => (
                <li className="text-xs text-muted-foreground" key={`transform-${i}`}>
                  {t}
                </li>
              ))}
              {plan.warnings.map((w, i) => (
                <li className="text-xs text-muted-foreground" key={`warn-${i}`}>
                  {w.source && <span className="font-mono text-[10px]">{w.source}: </span>}
                  {w.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-8 py-4">
        {grouped.has(null) && (
          <FolderGroup
            expanded={expandedFolders.has("__inbox__")}
            folderName="Inbox"
            icon={<Inbox className="h-3.5 w-3.5" />}
            onToggle={() => toggleFolder("__inbox__")}
            pages={sortPagesCompletedLast(grouped.get(null)!)}
          />
        )}
        {visibleFolders.map((folder) => {
          const folderPages = grouped.get(folder.key) ?? [];
          return (
            <FolderGroup
              expanded={expandedFolders.has(folder.key)}
              folderName={folder.name}
              icon={<FolderOpen className="h-3.5 w-3.5" />}
              key={folder.key}
              onToggle={() => toggleFolder(folder.key)}
              pages={sortPagesCompletedLast(folderPages)}
            />
          );
        })}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border px-8 py-4">
        <button
          className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          disabled={importCount === 0}
          onClick={() => onConfirm(skipCompleted)}
        >
          Import {importCount} page{importCount !== 1 ? "s" : ""}
        </button>
      </div>
    </div>
  );
}

function FolderGroup({
  expanded,
  folderName,
  icon,
  onToggle,
  pages,
}: {
  folderName: string;
  icon: React.ReactNode;
  pages: ImportPage[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="mb-1">
      <button
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
        onClick={onToggle}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        )}
        {icon}
        <span className="min-w-0 truncate font-medium">{folderName}</span>
        <span className="text-xs text-muted-foreground">({pages.length})</span>
      </button>
      {expanded && (
        <div className="ml-7 border-l border-border pl-3">
          {pages.map((page, i) => (
            <div
              className="flex min-w-0 items-center gap-2 py-1 text-sm"
              key={`${page.title}-${i}`}
            >
              {isDone(page) ? (
                <CheckCircle2 className="h-3 w-3 shrink-0 text-green-500" />
              ) : (
                <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <span
                className={cn(
                  "min-w-0 truncate",
                  isDone(page) && "text-muted-foreground line-through"
                )}
              >
                {cleanTitle(page.title)}
              </span>
              {page.priority > 0 && (
                <span
                  className={cn("shrink-0 text-[10px] font-medium", PRIORITY_COLORS[page.priority])}
                >
                  {PRIORITY_LABELS[page.priority]}
                </span>
              )}
              {page.scheduledStart && isOpen(page) && (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {formatSchedule(page.scheduledStart)}
                </span>
              )}
              {page.tags.length > 0 && (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {page.tags.map((t) => `#${t}`).join(", ")}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
