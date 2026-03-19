// GeneralSettings — workspace info: created date, record counts, DB path.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import { useWorkspace } from "@/shared/context/WorkspaceContext";

interface DbStats {
  pages: number;
  folders: number;
  schedules: number;
  focus_sessions: number;
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between border-b border-border py-2.5 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function GeneralSettings() {
  const { workspace } = useWorkspace();
  const [stats, setStats] = useState<DbStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    invoke<DbStats>("get_db_stats")
      .then(setStats)
      .catch((e: unknown) => setError(String(e)));
  }, [workspace]);

  const createdAt = workspace?.createdAt
    ? new Date(workspace.createdAt).toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "—";

  return (
    <div className="max-w-lg">
      <h2 className="mb-1 text-base font-semibold">Workspace</h2>
      <p className="mb-6 text-sm text-muted-foreground">
        {workspace?.name ?? "No workspace loaded"}
      </p>

      <div className="mb-6 rounded-lg border border-border bg-card px-4">
        <StatRow label="Created" value={createdAt} />
        <StatRow label="Folders" value={stats?.folders ?? "—"} />
        <StatRow label="Pages" value={stats?.pages ?? "—"} />
        <StatRow label="Scheduled items" value={stats?.schedules ?? "—"} />
        <StatRow label="Focus sessions" value={stats?.focus_sessions ?? "—"} />
      </div>

      <div className="rounded-lg border border-border bg-card px-4">
        <div className="flex items-start justify-between gap-3 py-2.5">
          <div className="min-w-0">
            <p className="mb-0.5 text-xs text-muted-foreground">Database path</p>
            <p className="font-mono text-xs break-all text-foreground/80">
              {workspace?.dbPath ?? "—"}
            </p>
          </div>
        </div>
      </div>

      {error && <p className="mt-4 text-xs text-destructive">Failed to load stats: {error}</p>}
    </div>
  );
}
