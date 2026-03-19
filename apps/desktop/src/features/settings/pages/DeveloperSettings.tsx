// DeveloperSettings — seed scripts + database reset. Dev-only tooling.

import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

type SeedScenario = "demo" | "realistic" | "tutorial" | "stress" | "dst";

const SEED_SCENARIOS: { id: SeedScenario; label: string; description: string }[] = [
  {
    description: "Polished, photogenic data for screenshots and videos.",
    id: "demo",
    label: "Demo",
  },
  {
    description: "Believable day-to-day life: work, personal, reading.",
    id: "realistic",
    label: "Realistic",
  },
  {
    description: "Default onboarding content for first launch.",
    id: "tutorial",
    label: "Tutorial",
  },
  {
    description: "Heavy load: many folders, pages, and schedules.",
    id: "stress",
    label: "Stress",
  },
  {
    description: "PST vs PDT edge cases around US spring-forward.",
    id: "dst",
    label: "DST",
  },
];

type PendingAction = { type: "reset" } | { type: "seed"; scenario: SeedScenario };

export function DeveloperSettings() {
  const { reload, workspace } = useWorkspace();
  const { setSettingsOpen } = useUI();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [running, setRunning] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [logError, setLogError] = useState(false);

  async function handleBackup() {
    if (!workspace) return;
    setBackingUp(true);
    setLog(null);
    try {
      const dest = await invoke<string>("backup_db");
      setLog(`Backup saved to:\n${dest}`);
      setLogError(false);
    } catch (e: unknown) {
      setLog(String(e));
      setLogError(true);
    } finally {
      setBackingUp(false);
    }
  }

  async function handleReset() {
    if (!workspace) return;
    setRunning(true);
    setLog(null);
    try {
      await invoke("reset_db");
      await reload();
      setLog("Database cleared.");
      setLogError(false);
    } catch (e: unknown) {
      setLog(String(e));
      setLogError(true);
    } finally {
      setRunning(false);
    }
  }

  async function handleSeed(scenario: SeedScenario) {
    if (!workspace) return;
    setRunning(true);
    setLog(null);
    try {
      await invoke("reset_db");
      await invoke("run_seed", { dbPath: workspace.dbPath, scenario });
      await reload();
      setSettingsOpen(false);
    } catch (e: unknown) {
      setLog(String(e));
      setLogError(true);
    } finally {
      setRunning(false);
    }
  }

  function confirm(action: PendingAction) {
    setPending(action);
  }

  async function handleConfirm() {
    if (!pending) return;
    setPending(null);
    if (pending.type === "reset") {
      await handleReset();
    } else {
      await handleSeed(pending.scenario);
    }
  }

  const dialogTitle =
    pending?.type === "reset" ? "Clear database?" : `Seed with "${pending?.scenario}" data?`;

  const dialogDescription =
    pending?.type === "reset"
      ? "All pages, folders, schedules, and focus sessions will be permanently deleted. This cannot be undone."
      : `The current database will be wiped and replaced with the "${pending?.scenario}" seed data. This cannot be undone.`;

  return (
    <div className="max-w-lg">
      <h2 className="mb-1 text-base font-semibold">Developer Tools</h2>
      <p className="mb-6 text-sm text-muted-foreground">
        Seed scripts and database utilities. For development use only.
      </p>

      {/* Backup */}
      <div className="mb-4 rounded-lg border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Backup database</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Save a clean copy to ~/Downloads. Safe to run any time.
            </p>
          </div>
          <Button
            disabled={backingUp || running || !workspace}
            onClick={() => void handleBackup()}
            size="sm"
            variant="outline"
          >
            {backingUp ? "Saving…" : "Backup"}
          </Button>
        </div>
      </div>

      {/* Reset */}
      <div className="mb-4 rounded-lg border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Clear database</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Permanently delete all data. Schema and migrations are preserved.
            </p>
          </div>
          <Button
            disabled={running || !workspace}
            onClick={() => confirm({ type: "reset" })}
            size="sm"
            variant="destructive"
          >
            Clear
          </Button>
        </div>
      </div>

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
              onClick={() => confirm({ scenario: s.id, type: "seed" })}
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

      {/* Confirmation dialog */}
      <AlertDialog onOpenChange={(o) => !o && setPending(null)} open={pending !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialogTitle}</AlertDialogTitle>
            <AlertDialogDescription>{dialogDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
              onClick={() => void handleConfirm()}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
