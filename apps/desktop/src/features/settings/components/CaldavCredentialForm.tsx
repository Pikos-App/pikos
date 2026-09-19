// The credential body shared by the add-account and reconnect dialogs: the
// same fields, the same app-password help link, the same error line, and the
// same busy-aware action row. Each dialog keeps its own title, description, and
// submit callback.

import { Button } from "@/components/ui/button";

import { APP_PASSWORD_HELP, FORM_INPUT } from "./accountForm";

const SERVER_HINT_ID = "caldav-server-url-hint";

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

/** "a, b and c" — the reading order, not a bulleted list of one or two things. */
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

  // Only once something has been typed. On an untouched form the list is every
  // field and says nothing the empty inputs don't; the case worth naming is the
  // half-filled one, where Connect is grey and the reason isn't on screen.
  const started = !!(password || server?.url.trim() || server?.username.trim());

  return (
    <div className="flex flex-col gap-3">
      {server && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">Server URL</span>
            <input
              aria-describedby={SERVER_HINT_ID}
              autoFocus
              className={FORM_INPUT}
              onChange={(e) => server.onUrlChange(e.target.value)}
              placeholder="https://caldav.example.com"
              value={server.url}
            />
          </label>
          {/* Outside the label, because a description is not part of the field's
              name. The placeholder used to be a real iCloud URL, which read as a
              value already filled in while Connect stayed grey saying nothing; this
              carries what it was there to carry. */}
          <span className="-mt-2 text-xs text-subtle" id={SERVER_HINT_ID}>
            iCloud is https://caldav.icloud.com, Fastmail https://caldav.fastmail.com
          </span>
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
