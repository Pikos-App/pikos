// TypedConfirmDialog — destructive-action confirmation that requires the user
// to type a specific phrase before the confirm button is enabled. The pattern
// guards against the "I clicked OK without reading" case for irreversible
// actions (account delete, data wipe, etc.).
//
// Same surface as ConfirmDialog (title / description / busy / onConfirm) plus
// `confirmPhrase` — typically the literal word "delete" rendered in the
// description so it's discoverable.

import { useEffect, useId, useRef, useState } from "react";
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

export interface TypedConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  /** Phrase the user must type to enable the confirm button. Compared case-insensitively, trimmed. */
  confirmPhrase: string;
  /** Label above the input. Defaults to `Type ${confirmPhrase} to confirm.` */
  inputLabel?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  /** When true, dialog stays open and buttons are disabled while async work runs. */
  busy?: boolean;
  onConfirm: () => void;
}

/**
 * Body lives in its own component so its `typed` state resets every time the
 * dialog opens — Radix unmounts AlertDialogContent's children on close, so
 * mounting them only when `open` gives us "fresh on each open" without
 * setState-in-effect or a key hack.
 */
function TypedConfirmBody({
  busy,
  cancelLabel,
  confirmLabel,
  confirmPhrase,
  inputLabel,
  onConfirm,
  variant,
}: {
  busy: boolean;
  cancelLabel: string;
  confirmLabel: string;
  confirmPhrase: string;
  inputLabel: ReactNode | undefined;
  onConfirm: () => void;
  variant: "default" | "destructive";
}) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  // Focus the input on mount. Without this, AlertDialogCancel takes initial
  // focus (its destructive-action default) and the user has to tab over.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  const matches = typed.trim().toLowerCase() === confirmPhrase.trim().toLowerCase();
  const canConfirm = matches && !busy;

  return (
    <>
      <div className="flex flex-col gap-2">
        <label className="text-xs text-muted-foreground" htmlFor={inputId}>
          {inputLabel ?? (
            <>
              Type <span className="font-mono font-medium text-foreground">{confirmPhrase}</span> to
              confirm.
            </>
          )}
        </label>
        {/* Bare input matching the app's idiom (SearchPalette, QuickAdd):
            transparent background, no native outline, container border supplies
            the visual frame, focus state is a subtle border-color change.
            Avoids the shadcn Input's 3px focus ring which doesn't match. */}
        <div
          className={cn(
            "flex items-center rounded-md border border-input bg-transparent px-3 transition-colors",
            "focus-within:border-ring",
            busy && "opacity-50"
          )}
        >
          <input
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className="h-9 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/40 disabled:cursor-not-allowed"
            disabled={busy}
            id={inputId}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              // Enter on a matching input commits the action — same affordance
              // as a normal form-submit, gated by the typed match.
              if (e.key === "Enter" && canConfirm) {
                e.preventDefault();
                onConfirm();
              }
            }}
            ref={inputRef}
            type="text"
            value={typed}
          />
        </div>
      </div>

      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>{cancelLabel}</AlertDialogCancel>
        <AlertDialogAction
          disabled={!canConfirm}
          onClick={(e) => {
            // preventDefault stops Radix's auto-close so the dialog stays
            // open while async work runs. Caller is responsible for closing.
            e.preventDefault();
            if (!canConfirm) return;
            onConfirm();
          }}
          variant={variant}
        >
          {confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  );
}

export function TypedConfirmDialog({
  busy = false,
  cancelLabel = "Cancel",
  confirmLabel,
  confirmPhrase,
  description,
  inputLabel,
  onConfirm,
  onOpenChange,
  open,
  title,
  variant = "destructive",
}: TypedConfirmDialogProps) {
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
        <TypedConfirmBody
          busy={busy}
          cancelLabel={cancelLabel}
          confirmLabel={confirmLabel}
          confirmPhrase={confirmPhrase}
          inputLabel={inputLabel}
          onConfirm={onConfirm}
          variant={variant}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}
