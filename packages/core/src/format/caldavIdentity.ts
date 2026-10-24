/**
 * One spelling for a CalDAV server, from whatever the user typed.
 *
 * A server has many spellings and a person uses whichever they remember.
 * `Caldav.fastmail.com`, `caldav.fastmail.com` and `https://caldav.fastmail.com/`
 * are one server: case is not significant in a hostname, and a bare host is a URL
 * with the scheme left off. Left as typed, each spelling became its own account —
 * the events synced twice and the first account's pages stayed detached, because
 * re-link is scoped by account.
 *
 * `URL` does the reducing: it lowercases the scheme and host, and gives every
 * origin the same trailing slash. It leaves the path's case alone, which matters,
 * because a CalDAV path *is* case-sensitive even when the host is not. A string it
 * cannot parse is handed back trimmed rather than rejected — discovery decides
 * whether a server is real, and it says so better than this can.
 */
export function caldavBaseUrl(typed: string): string {
  const trimmed = typed.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).href;
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
