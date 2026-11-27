/**
 * One spelling for a CalDAV server, from whatever the user typed:
 * `Caldav.fastmail.com`, `caldav.fastmail.com` and `https://caldav.fastmail.com/` are one
 * server. Left as typed, each spelling became its own account, so events synced twice and
 * the first account's pages stayed detached (re-link is scoped by account).
 *
 * The path's case is kept, because a CalDAV path is case-sensitive even when the host is
 * not. A string `URL` cannot parse comes back trimmed rather than rejected; discovery
 * reports a bad server better than this can.
 */
export function caldavBaseUrl(typed: string): string {
  const trimmed = typed.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).href;
    // eslint-disable-next-line pikos/no-silent-catch -- a half-typed address is normal in the form, and discovery reports a bad one
  } catch {
    return trimmed;
  }
}

const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

/**
 * Whether connecting to `typed` sends the app password unencrypted over a network: the client
 * sends it as Basic auth on the first request, so plain `http://` to any host but this machine
 * puts it on the wire in the clear.
 */
export function caldavSendsPasswordInClear(typed: string): boolean {
  let url: URL;
  try {
    url = new URL(caldavBaseUrl(typed));
    // eslint-disable-next-line pikos/no-silent-catch -- an address that isn't a URL yet can't send a password at all
  } catch {
    return false;
  }

  const isPlainHttp = url.protocol === "http:";
  const isThisMachine = LOOPBACK_HOST.test(url.hostname);

  return isPlainHttp && !isThisMachine;
}

/**
 * The identity a CalDAV account is matched by on reconnect: `username · base URL`.
 *
 * Takes an already-reduced URL from [`caldavBaseUrl`], so the identity and the
 * connection agree on one spelling rather than each reducing on its own.
 */
export function caldavAccountIdentity(username: string, baseUrl: string): string {
  return `${username.trim()} · ${baseUrl}`;
}
