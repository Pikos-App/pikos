import { storageErrorUserMessage, toStorageError } from "@pikos/core";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Download, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { TypedConfirmDialog } from "@/components/ui/typed-confirm-dialog";
import { ImportSection } from "@/features/import";
import type { ImportState, LastImportResult } from "@/features/import";
import { formatTimeAgo } from "@/features/import/parsers/utils";
import { deleteAllData } from "@/lib/data/deleteAllData";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { createLogger } from "@/shared/logger";

import { UsageStats } from "./UsageStats";
import type { UsageStatsData } from "./UsageStats";

const log = createLogger("DataSettings");

// ─── Shared layout ────────────────────────────────────────────────────────

function SettingsSection({
  children,
  description,
  title,
}: {
  children: React.ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-1 text-base font-semibold">{title}</h2>
      {description && <p className="mb-4 text-sm text-muted-foreground">{description}</p>}
      {children}
    </section>
  );
}

// ─── Export helpers ────────────────────────────────────────────────────────

type ExportState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "done"; path: string }
  | { status: "error"; message: string };

function ExportRow({
  description,
  disabled,
  label,
  onExport,
  state,
}: {
  description: string;
  disabled: boolean;
  label: string;
  onExport: () => void;
  state: ExportState;
}) {
  const saving = state.status === "saving";
  const done = state.status === "done";

  return (
    <div className="flex items-center justify-between gap-6 border-b border-border py-3 last:border-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {done ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">Saved to Downloads</p>
        ) : state.status === "error" ? (
          <p className="mt-0.5 text-xs text-destructive">{state.message}</p>
        ) : (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {done && (
          <button
            className="rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => void revealItemInDir(state.path)}
          >
            Show in Finder
          </button>
        )}
        <button
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
          disabled={disabled || saving}
          onClick={onExport}
        >
          <Download className="h-3.5 w-3.5" />
          Export
        </button>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────

interface DataSettingsProps {
  importState: ImportState;
  lastImportResult: LastImportResult | null;
  onClearImport: () => void;
  onUndoImport: () => Promise<void>;
  parseMarkdownDir: (dirPath: string) => Promise<void>;
  parseCSVFile: (content: string) => void;
  resetImport: () => void;
  usageStats: UsageStatsData | null;
}

export function DataSettings({
  importState,
  lastImportResult,
  onClearImport,
  onUndoImport,
  parseCSVFile,
  parseMarkdownDir,
  resetImport,
  usageStats,
}: DataSettingsProps) {
  const { workspace } = useWorkspace();
  const { showNotice } = useUndoDelete();
  const [sqliteExport, setSqliteExport] = useState<ExportState>({ status: "idle" });
  const [csvExport, setCsvExport] = useState<ExportState>({ status: "idle" });
  const [markdownExport, setMarkdownExport] = useState<ExportState>({ status: "idle" });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDeleteAll() {
    if (deleting) return;
    setDeleting(true);
    setDeleteOpen(false);
    showNotice("Deleting all data…", 5000);
    // Brief pause so the toast renders before relaunch tears down the WebView.
    await new Promise((r) => setTimeout(r, 800));
    try {
      await deleteAllData();
      // On success, deleteAllData calls relaunch — no further UI needed.
    } catch (e) {
      log.error("deleteAllData failed", e);
      showNotice("Couldn't delete data. Check disk permissions and try again.", 6000);
      setDeleting(false);
    }
  }

  async function handleExportSqlite() {
    setSqliteExport({ status: "saving" });
    try {
      const dest = await invoke<string>("backup_db");
      setSqliteExport({ path: dest, status: "done" });
    } catch (e: unknown) {
      setSqliteExport({
        message: storageErrorUserMessage(toStorageError(e), "exporting your SQLite backup"),
        status: "error",
      });
    }
  }

  async function handleExportCsv() {
    setCsvExport({ status: "saving" });
    try {
      const dest = await invoke<string>("export_csv");
      setCsvExport({ path: dest, status: "done" });
    } catch (e: unknown) {
      setCsvExport({
        message: storageErrorUserMessage(toStorageError(e), "exporting your CSV"),
        status: "error",
      });
    }
  }

  async function handleExportMarkdown() {
    setMarkdownExport({ status: "saving" });
    try {
      const dest = await invoke<string>("export_markdown");
      setMarkdownExport({ path: dest, status: "done" });
    } catch (e: unknown) {
      setMarkdownExport({
        message: storageErrorUserMessage(toStorageError(e), "exporting your Markdown"),
        status: "error",
      });
    }
  }

  return (
    <div className="max-w-lg">
      {/* ── Usage stats ────────────────────────────────────────────────── */}
      <SettingsSection
        description="Your data is stored locally and never leaves your device."
        title="Your Workspace"
      >
        <UsageStats stats={usageStats} />
      </SettingsSection>

      {/* ── Import ──────────────────────────────────────────────────── */}
      <SettingsSection description="Bring your data from other apps into Pikos." title="Import">
        {lastImportResult && (
          <div className="mb-4 flex items-center justify-between rounded-lg border border-green-500/20 bg-green-500/5 px-4 py-3">
            <div>
              <p className="text-sm text-green-700 dark:text-green-400">
                Imported {lastImportResult.pageCount} page
                {lastImportResult.pageCount !== 1 ? "s" : ""}
                {lastImportResult.folderCount > 0 &&
                  ` into ${lastImportResult.folderCount} folder${lastImportResult.folderCount !== 1 ? "s" : ""}`}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                via {lastImportResult.source === "markdown" ? "Markdown" : "CSV"} ·{" "}
                {formatTimeAgo(lastImportResult.importedAt)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => void onUndoImport()}
              >
                Undo import
              </button>
              <button
                className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                onClick={onClearImport}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        <ImportSection
          parseCSVFile={parseCSVFile}
          parseMarkdownDir={parseMarkdownDir}
          reset={resetImport}
          state={importState}
        />
      </SettingsSection>

      {/* ── Export ─────────────────────────────────────────────────────── */}
      <SettingsSection description="Download your data in different formats." title="Export">
        <div className="rounded-lg border border-border bg-card px-4">
          <ExportRow
            description="Full database backup. Best for restoring data."
            disabled={!workspace}
            label="Export as SQLite"
            onExport={() => void handleExportSqlite()}
            state={sqliteExport}
          />
          <ExportRow
            description="Spreadsheet of all pages with metadata. Re-importable."
            disabled={!workspace}
            label="Export as CSV"
            onExport={() => void handleExportCsv()}
            state={csvExport}
          />
          <ExportRow
            description="Markdown files with YAML frontmatter. Obsidian-compatible."
            disabled={!workspace}
            label="Export as Markdown"
            onExport={() => void handleExportMarkdown()}
            state={markdownExport}
          />
        </div>
      </SettingsSection>

      {/* ── Danger Zone ────────────────────────────────────────────────── */}
      {/* Lives here (not General) for data-lifecycle coherence and safety-
          adjacency to Export — back up before you wipe. Inline because it owns
          local dialog + in-flight state. */}
      <section className="mt-12 border-t border-destructive/30 pt-6">
        <h2 className="mb-4 text-base font-semibold text-destructive">Danger Zone</h2>
        <div className="rounded-lg border border-destructive/30 bg-card p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Delete All Data</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Permanently deletes all pages, folders, tags, and settings on this device. This
                cannot be undone.
              </p>
            </div>
            <Button
              disabled={deleting}
              onClick={() => setDeleteOpen(true)}
              size="sm"
              variant="destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          </div>
        </div>
      </section>

      <TypedConfirmDialog
        busy={deleting}
        cancelLabel="Cancel"
        confirmLabel="Delete Everything"
        confirmPhrase="delete"
        description="This will permanently delete all pages, folders, tags, and settings on this device. Your data is stored locally and cannot be recovered after deletion."
        onConfirm={() => void handleDeleteAll()}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title="Delete all Pikos data?"
        variant="destructive"
      />
    </div>
  );
}
