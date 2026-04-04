// ImportSection — Settings UI section for importing data from external sources.
// Renders in GeneralSettings between Export and Feedback sections.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { FileSpreadsheet, FolderOpen, Loader2 } from "lucide-react";

import type { ImportState } from "../hooks/useImport";

interface ImportSectionProps {
  state: ImportState;
  parseMarkdownDir: (dirPath: string) => Promise<void>;
  parseCSVFile: (content: string) => void;
  reset: () => void;
}

export function ImportSection({
  parseCSVFile,
  parseMarkdownDir,
  reset,
  state,
}: ImportSectionProps) {
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
      title: "Select CSV export file",
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
            <p className="text-sm font-medium">Markdown</p>
            <p className="text-xs text-muted-foreground">
              Import .md files with YAML frontmatter. Folder structure is preserved.
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
            <p className="text-sm font-medium">CSV</p>
            <p className="text-xs text-muted-foreground">
              Import tasks from a CSV export. Format is auto-detected from headers.
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
      <ImportStatusBar onReset={reset} state={state} />
    </>
  );
}

// ─── Status bar ───────────────────────────────────────────────────────────────

function ImportStatusBar({ onReset, state }: { state: ImportState; onReset: () => void }) {
  if (state.step === "parsing") {
    return (
      <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Reading files...
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
