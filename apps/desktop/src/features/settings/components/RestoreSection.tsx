// The read half of the backups the app has been writing all along.
//
// Snapshots are taken before a migration and before an import, and until now the
// only way to use one was to quit, open the application-support folder and
// rename a file. This is the same list, in the place people look when something
// has gone wrong.

import type { BackupEntry, BackupKind } from "@pikos/core";
import { storageErrorUserMessage, toStorageError } from "@pikos/core";
import { RotateCcw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { createLogger } from "@/shared/logger";

import { SettingsSection } from "./SettingsSection";

const log = createLogger("RestoreSection");

/** What each snapshot was taken ahead of, in the words of the thing that caused
 *  it rather than the filename prefix that records it. */
const REASON: Record<BackupKind, string> = {
  preImport: "Before an import",
  preMigration: "Before an update changed the workspace",
  preRestore: "Replaced by a restore",
};

function formatSize(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  });
}

type Load =
  | { status: "loading" }
  | { status: "ready"; backups: BackupEntry[] }
  | { status: "error"; message: string };

export function RestoreSection() {
  const { storage } = useWorkspace();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [chosen, setChosen] = useState<BackupEntry | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!storage) return;
    let live = true;
    storage
      .listBackups()
      .then((backups) => {
        if (live) setLoad({ backups, status: "ready" });
      })
      .catch((err: unknown) => {
        log.error("could not read the backups directory", err);
        if (live) {
          setLoad({
            message: storageErrorUserMessage(toStorageError(err), "reading your backups"),
            status: "error",
          });
        }
      });
    return () => {
      live = false;
    };
  }, [storage]);

  async function confirmRestore() {
    if (!storage || !chosen) return;
    setRestoring(true);
    setFailure(null);
    try {
      // On success this never returns: the app replaces the workspace and
      // restarts into it. Reaching the line below means it refused.
      await storage.restoreBackup(chosen.fileName);
    } catch (err: unknown) {
      log.error("restore refused", err);
      setFailure(storageErrorUserMessage(toStorageError(err), "restoring that backup"));
      setRestoring(false);
      setChosen(null);
    }
  }

  // Nothing to restore means nothing to show. An empty state earns its place when it
  // tells you how to fill it, and this one cannot: you do not take a backup, Pikos
  // does, before an update or an import. A heading explaining a thing you cannot act
  // on is dead weight in the panel people open when they are already worried.
  if (load.status === "loading" || (load.status === "ready" && load.backups.length === 0)) {
    return null;
  }

  // The read failing is worth saying out loud: the backups may be there and unreadable,
  // which is the opposite of there being none.
  if (load.status === "error") {
    return (
      <RestorePanel>
        <p className="px-4 py-3 text-xs text-destructive">{load.message}</p>
      </RestorePanel>
    );
  }

  return (
    <RestorePanel>
      {failure && (
        <p className="mb-3 text-xs text-destructive" role="alert">
          {failure}
        </p>
      )}
      <div className="rounded-lg border border-border bg-card px-4">
        {load.backups.map((backup) => (
          <div
            className="flex items-center justify-between gap-6 border-b border-border py-3 last:border-0"
            key={backup.fileName}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">{REASON[backup.kind]}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatWhen(backup.createdAt)} · {formatSize(backup.bytes)}
              </p>
            </div>
            <button
              aria-label={`Restore the backup from ${formatWhen(backup.createdAt)}`}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
              disabled={restoring}
              onClick={() => setChosen(backup)}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Restore
            </button>
          </div>
        ))}
      </div>

      <ConfirmDialog
        busy={restoring}
        cancelLabel="Keep what I have"
        confirmLabel="Restore and restart"
        description={
          chosen
            ? `Pikos will close, put this backup in place, and open again. Everything you have now is kept as a backup of its own, so you can come straight back.`
            : ""
        }
        onConfirm={() => void confirmRestore()}
        onOpenChange={(open) => {
          if (!open && !restoring) setChosen(null);
        }}
        open={chosen !== null}
        title={chosen ? `Restore the workspace from ${formatWhen(chosen.createdAt)}?` : ""}
      />
    </RestorePanel>
  );
}

/** The heading travels with the contents, so hiding one hides the other. */
function RestorePanel({ children }: { children: ReactNode }) {
  return (
    <SettingsSection
      description="Pikos snapshots your workspace before anything that rewrites it. Put one back if something has gone wrong."
      title="Restore"
    >
      {children}
    </SettingsSection>
  );
}
