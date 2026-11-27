// Credential body shared by the add-account and reconnect dialogs; each keeps its own title, description and submit.

import { caldavSendsPasswordInClear } from "@pikos/core";

import { Button } from "@/components/ui/button";

import { APP_PASSWORD_HELP, FORM_INPUT } from "./accountForm";

interface CaldavCredentialFormProps {
  password: string;
  onPasswordChange: (value: string) => void;
  /** Present when the server still has to be named (adding an account); absent
   *  when reconnecting one whose URL and username are already known. */
  server?: {
    url: string;
    onUrlChange: (value: string) => void;
    username: string;
    onUsernameChange: (value: string) => void;
  };
  error: string | null;
  busy: boolean;
  submitLabel: string;
  busyLabel: string;
  onSubmit: () => void;
  secondaryLabel: string;
  onSecondary: () => void;
}

/** Joins names as "a, b and c". */
function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function CaldavCredentialForm({
  busy,
  busyLabel,
  error,
  onPasswordChange,
  onSecondary,
  onSubmit,
  password,
  secondaryLabel,
  server,
  submitLabel,
}: CaldavCredentialFormProps) {
  const missing = [
    server && !server.url.trim() && "a server URL",
    server && !server.username.trim() && "a username",
    !password && "an app password",
  ].filter((m): m is string => typeof m === "string");
  const canSubmit = missing.length === 0 && !busy;

  // Only once something is typed: an untouched form would list every field. The half-filled
  // form is the case worth naming, where Connect is grey and the reason isn't on screen.
  const started = !!(password || server?.url.trim() || server?.username.trim());

  return (
    <div className="flex flex-col gap-3">
      {server && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">Server URL</span>
            <input
              autoFocus
              className={FORM_INPUT}
              onChange={(e) => server.onUrlChange(e.target.value)}
              placeholder="https://caldav.example.com"
              value={server.url}
            />
          </label>
          {caldavSendsPasswordInClear(server.url) && (
            <p className="-mt-1.5 text-xs text-amber-800 dark:text-amber-400">
              Without https://, your password crosses the network unencrypted.
            </p>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">Username</span>
            <input
              className={FORM_INPUT}
              onChange={(e) => server.onUsernameChange(e.target.value)}
              placeholder="you@example.com"
              value={server.username}
            />
          </label>
        </>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium">App password</span>
        <input
          autoFocus={!server}
          className={FORM_INPUT}
          onChange={(e) => onPasswordChange(e.target.value)}
          placeholder="app-specific password"
          type="password"
          value={password}
        />
      </label>
      <a
        className="-mt-1.5 text-xs text-action hover:underline"
        href={APP_PASSWORD_HELP}
        rel="noreferrer"
        target="_blank"
      >
        How to generate an app password
      </a>

      {error && <p className="text-xs text-destructive">{error}</p>}
      {!error && !busy && started && missing.length > 0 && (
        <p className="text-xs text-subtle">Needs {listWords(missing)}.</p>
      )}

      <div className="mt-1 flex justify-end gap-2">
        <Button disabled={busy} onClick={onSecondary} size="sm" variant="ghost">
          {secondaryLabel}
        </Button>
        <Button disabled={!canSubmit} onClick={onSubmit} size="sm">
          {busy ? busyLabel : submitLabel}
        </Button>
      </div>
    </div>
  );
}
