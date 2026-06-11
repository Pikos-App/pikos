// The user-facing "Delete All Data" action lives in Data settings, not here.

import { appLogDir, join } from "@tauri-apps/api/path";
import { openPath } from "@tauri-apps/plugin-opener";
import { FileText } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { createLogger } from "@/shared/logger";

const logger = createLogger("DeveloperSettings");

type SeedScenario =
  | "tutorial"
  | "realistic"
  | "stress"
  | "notifications"
  | "calendar"
  | "calendar-colors"
  | "calendar-edges";

const SEED_SCENARIOS: { id: SeedScenario; label: string; description: string }[] = [
  {
    description: "Default onboarding content for first launch.",
    id: "tutorial",
    label: "Tutorial",
  },
  {
    description: "Believable day-to-day life: work, personal, reading.",
    id: "realistic",
    label: "Realistic",
  },
  {
    description: "Heavy load: many folders, pages, and schedules.",
    id: "stress",
    label: "Stress",
  },
  {
    description:
      "~22 pages anchored to now for testing reminders: imminent, overdue, all-day, completed, disabled, and various lead times.",
    id: "notifications",
    label: "Notifications",
  },
  {
    description: "7 days of progressively denser overlap patterns for layout testing.",
    id: "calendar",
    label: "Calendar layout",
  },
  {
    description: "Same as Calendar layout, split across 5 color-coded folders.",
    id: "calendar-colors",
    label: "Calendar (multi-color)",
  },
  {
    description:
      "Targeted regression fixtures across 4 weeks (cross-midnight, containment, density, color muting).",
    id: "calendar-edges",
    label: "Calendar edge cases",
  },
];

export function DeveloperSettings() {
  const { resetAndSeed, workspace } = useWorkspace();
  const { setSettingsOpen } = useUI();
  const [pending, setPending] = useState<SeedScenario | null>(null);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [logError, setLogError] = useState(false);

  async function handleSeed(scenario: SeedScenario) {
    if (!workspace) return;
    setRunning(true);
    setLog(null);
    try {
      await resetAndSeed(scenario);
      setSettingsOpen(false);
    } catch (e: unknown) {
      setLog(String(e));
      setLogError(true);
    } finally {
      setRunning(false);
    }
  }

  async function handleConfirm() {
    if (!pending) return;
    const scenario = pending;
    setPending(null);
    await handleSeed(scenario);
  }

  async function handleOpenLogs() {
    try {
      const path = await join(await appLogDir(), "pikos.log");
      await openPath(path);
    } catch (err) {
      logger.warn("open logs failed", err);
    }
  }

  return (
    <div className="max-w-lg">
      <h2 className="mb-1 text-base font-semibold">Developer Tools</h2>
      <p className="mb-6 text-sm text-muted-foreground">
        Seed scripts for development. For destructive actions affecting all data, see Data → Danger
        Zone.
      </p>

      {/* Seed scenarios */}
      <div className="divide-y divide-border rounded-lg border border-border bg-card">
        {SEED_SCENARIOS.map((s) => (
          <div className="flex items-start justify-between gap-4 p-4" key={s.id}>
            <div>
              <p className="text-sm font-medium">{s.label}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{s.description}</p>
            </div>
            <Button
              disabled={running || !workspace}
              onClick={() => setPending(s.id)}
              size="sm"
              variant="outline"
            >
              Seed
            </Button>
          </div>
        ))}
      </div>

      {/* Log output */}
      {running && <p className="mt-4 animate-pulse text-xs text-muted-foreground">Running…</p>}
      {log && !running && (
        <pre
          className={`mt-4 rounded-md p-3 font-mono text-xs whitespace-pre-wrap ${
            logError ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"
          }`}
        >
          {log}
        </pre>
      )}

      {/* Diagnostics */}
      <div className="mt-8 rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-4 p-4">
          <div>
            <p className="text-sm font-medium">Logs</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Useful for filing bug reports.</p>
          </div>
          <Button onClick={() => void handleOpenLogs()} size="sm" variant="outline">
            <FileText className="h-3.5 w-3.5" />
            View
          </Button>
        </div>
      </div>

      <ConfirmDialog
        confirmLabel="Confirm"
        description={`The current database will be wiped and replaced with the “${pending ?? ""}” seed data. This cannot be undone.`}
        onConfirm={() => void handleConfirm()}
        onOpenChange={(o) => !o && setPending(null)}
        open={pending !== null}
        title={`Seed with “${pending ?? ""}” data?`}
        variant="destructive"
      />
    </div>
  );
}
