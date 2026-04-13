// GeneralSettings — about, preferences (theme, editor, calendar), and feedback.

import { openUrl } from "@tauri-apps/plugin-opener";
import { Bug, Check, CheckCircle, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";
import { SearchablePopover, SearchablePopoverItem } from "@/shared/components/SearchablePopover";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import type { WeekStart } from "@/shared/context/AppSettingsContext";
import { useEditorSettings } from "@/shared/context/EditorSettingsContext";
import type { LineWidth } from "@/shared/context/EditorSettingsContext";
import type { ThemeMode } from "@/shared/context/ThemeContext";
import { useTheme } from "@/shared/context/ThemeContext";
import { useUpdate } from "@/shared/context/UpdateContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

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

// ─── Feedback helpers ─────────────────────────────────────────────────────

function CopyEmailRow() {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText("hello@pikos.app").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="flex items-center justify-between py-3">
      <div>
        <p className="text-sm font-medium">Send feedback</p>
        <p className="text-xs text-muted-foreground">hello@pikos.app</p>
      </div>
      <button
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
        onClick={handleCopy}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy email"}
      </button>
    </div>
  );
}

// ─── Options ──────────────────────────────────────────────────────────────

const THEME_OPTIONS: { id: ThemeMode; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "system", label: "System" },
];

const LINE_WIDTH_OPTIONS: { id: LineWidth; label: string }[] = [
  { id: "narrow", label: "Narrow" },
  { id: "default", label: "Default" },
  { id: "wide", label: "Wide" },
  { id: "full", label: "Full" },
];

// ─── Component ────────────────────────────────────────────────────────────

export function GeneralSettings() {
  const updater = useUpdate();
  const { folders } = useWorkspace();
  const { defaultFolderId, setDefaultFolderId, setWeekStart, weekStart } = useAppSettings();
  const { mode, setTheme } = useTheme();
  const { lineWidth, setLineWidth } = useEditorSettings();

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
          {(updater.status.state === "checking" || updater.status.state === "up-to-date") && (
            <div className="flex items-center gap-2 border-b border-border py-3">
              {updater.status.state === "checking" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : (
                <CheckCircle className="h-3.5 w-3.5 text-green-500" />
              )}
              <p className="text-sm text-muted-foreground">
                {updater.status.state === "checking"
                  ? "Checking for updates…"
                  : "You\u2019re on the latest version"}
              </p>
            </div>
          )}
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
          {/* Theme */}
          <div className="flex items-center justify-between border-b border-border py-3">
            <div>
              <p className="text-sm font-medium">Theme</p>
              <p className="text-xs text-muted-foreground">Choose how Pikos looks.</p>
            </div>
            <div className="flex shrink-0 gap-1 rounded-md border border-border bg-background p-0.5">
              {THEME_OPTIONS.map((opt) => (
                <button
                  className={cn(
                    "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                    mode === opt.id
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  key={opt.id}
                  onClick={() => setTheme(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Line width */}
          <div className="flex items-center justify-between border-b border-border py-3">
            <div>
              <p className="text-sm font-medium">Editor line width</p>
              <p className="text-xs text-muted-foreground">How wide the text area is.</p>
            </div>
            <div className="flex shrink-0 gap-1 rounded-md border border-border bg-background p-0.5">
              {LINE_WIDTH_OPTIONS.map((opt) => (
                <button
                  className={cn(
                    "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                    lineWidth === opt.id
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  key={opt.id}
                  onClick={() => setLineWidth(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

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

      {/* ── Feedback ───────────────────────────────────────────────────── */}
      <SettingsSection
        description="Found a bug or have a suggestion? I'd love to hear from you."
        title="Feedback"
      >
        <div className="rounded-lg border border-border bg-card px-4">
          <div className="flex items-center justify-between border-b border-border py-3">
            <div>
              <p className="text-sm font-medium">Report a bug</p>
              <p className="text-xs text-muted-foreground">
                Opens pikos.app with your version info pre-filled.
              </p>
            </div>
            <button
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
              onClick={() => {
                const os = /Mac/.test(navigator.platform) ? "macOS" : "Linux";
                const params = new URLSearchParams({ os, version: __APP_VERSION__ });
                void openUrl(`https://pikos.app/bugs?${params.toString()}`);
              }}
            >
              <Bug className="h-3.5 w-3.5" />
              Report
            </button>
          </div>
          <CopyEmailRow />
        </div>
      </SettingsSection>
    </div>
  );
}
