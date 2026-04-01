// GeneralSettings — about, data export, feedback, and workspace stats.

import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Download, ExternalLink } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";
import { SearchablePopover, SearchablePopoverItem } from "@/shared/components/SearchablePopover";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import type { WeekStart } from "@/shared/context/AppSettingsContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

import { UsageStats } from "./UsageStats";

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
    <div className="flex items-center justify-between gap-4 border-b border-border py-3 last:border-0">
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

export function GeneralSettings() {
  const { folders, workspace } = useWorkspace();
  const { defaultFolderId, setDefaultFolderId, setWeekStart, weekStart } = useAppSettings();
  const [sqliteExport, setSqliteExport] = useState<ExportState>({ status: "idle" });
  const [jsonExport, setJsonExport] = useState<ExportState>({ status: "idle" });
  const [markdownExport, setMarkdownExport] = useState<ExportState>({ status: "idle" });

  async function handleExportSqlite() {
    setSqliteExport({ status: "saving" });
    try {
      const dest = await invoke<string>("backup_db");
      setSqliteExport({ path: dest, status: "done" });
    } catch (e: unknown) {
      setSqliteExport({ message: String(e), status: "error" });
    }
  }

  async function handleExportJson() {
    setJsonExport({ status: "saving" });
    try {
      const dest = await invoke<string>("export_json");
      setJsonExport({ path: dest, status: "done" });
    } catch (e: unknown) {
      setJsonExport({ message: String(e), status: "error" });
    }
  }

  async function handleExportMarkdown() {
    setMarkdownExport({ status: "saving" });
    try {
      const dest = await invoke<string>("export_markdown");
      setMarkdownExport({ path: dest, status: "done" });
    } catch (e: unknown) {
      setMarkdownExport({ message: String(e), status: "error" });
    }
  }

  return (
    <div className="max-w-lg">
      {/* ── About ──────────────────────────────────────────────────────── */}
      <SettingsSection title="About">
        <div className="rounded-lg border border-border bg-card px-4">
          <div className="flex items-center justify-between border-b border-border py-3">
            <div>
              <p className="text-sm font-medium">Pikos</p>
              <p className="text-xs text-muted-foreground">
                Version {__APP_VERSION__}
                {import.meta.env.DEV && " — dev"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4 py-3">
            <button
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => void openUrl("https://pikos.app")}
            >
              Website <ExternalLink className="h-3 w-3" />
            </button>
            <button
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => void openUrl("https://pikos.app/release-notes")}
            >
              Release Notes <ExternalLink className="h-3 w-3" />
            </button>
          </div>
        </div>
      </SettingsSection>

      {/* ── Preferences ─────────────────────────────────────────────────── */}
      <SettingsSection title="Preferences">
        <div className="rounded-lg border border-border bg-card px-4">
          {/* Week starts on */}
          <div className="flex items-center justify-between border-b border-border py-3">
            <div>
              <p className="text-sm font-medium">Week starts on</p>
              <p className="text-xs text-muted-foreground">
                Controls the calendar and date picker layout.
              </p>
            </div>
            <div className="flex shrink-0 gap-1 rounded-md border border-border bg-background p-0.5">
              {[
                { id: 1 as WeekStart, label: "Monday" },
                { id: 0 as WeekStart, label: "Sunday" },
              ].map((opt) => (
                <button
                  className={cn(
                    "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                    weekStart === opt.id
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  key={opt.id}
                  onClick={() => setWeekStart(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Default folder */}
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm font-medium">Default folder for new pages</p>
              <p className="text-xs text-muted-foreground">
                Used when no folder is selected in the sidebar.
              </p>
            </div>
            <SearchablePopover
              align="end"
              placeholder="Search folders…"
              trigger={
                <button className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent">
                  {folders.find((f) => f.id === defaultFolderId)?.name ?? "Inbox"}
                </button>
              }
            >
              {({ close }) => (
                <>
                  <SearchablePopoverItem
                    className={cn(
                      defaultFolderId === null
                        ? "font-medium text-foreground"
                        : "text-muted-foreground"
                    )}
                    onClick={() => {
                      setDefaultFolderId(null);
                      close();
                    }}
                  >
                    Inbox
                  </SearchablePopoverItem>
                  {folders.map((f) => (
                    <SearchablePopoverItem
                      className={cn(
                        defaultFolderId === f.id
                          ? "font-medium text-foreground"
                          : "text-muted-foreground"
                      )}
                      key={f.id}
                      onClick={() => {
                        setDefaultFolderId(f.id);
                        close();
                      }}
                    >
                      {f.name}
                    </SearchablePopoverItem>
                  ))}
                </>
              )}
            </SearchablePopover>
          </div>
        </div>
      </SettingsSection>

      {/* ── Data ──────────────────────────────────────────────────────── */}
      <SettingsSection
        description="Your data stored locally and never leaves your device."
        title="Your Workspace"
      >
        <UsageStats workspace={!!workspace} />
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
            description="Human-readable export of all pages, folders, and schedules."
            disabled={!workspace}
            label="Export as JSON"
            onExport={() => void handleExportJson()}
            state={jsonExport}
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

      {/* ── Feedback ───────────────────────────────────────────────────── */}
      <SettingsSection
        description="Found a bug or have a suggestion? I'd love to hear from you."
        title="Feedback"
      >
        <div className="rounded-lg border border-border bg-card px-4">
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm font-medium">Send feedback</p>
              <p className="text-xs text-muted-foreground">pikos@hello-ak.com</p>
            </div>
            <button
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
              onClick={() => void openUrl("mailto:pikos@hello-ak.com?subject=Pikos%20Feedback")}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Email
            </button>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
