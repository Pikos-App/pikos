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
import { cn } from "@/lib/utils";

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
}

export function ConfirmDialog({
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
          <AlertDialogAction
            className={cn(
              variant === "destructive" &&
                "bg-destructive text-destructive-foreground hover:bg-destructive/90"
            )}
            disabled={busy}
            onClick={(e) => {
              // preventDefault stops Radix's auto-close so the dialog stays
              // open while async work runs. Caller is responsible for closing.
              e.preventDefault();
              if (busy) return;
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
