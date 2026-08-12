import type { SyncAccount } from "@pikos/core";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { APP_PASSWORD_HELP, FORM_INPUT } from "./accountForm";

interface ReconnectAccountDialogProps {
  account: SyncAccount;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReconnect: (password: string) => Promise<void>;
  onReconnectGoogle: () => Promise<void>;
}

export function ReconnectAccountDialog({
  account,
  onOpenChange,
  onReconnect,
  onReconnectGoogle,
  open,
}: ReconnectAccountDialogProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const google = account.provider === "google";

  function close(next: boolean) {
    if (busy) return;
    if (!next) {
      setPassword("");
      setError(null);
    }
    onOpenChange(next);
  }

  async function submit(run: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await run();
      setPassword("");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reconnect {account.displayName}</DialogTitle>
          <DialogDescription>
            {google
              ? "Sign in again to restore access. Your calendars and pages stay as they are."
              : "Enter the app password for this account. Your calendars and pages stay as they are."}
          </DialogDescription>
        </DialogHeader>

        {google ? (
          <div className="flex flex-col gap-3">
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex justify-end">
              <Button
                disabled={busy}
                onClick={() =>
                  void submit(onReconnectGoogle, "Could not connect to Google. Try again.")
                }
                size="sm"
              >
                {busy ? "Waiting for you to finish in your browser…" : "Sign in with Google"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">App password</span>
              <input
                autoFocus
                className={FORM_INPUT}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="app-specific password"
                type="password"
                value={password}
              />
            </label>
            <a
              className="-mt-1.5 text-xs text-primary hover:underline"
              href={APP_PASSWORD_HELP}
              rel="noreferrer"
              target="_blank"
            >
              How to generate an app password
            </a>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="mt-1 flex justify-end gap-2">
              <Button disabled={busy} onClick={() => close(false)} size="sm" variant="ghost">
                Cancel
              </Button>
              <Button
                disabled={!password || busy}
                onClick={() =>
                  void submit(
                    () => onReconnect(password),
                    "Could not connect. Check the password and try again."
                  )
                }
                size="sm"
              >
                {busy ? "Reconnecting…" : "Reconnect"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
