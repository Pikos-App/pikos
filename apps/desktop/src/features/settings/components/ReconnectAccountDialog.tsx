import type { SyncAccount } from "@pikos/core";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createLogger } from "@/shared/logger";

import { calendarErrorMessage } from "../utils/calendarErrorMessage";
import { CaldavCredentialForm } from "./CaldavCredentialForm";

const log = createLogger("ReconnectAccountDialog");

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

  async function submit(run: () => Promise<void>, verb: string) {
    setBusy(true);
    setError(null);
    try {
      await run();
      setPassword("");
      onOpenChange(false);
    } catch (e) {
      log.warn(`reconnecting account ${account.id} failed`, e);
      setError(calendarErrorMessage(e, verb));
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
                onClick={() => void submit(onReconnectGoogle, "reconnecting to Google")}
                size="sm"
              >
                {busy ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Waiting for your browser…
                  </>
                ) : (
                  "Sign in with Google"
                )}
              </Button>
            </div>
          </div>
        ) : (
          <CaldavCredentialForm
            busy={busy}
            busyLabel="Reconnecting…"
            error={error}
            onPasswordChange={setPassword}
            onSecondary={() => close(false)}
            onSubmit={() => void submit(() => onReconnect(password), "reconnecting the account")}
            password={password}
            secondaryLabel="Cancel"
            submitLabel="Reconnect"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
