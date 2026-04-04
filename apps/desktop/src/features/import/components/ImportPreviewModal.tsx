// ImportPreviewModal — shows a summary of what will be imported before committing.
// Full-screen overlay matching the Settings pattern.

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  Inbox,
  Tag,
  X,
} from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import type { ImportPlan } from "../parsers/types";

// ─── Priority badge ───────────────────────────────────────────────────────────

const PRIORITY_LABELS: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

const PRIORITY_COLORS: Record<number, string> = {
  1: "text-red-500",
  2: "text-orange-500",
  3: "text-yellow-500",
  4: "text-blue-500",
};

// ─── Component ────────────────────────────────────────────────────────────────

interface ImportPreviewModalProps {
  plan: ImportPlan;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ImportPreviewModal({ onCancel, onConfirm, plan }: ImportPreviewModalProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const sourceLabel =
    plan.source === "markdown"
      ? "Markdown / Obsidian"
      : plan.source === "csv_ticktick"
        ? "TickTick"
        : "Todoist";

  // Group pages by folder
  const grouped = new Map<string | null, typeof plan.pages>();
  for (const page of plan.pages) {
    const key = page.folderKey;
    const list = grouped.get(key);
    if (list) list.push(page);
    else grouped.set(key, [page]);
  }

  const completedCount = plan.pages.filter((p) => p.status === "done").length;
  const scheduledCount = plan.pages.filter((p) => p.scheduledDate).length;
  const tagCount = new Set(plan.pages.flatMap((p) => p.tags)).size;

  function toggleFolder(key: string) {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-background shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">Import Preview</h2>
            <p className="text-sm text-muted-foreground">
              {sourceLabel} — {plan.pages.length} pages in {plan.folders.length} folder
              {plan.folders.length !== 1 ? "s" : ""}
              {grouped.has(null) ? " + Inbox" : ""}
            </p>
          </div>
          <button
            aria-label="Cancel import"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={onCancel}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Summary stats */}
        <div className="flex gap-4 border-b border-border px-6 py-3">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileText className="h-3.5 w-3.5" /> {plan.pages.length} pages
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <FolderOpen className="h-3.5 w-3.5" /> {plan.folders.length} folders
          </span>
          {tagCount > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Tag className="h-3.5 w-3.5" /> {tagCount} tags
            </span>
          )}
          {completedCount > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5" /> {completedCount} completed
            </span>
          )}
          {scheduledCount > 0 && (
            <span className="text-xs text-muted-foreground">{scheduledCount} scheduled</span>
          )}
        </div>

        {/* Warnings */}
        {plan.warnings.length > 0 && (
          <div className="border-b border-border px-6 py-3">
            <div className="rounded-md border border-yellow-500/20 bg-yellow-500/5 px-3 py-2">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-yellow-600 dark:text-yellow-400">
                <AlertTriangle className="h-3.5 w-3.5" />
                {plan.warnings.length} warning{plan.warnings.length !== 1 ? "s" : ""}
              </p>
              <ul className="max-h-24 space-y-0.5 overflow-y-auto">
                {plan.warnings.map((w, i) => (
                  <li className="text-xs text-muted-foreground" key={i}>
                    {w.source && <span className="font-mono text-[10px]">{w.source}: </span>}
                    {w.message}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Page tree */}
        <div className="flex-1 overflow-y-auto px-6 py-3">
          {/* Inbox pages */}
          {grouped.has(null) && (
            <FolderGroup
              expanded={expandedFolders.has("__inbox__")}
              folderName="Inbox"
              icon={<Inbox className="h-3.5 w-3.5" />}
              onToggle={() => toggleFolder("__inbox__")}
              pages={grouped.get(null)!}
            />
          )}
          {/* Folder pages */}
          {plan.folders.map((folder) => {
            const folderPages = grouped.get(folder.key) ?? [];
            return (
              <FolderGroup
                expanded={expandedFolders.has(folder.key)}
                folderName={folder.name}
                icon={<FolderOpen className="h-3.5 w-3.5" />}
                key={folder.key}
                onToggle={() => toggleFolder(folder.key)}
                pages={folderPages}
              />
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4">
          <button
            className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            onClick={onConfirm}
          >
            Import {plan.pages.length} page{plan.pages.length !== 1 ? "s" : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── FolderGroup ──────────────────────────────────────────────────────────────

function FolderGroup({
  expanded,
  folderName,
  icon,
  onToggle,
  pages,
}: {
  folderName: string;
  icon: React.ReactNode;
  pages: ImportPreviewModalProps["plan"]["pages"];
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
            <div className="flex items-center gap-2 py-1 text-sm" key={i}>
              {page.status === "done" ? (
                <CheckCircle2 className="h-3 w-3 shrink-0 text-green-500" />
              ) : (
                <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <span
                className={cn(
                  "truncate",
                  page.status === "done" && "text-muted-foreground line-through"
                )}
              >
                {page.title}
              </span>
              {page.priority > 0 && (
                <span className={cn("text-[10px] font-medium", PRIORITY_COLORS[page.priority])}>
                  {PRIORITY_LABELS[page.priority]}
                </span>
              )}
              {page.tags.length > 0 && (
                <span className="truncate text-[10px] text-muted-foreground">
                  {page.tags.join(", ")}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
