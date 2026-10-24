import type { NewCaldavConnection } from "@pikos/core";
import { caldavAccountIdentity, caldavBaseUrl } from "@pikos/core";
import { CalendarDays, Cloud, Loader2, Server } from "lucide-react";
import { useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { CALDAV_PRESETS, type CaldavPreset } from "./accountForm";
import { CaldavCredentialForm } from "./CaldavCredentialForm";
import { ProviderOption } from "./ProviderOption";

/** The CalDAV form is reached from a named provider, which fills in its server, or
 *  from the generic row with nothing filled in. */
type Step = { kind: "pick" } | { kind: "caldav"; preset: CaldavPreset | null };

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
  const [step, setStep] = useState<Step>({ kind: "pick" });
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
    setStep({ kind: "pick" });
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

  function chooseCaldav(preset: CaldavPreset | null) {
    setStep({ kind: "caldav", preset });
    setServerUrl(preset?.url ?? "");
    setError(null);
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
            {step.kind === "caldav"
              ? "Pikos reads your calendar over CalDAV. Your password is stored in the system keychain, never in the database."
              : "Connect an external calendar to see its events in Pikos."}
          </DialogDescription>
        </DialogHeader>

        {step.kind === "pick" ? (
          <div className="flex flex-col gap-2">
            {CALDAV_PRESETS.map((preset) => (
              <ProviderOption
                disabled={busy}
                icon={Cloud}
                key={preset.name}
                onClick={() => chooseCaldav(preset)}
                subtitle={`${preset.name} calendars, with an app password`}
                title={preset.name}
              />
            ))}
            <ProviderOption
              disabled={!googleAvailable || busy}
              icon={busy ? Loader2 : CalendarDays}
              iconClassName={busy ? "animate-spin" : undefined}
              onClick={() => void submitGoogle()}
              subtitle={
                !googleAvailable
                  ? "Not available in this build"
                  : busy
                    ? "Waiting for your browser. Finish signing in there, or close this to stop waiting."
                    : "Sign in with your Google account"
              }
              title="Google Calendar"
            />
            <ProviderOption
              disabled={busy}
              icon={Server}
              onClick={() => chooseCaldav(null)}
              subtitle="Any server that speaks CalDAV, such as Nextcloud, mailbox.org or Posteo"
              title="CalDAV"
            />

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        ) : (
          <CaldavCredentialForm
            busy={busy}
            busyLabel="Connecting…"
            error={error}
            onPasswordChange={setPassword}
            onSecondary={() => setStep({ kind: "pick" })}
            onSubmit={() => void submit()}
            password={password}
            secondaryLabel="Back"
            server={{
              onUrlChange: setServerUrl,
              onUsernameChange: setUsername,
              preset: step.preset,
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
