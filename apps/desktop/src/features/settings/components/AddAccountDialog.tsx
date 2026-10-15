import type { NewCaldavConnection } from "@pikos/core";
import { caldavAccountIdentity, caldavBaseUrl } from "@pikos/core";
import { CalendarDays, Loader2, Server } from "lucide-react";
import { useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { CaldavCredentialForm } from "./CaldavCredentialForm";

/**
 * What the dialog is waiting on, which decides whether it may be dismissed.
 *
 * `connecting` is writing an account and has to finish. `awaitingGoogle` is waiting
 * for a browser the user may already have closed, and nothing is persisted until the
 * callback arrives, so abandoning it is safe and is the only way out. One boolean
 * covered both, which made an abandoned Google attempt an undismissable dialog for
 * the five minutes the loopback listener holds its port.
 */
type Progress = { kind: "idle" } | { kind: "connecting" } | { kind: "awaitingGoogle" };

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
  const [progress, setProgress] = useState<Progress>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  // Bumped when a Google attempt is abandoned, so the one still in flight knows
  // its result is no longer wanted.
  const googleAttempt = useRef(0);
  const busy = progress.kind !== "idle";

  function reset() {
    setProvider("pick");
    setServerUrl("");
    setUsername("");
    setPassword("");
    setError(null);
    setProgress({ kind: "idle" });
  }

  function close(next: boolean) {
    if (progress.kind === "connecting") return;
    if (progress.kind === "awaitingGoogle") googleAttempt.current += 1;
    if (!next) reset();
    onOpenChange(next);
  }

  async function submit() {
    setProgress({ kind: "connecting" });
    setError(null);
    // One spelling for the server, used for both the connection and the identity
    // that decides whether this is a new account — see `caldavBaseUrl`.
    const baseUrl = caldavBaseUrl(serverUrl);
    try {
      await onConnect({
        baseUrl,
        displayName: caldavAccountIdentity(username, baseUrl),
        password,
        username: username.trim(),
      });
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not connect. Check the server and password."
      );
      setProgress({ kind: "idle" });
    }
  }

  // The grant resolves only once the user finishes in their browser and can sit
  // pending a long time — the picker shows a waiting state so the click doesn't
  // look inert. A dismissed dialog abandons the attempt: the account still lands if
  // the user finishes in the browser, because `onConnectGoogle` has already done
  // the work and refreshed the panel by the time this resolves.
  async function submitGoogle() {
    const attempt = googleAttempt.current;
    setProgress({ kind: "awaitingGoogle" });
    setError(null);
    try {
      await onConnectGoogle();
      if (googleAttempt.current !== attempt) return;
      reset();
      onOpenChange(false);
    } catch (e) {
      if (googleAttempt.current !== attempt) return;
      setError(e instanceof Error ? e.message : "Could not connect to Google. Try again.");
      setProgress({ kind: "idle" });
    }
  }

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
              {busy ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : (
                <CalendarDays className="size-4 text-muted-foreground" />
              )}
              <div>
                <p className="text-sm font-medium">Google Calendar</p>
                <p className="text-xs text-muted-foreground">
                  {!googleAvailable
                    ? "Not available in this build"
                    : busy
                      ? "Waiting for your browser. Finish signing in there, or close this to stop waiting."
                      : "Sign in with your Google account"}
                </p>
              </div>
            </button>

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        ) : (
          <CaldavCredentialForm
            busy={busy}
            busyLabel="Connecting…"
            error={error}
            onPasswordChange={setPassword}
            onSecondary={() => setProvider("pick")}
            onSubmit={() => void submit()}
            password={password}
            secondaryLabel="Back"
            server={{
              onUrlChange: setServerUrl,
              onUsernameChange: setUsername,
              url: serverUrl,
              username,
            }}
            submitLabel="Connect"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
