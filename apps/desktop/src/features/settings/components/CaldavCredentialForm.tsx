// The credential body shared by the add-account and reconnect dialogs: the
// same fields, the same app-password help link, the same error line, and the
// same busy-aware action row. Each dialog keeps its own title, description, and
// submit callback.

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
  /** Replaces submitLabel while `busy`. */
  busyLabel: string;
  onSubmit: () => void;
  secondaryLabel: string;
  onSecondary: () => void;
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
  const canSubmit = server
    ? !!(server.url.trim() && server.username.trim() && password) && !busy
    : !!password && !busy;

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
              placeholder="https://caldav.icloud.com"
              value={server.url}
            />
          </label>
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
        className="-mt-1.5 text-xs text-primary hover:underline"
        href={APP_PASSWORD_HELP}
        rel="noreferrer"
        target="_blank"
      >
        How to generate an app password
      </a>

      {error && <p className="text-xs text-destructive">{error}</p>}

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
