// ImportSection — Settings UI section for importing data from external sources.
// Renders in GeneralSettings between Export and Feedback sections.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { FileSpreadsheet, FolderOpen, Loader2, Undo2 } from "lucide-react";

import { type ImportState, useImport } from "../hooks/useImport";
import { ImportPreviewModal } from "./ImportPreviewModal";

export function ImportSection() {
  const { executeImport, parseCSVFile, parseMarkdownDir, reset, state, undoImport } = useImport();

  async function handleMarkdownImport() {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Select Markdown / Obsidian Vault folder",
    });
    if (!selected) return;
    await parseMarkdownDir(selected);
  }

  async function handleCSVImport() {
    const selected = await openDialog({
      filters: [{ extensions: ["csv"], name: "CSV" }],
      multiple: false,
      title: "Select TickTick or Todoist CSV export",
    });
    if (!selected) return;
    const content = await readTextFile(selected);
    parseCSVFile(content);
  }

  return (
    <>
      <div className="rounded-lg border border-border bg-card px-4">
        {/* Markdown / Obsidian */}
        <div className="flex items-center justify-between border-b border-border py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Markdown / Obsidian Vault</p>
            <p className="text-xs text-muted-foreground">
              Import .md files with YAML frontmatter. Folders are preserved.
            </p>
          </div>
          <button
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
            disabled={state.step !== "idle" && state.step !== "done" && state.step !== "error"}
            onClick={() => void handleMarkdownImport()}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Select Folder
          </button>
        </div>

        {/* CSV */}
        <div className="flex items-center justify-between py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">CSV (TickTick, Todoist)</p>
            <p className="text-xs text-muted-foreground">
              Auto-detects the source from column headers.
            </p>
          </div>
          <button
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
            disabled={state.step !== "idle" && state.step !== "done" && state.step !== "error"}
            onClick={() => void handleCSVImport()}
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            Select File
          </button>
        </div>
      </div>

      {/* Status feedback */}
      <ImportStatusBar onReset={reset} onUndo={undoImport} state={state} />

      {/* Preview modal */}
      {state.step === "preview" && (
        <ImportPreviewModal
          onCancel={reset}
          onConfirm={() => void executeImport(state.plan)}
          plan={state.plan}
        />
      )}
    </>
  );
}

// ─── Status bar ───────────────────────────────────────────────────────────────

function ImportStatusBar({
  onReset,
  onUndo,
  state,
}: {
  state: ImportState;
  onReset: () => void;
  onUndo: (pageIds: string[], folderIds: string[]) => Promise<void>;
}) {
  if (state.step === "idle") return null;

  if (state.step === "parsing") {
    return (
      <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Reading files...
      </div>
    );
  }

  if (state.step === "importing") {
    const pct = state.total > 0 ? Math.round((state.progress / state.total) * 100) : 0;
    return (
      <div className="mt-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Importing page {state.progress + 1} of {state.total}...
        </div>
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-accent">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  }

  if (state.step === "done") {
    return (
      <div className="mt-2 flex items-center justify-between rounded-md border border-green-500/20 bg-green-500/5 px-3 py-2">
        <p className="text-sm text-green-700 dark:text-green-400">
          Imported {state.pageCount} page{state.pageCount !== 1 ? "s" : ""}
          {state.folderCount > 0 &&
            ` into ${state.folderCount} new folder${state.folderCount !== 1 ? "s" : ""}`}
        </p>
        <div className="flex items-center gap-2">
          <button
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => void onUndo(state.pageIds, state.folderIds)}
          >
            <Undo2 className="h-3 w-3" />
            Undo Import
          </button>
          <button
            className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={onReset}
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (state.step === "error") {
    return (
      <div className="mt-2 flex items-center justify-between rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2">
        <p className="text-sm text-red-700 dark:text-red-400">{state.message}</p>
        <button
          className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onReset}
        >
          Dismiss
        </button>
      </div>
    );
  }

  return null;
}
