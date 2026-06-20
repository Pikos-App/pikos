import type { NewCaldavConnection } from "@pikos/core";
import { Server } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const APP_PASSWORD_HELP = "https://pikos.app/calendar-sync#app-password";

interface AddAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnect: (data: NewCaldavConnection) => Promise<void>;
}

const FORM_INPUT =
  "w-full rounded border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-text-tertiary focus-visible:border-ring focus-visible:outline-none";

export function AddAccountDialog({ onConnect, onOpenChange, open }: AddAccountDialogProps) {
  const [provider, setProvider] = useState<"pick" | "caldav">("pick");
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setProvider("pick");
    setServerUrl("");
    setUsername("");
    setPassword("");
    setError(null);
    setBusy(false);
  }

  function close(next: boolean) {
    if (busy) return;
    if (!next) reset();
    onOpenChange(next);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    // Default a bare host to https:// — users routinely type "caldav.icloud.com"
    // without a scheme, which would otherwise fail discovery confusingly.
    const trimmedUrl = serverUrl.trim();
    const baseUrl = /^https?:\/\//i.test(trimmedUrl) ? trimmedUrl : `https://${trimmedUrl}`;
    try {
      await onConnect({
        baseUrl,
        displayName: `${username.trim()} · ${baseUrl}`,
        password,
        username: username.trim(),
      });
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not connect. Check the server and password."
      );
      setBusy(false);
    }
  }

  const canSubmit = serverUrl.trim() && username.trim() && password && !busy;

  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add calendar account</DialogTitle>
          <DialogDescription>
            {provider === "pick"
              ? "Connect an external calendar to see its events in Pikos."
              : "Pikos reads your calendar over CalDAV. Your password is stored in the system keychain, never in the database."}
          </DialogDescription>
        </DialogHeader>

        {provider === "pick" ? (
          <div className="flex flex-col gap-2">
            <button
              className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-accent"
              onClick={() => setProvider("caldav")}
            >
              <Server className="size-4 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">CalDAV</p>
                <p className="text-xs text-muted-foreground">iCloud or any CalDAV server</p>
              </div>
            </button>
            <button
              className="flex cursor-not-allowed items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left opacity-50"
              disabled
            >
              <div>
                <p className="text-sm font-medium">Google Calendar</p>
                <p className="text-xs text-muted-foreground">Coming soon</p>
              </div>
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Server URL</span>
              <input
                autoFocus
                className={FORM_INPUT}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://caldav.icloud.com"
                value={serverUrl}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Username</span>
              <input
                className={FORM_INPUT}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="you@example.com"
                value={username}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">App password</span>
              <input
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
              <Button disabled={busy} onClick={() => setProvider("pick")} size="sm" variant="ghost">
                Back
              </Button>
              <Button disabled={!canSubmit} onClick={() => void submit()} size="sm">
                {busy ? "Connecting…" : "Connect"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
