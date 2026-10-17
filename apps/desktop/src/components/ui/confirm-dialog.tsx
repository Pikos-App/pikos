// ConfirmDialog — thin wrapper over AlertDialog with destructive styling and a
// `busy` state that keeps the dialog open while async work runs. Cancel button
// receives initial focus, so Enter/Esc on open both cancel.

import type { ReactNode } from "react";

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

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  /** When true, dialog stays open and buttons are disabled while async work runs. */
  busy?: boolean;
  onConfirm: () => void;
  /** A second answer beside the confirm, for a question that has two. */
  alternative?: { label: string; onSelect: () => void };
}

export function ConfirmDialog({
  alternative,
  busy = false,
  cancelLabel = "Cancel",
  confirmLabel,
  description,
  onConfirm,
  onOpenChange,
  open,
  title,
  variant = "default",
}: ConfirmDialogProps) {
  return (
    <AlertDialog
      onOpenChange={(o) => {
        if (busy) return;
        onOpenChange(o);
      }}
      open={open}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{cancelLabel}</AlertDialogCancel>
          {alternative && (
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                if (busy) return;
                alternative.onSelect();
              }}
              variant="outline"
            >
              {alternative.label}
            </AlertDialogAction>
          )}
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              // preventDefault stops Radix's auto-close so the dialog stays
              // open while async work runs. Caller is responsible for closing.
              e.preventDefault();
              if (busy) return;
              onConfirm();
            }}
            variant={variant}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
