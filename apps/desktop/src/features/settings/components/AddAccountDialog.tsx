import type { NewCaldavConnection } from "@pikos/core";
import { CalendarDays, Server } from "lucide-react";
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

interface AddAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnect: (data: NewCaldavConnection) => Promise<void>;
  onConnectGoogle: () => Promise<void>;
  googleAvailable: boolean;
}

export function AddAccountDialog({
  googleAvailable,
  onConnect,
  onConnectGoogle,
  onOpenChange,
  open,
}: AddAccountDialogProps) {
  const [provider, setProvider] = useState<"caldav" | "pick">("pick");
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

  // The grant resolves only once the user finishes in their browser and can sit
  // pending a long time — the picker shows a waiting state so the click doesn't
  // look inert.
  async function submitGoogle() {
    setBusy(true);
    setError(null);
    try {
      await onConnectGoogle();
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect to Google. Try again.");
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
            {provider === "caldav"
              ? "Pikos reads your calendar over CalDAV. Your password is stored in the system keychain, never in the database."
              : "Connect an external calendar to see its events in Pikos."}
          </DialogDescription>
        </DialogHeader>

        {provider === "pick" ? (
          <div className="flex flex-col gap-2">
            <button
              className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy}
              onClick={() => setProvider("caldav")}
            >
              <Server className="size-4 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">CalDAV</p>
                <p className="text-xs text-muted-foreground">iCloud or any CalDAV server</p>
              </div>
            </button>
            <button
              className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
              disabled={!googleAvailable || busy}
              onClick={() => void submitGoogle()}
            >
              <CalendarDays className="size-4 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Google Calendar</p>
                <p className="text-xs text-muted-foreground">
                  {!googleAvailable
                    ? "Not available in this build"
                    : busy
                      ? "Waiting for you to finish in your browser…"
                      : "Sign in with your Google account"}
                </p>
              </div>
            </button>

            {error && <p className="text-xs text-destructive">{error}</p>}
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
