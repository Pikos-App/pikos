// GeneralSettings — about, preferences (theme, editor, calendar), and feedback.

import { openUrl } from "@tauri-apps/plugin-opener";
import { Bug, Check, CheckCircle, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";

import type { CalendarDayCount, CalendarDensity } from "@/features/calendar/utils/calendarUtils";
import { cn } from "@/lib/utils";
import { SearchablePopover, SearchablePopoverItem } from "@/shared/components/SearchablePopover";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import type { WeekStart } from "@/shared/context/AppSettingsContext";
import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";
import { useEditorSettings } from "@/shared/context/EditorSettingsContext";
import type { LineWidth } from "@/shared/context/EditorSettingsContext";
import { useListSettings } from "@/shared/context/ListSettingsContext";
import type { ListDensity } from "@/shared/context/ListSettingsContext";
import type { ThemeMode } from "@/shared/context/ThemeContext";
import { useTheme } from "@/shared/context/ThemeContext";
import { useUpdate } from "@/shared/context/UpdateContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { createLogger } from "@/shared/logger";

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

const log = createLogger("GeneralSettings");

function CopyEmailRow() {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText("hello@pikos.app");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      log.warn("clipboard write failed", err);
    }
  }

  return (
    <div className="flex items-center justify-between py-3">
      <div>
        <p className="text-sm font-medium">Send feedback</p>
        <p className="text-xs text-muted-foreground">hello@pikos.app</p>
      </div>
      <button
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
        onClick={() => void handleCopy()}
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

const CALENDAR_DAY_COUNT_OPTIONS: { id: CalendarDayCount; label: string }[] = [
  { id: 1, label: "1" },
  { id: 3, label: "3" },
  { id: 5, label: "5" },
  { id: "mf", label: "M–F" },
  { id: 7, label: "7" },
];

const CALENDAR_DENSITY_OPTIONS: { id: CalendarDensity; label: string }[] = [
  { id: "compact", label: "Compact" },
  { id: "normal", label: "Normal" },
  { id: "spacious", label: "Spacious" },
];

const LIST_DENSITY_OPTIONS: { id: ListDensity; label: string }[] = [
  { id: "compact", label: "Compact" },
  { id: "cozy", label: "Cozy" },
  { id: "spacious", label: "Spacious" },
];

// ─── Component ────────────────────────────────────────────────────────────

export function GeneralSettings() {
  const updater = useUpdate();
  const { folders } = useWorkspace();
  const { defaultFolderId, setDefaultFolderId, setWeekStart, weekStart } = useAppSettings();
  const { mode, setTheme } = useTheme();
  const { lineWidth, setLineWidth } = useEditorSettings();
  const {
    dayCount: calendarDayCount,
    density: calendarDensity,
    setDayCount: setCalendarDayCount,
    setDensity: setCalendarDensity,
  } = useCalendarSettings();
  const { density: listDensity, setDensity: setListDensity } = useListSettings();

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

          {/* List density */}
          <div className="flex items-center justify-between border-b border-border py-3">
            <div>
              <p className="text-sm font-medium">List density</p>
              <p className="text-xs text-muted-foreground">
                How tightly rows pack in the page and folder lists.
              </p>
            </div>
            <div className="flex shrink-0 gap-1 rounded-md border border-border bg-background p-0.5">
              {LIST_DENSITY_OPTIONS.map((opt) => (
                <button
                  className={cn(
                    "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                    listDensity === opt.id
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  key={opt.id}
                  onClick={() => setListDensity(opt.id)}
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

          {/* Calendar day count */}
          <div className="flex items-center justify-between border-b border-border py-3">
            <div>
              <p className="text-sm font-medium">Calendar days shown</p>
              <p className="text-xs text-muted-foreground">
                Number of day columns in the calendar. Narrow windows may show fewer.
              </p>
            </div>
            <div className="flex shrink-0 gap-1 rounded-md border border-border bg-background p-0.5">
              {CALENDAR_DAY_COUNT_OPTIONS.map((opt) => (
                <button
                  className={cn(
                    "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                    calendarDayCount === opt.id
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  key={opt.id}
                  onClick={() => setCalendarDayCount(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Calendar density */}
          <div className="flex items-center justify-between border-b border-border py-3">
            <div>
              <p className="text-sm font-medium">Calendar density</p>
              <p className="text-xs text-muted-foreground">How tall each hour row renders.</p>
            </div>
            <div className="flex shrink-0 gap-1 rounded-md border border-border bg-background p-0.5">
              {CALENDAR_DENSITY_OPTIONS.map((opt) => (
                <button
                  className={cn(
                    "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                    calendarDensity === opt.id
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  key={opt.id}
                  onClick={() => setCalendarDensity(opt.id)}
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
              <p className="text-sm font-medium">Report a bug…</p>
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
