// The trash. Until this existed, a soft delete was recoverable only for as long
// as the undo toast stayed on screen; after that the row was still on disk and
// unreachable from anywhere in the app. This is the surface that reaches it.
//
// Two things it refuses to pretend about:
//   - A page whose calendar still owns it cannot be destroyed here. Its row
//     carries the tombstone that stops the next sync pass re-creating the event,
//     so "Delete Forever" is offered but disabled, and the row says why.
//   - Restoring such a page hands it back to the calendar, which takes back its
//     title, time and folder — the same bargain the Calendar Sync panel names
//     when a calendar is turned back on. So that one asks first.

import type { TrashedPage } from "@pikos/core";
import { RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TypedConfirmDialog } from "@/components/ui/typed-confirm-dialog";
import { EmptyState } from "@/shared/components/EmptyState";
import { useUI } from "@/shared/context/UIContext";

import { TRASH_RETENTION_DAYS } from "../constants";
import { useTrash } from "../hooks/useTrash";
import { deletedAgoLabel } from "../utils/deletedAgo";

/** Why a mirror cannot be destroyed from here, in the words the CLI's
 *  `delete --hard` already uses for the same refusal. */
const SYNCED_CANNOT_DESTROY =
  "This event comes from a connected calendar — delete it there, or disconnect the calendar first.";

function TrashRow({
  entry,
  onDeleteForever,
  onRestore,
}: {
  entry: TrashedPage;
  onRestore: () => void;
  onDeleteForever: () => void;
}) {
  const title = entry.title || "Untitled";
  return (
    <li className="flex items-center gap-3 border-b border-border-subtle px-1 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="type-body-sm truncate text-foreground">{title}</p>
        <p className="type-ui-sm flex flex-wrap items-center gap-x-1.5 text-subtle">
          <span>{entry.folderName ?? "Inbox"}</span>
          <span aria-hidden>·</span>
          <span>{deletedAgoLabel(entry.deletedAt)}</span>
          {entry.isSynced && (
            <span className="rounded-sm bg-surface-hover px-1 text-text-tertiary">Synced</span>
          )}
        </p>
      </div>
      <Button aria-label={`Restore ${title}`} onClick={onRestore} size="xs" variant="outline">
        <RotateCcw />
        Restore
      </Button>
      <Button
        aria-label={`Delete ${title} forever`}
        disabled={entry.isSynced}
        onClick={onDeleteForever}
        size="xs"
        title={entry.isSynced ? SYNCED_CANNOT_DESTROY : undefined}
        variant="ghost"
      >
        <Trash2 />
        Delete Forever
      </Button>
    </li>
  );
}

export function TrashDialog() {
  const { openDialog, setOpenDialog } = useUI();
  const isOpen = openDialog === "trash";
  const { deleteForever, emptyTrash, entries, error, loading, restore } = useTrash(isOpen);

  // Each pending confirmation holds the row it was raised for, so the dialog
  // can name it — and so dismissing one can't act on a different row.
  const [pendingDelete, setPendingDelete] = useState<TrashedPage | null>(null);
  const [pendingRestore, setPendingRestore] = useState<TrashedPage | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<unknown>, done: () => void) {
    setBusy(true);
    await work();
    setBusy(false);
    done();
  }

  function onRestore(entry: TrashedPage) {
    // A native page comes back as it was, so asking would be noise. A mirror
    // hands control back to its calendar, which is a change to the page.
    if (entry.isSynced) setPendingRestore(entry);
    else void restore(entry.id);
  }

  return (
    <>
      <Dialog onOpenChange={(open) => setOpenDialog(open ? "trash" : null)} open={isOpen}>
        <DialogContent aria-label="Trash" className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Trash</DialogTitle>
            <DialogDescription>
              Deleted pages are kept for {TRASH_RETENTION_DAYS} days.
            </DialogDescription>
          </DialogHeader>

          {error !== null && (
            <p className="type-body-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          {entries.length === 0 ? (
            <EmptyState icon={Trash2} message={loading ? "Loading…" : "The trash is empty."} />
          ) : (
            <ul aria-label="Deleted pages" className="max-h-[50vh] overflow-y-auto">
              {entries.map((entry) => (
                <TrashRow
                  entry={entry}
                  key={entry.id}
                  onDeleteForever={() => setPendingDelete(entry)}
                  onRestore={() => onRestore(entry)}
                />
              ))}
            </ul>
          )}

          <div className="flex justify-end">
            <Button
              disabled={entries.length === 0 || busy}
              onClick={() => setEmptyOpen(true)}
              size="sm"
              variant="destructive"
            >
              Empty Trash
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        busy={busy}
        confirmLabel="Delete forever"
        description={`“${pendingDelete?.title || "Untitled"}” will be gone for good. This cannot be undone.`}
        onConfirm={() => {
          const id = pendingDelete?.id;
          if (id)
            void run(
              () => deleteForever(id),
              () => setPendingDelete(null)
            );
        }}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        open={pendingDelete !== null}
        title="Delete this page forever?"
        variant="destructive"
      />

      <ConfirmDialog
        busy={busy}
        confirmLabel="Restore"
        description={`Restoring gives this page back to its calendar, which takes back its title, time, and folder. Anything you wrote on it stays.`}
        onConfirm={() => {
          const id = pendingRestore?.id;
          if (id)
            void run(
              () => restore(id),
              () => setPendingRestore(null)
            );
        }}
        onOpenChange={(open) => !open && setPendingRestore(null)}
        open={pendingRestore !== null}
        title={`Restore “${pendingRestore?.title || "Untitled"}”?`}
      />

      <TypedConfirmDialog
        busy={busy}
        confirmLabel="Empty Trash"
        confirmPhrase="delete"
        description={
          entries.some((e) => e.isSynced)
            ? "Every page in the trash will be gone for good, except the ones a connected calendar still owns — those stay so the calendar can't put them back."
            : "Every page in the trash will be gone for good. This cannot be undone."
        }
        onConfirm={() => void run(emptyTrash, () => setEmptyOpen(false))}
        onOpenChange={setEmptyOpen}
        open={emptyOpen}
        title="Empty the trash?"
      />
    </>
  );
}
