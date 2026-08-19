// The trash. Until this existed, a soft delete was recoverable only for as long
// as the undo toast stayed on screen; after that the row was still on disk and
// unreachable from anywhere in the app. This is the surface that reaches it.
//
// It occupies the page-list column rather than a dialog, because it is a place
// you go and look through rather than a question you answer and dismiss —
// restoring several pages one at a time is the normal case, and a modal makes
// that a sequence of reopenings.
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
import { TypedConfirmDialog } from "@/components/ui/typed-confirm-dialog";
import { EmptyState } from "@/shared/components/EmptyState";

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
    <li className="border-b border-border-subtle px-3 py-2 last:border-b-0">
      <p className="type-body-sm truncate text-foreground">{title}</p>
      <p className="type-ui-sm flex flex-wrap items-center gap-x-1.5 text-subtle">
        <span>{entry.folderName ?? "Inbox"}</span>
        <span aria-hidden>·</span>
        <span>{deletedAgoLabel(entry.deletedAt)}</span>
        {entry.isSynced && (
          <span className="rounded-sm bg-surface-hover px-1 text-text-tertiary">Synced</span>
        )}
      </p>
      {/* Under the row rather than beside it: the column is narrow and
          user-resizable, and side-by-side buttons crowd the title out first. */}
      <div className="mt-1.5 flex gap-1">
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
      </div>
    </li>
  );
}

export function TrashPanel({
  onResizeStart,
  width,
}: {
  onResizeStart: (e: React.MouseEvent) => void;
  width: number;
}) {
  const { deleteForever, emptyTrash, entries, error, loading, restore } = useTrash(true);

  // Each pending confirmation holds the row it was raised for, so the panel
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
    <div
      className="relative flex h-full shrink-0 flex-col border-r border-border-secondary bg-surface-secondary"
      style={{ width }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <h2 className="type-ui truncate font-semibold text-foreground">Trash</h2>
          <p className="type-ui-sm text-subtle">Kept for {TRASH_RETENTION_DAYS} days</p>
        </div>
        <Button
          disabled={entries.length === 0 || busy}
          onClick={() => setEmptyOpen(true)}
          size="xs"
          variant="destructive"
        >
          Empty Trash
        </Button>
      </div>

      {error !== null && (
        <p className="type-body-sm px-3 pb-2 text-destructive" role="alert">
          {error}
        </p>
      )}

      {entries.length === 0 ? (
        <EmptyState icon={Trash2} message={loading ? "Loading…" : "The trash is empty."} />
      ) : (
        <ul aria-label="Deleted pages" className="flex flex-col overflow-y-auto">
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

      {/* Drag handle — right edge */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- pointer-only resize, kbd control deferred to the post-launch a11y backlog */}
      <div
        aria-label="Resize page list"
        aria-orientation="vertical"
        className="absolute top-0 right-0 h-full w-px cursor-col-resize border-r border-border-secondary transition-[width,background-color,border-color] duration-[var(--transition-fast)] hover:w-[3px] hover:border-r-0 hover:bg-border/40 data-[dragging]:w-[3px] data-[dragging]:border-r-0 data-[dragging]:bg-border/60"
        onMouseDown={onResizeStart}
        role="separator"
      />

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
        description="Restoring gives this page back to its calendar, which takes back its title, time, and folder. Anything you wrote on it stays."
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
    </div>
  );
}
