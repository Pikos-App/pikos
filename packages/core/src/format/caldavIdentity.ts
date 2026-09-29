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

/**
 * The identity a CalDAV account is matched by on reconnect: `username · base URL`.
 *
 * Takes an already-reduced URL from [`caldavBaseUrl`], so the identity and the
 * connection agree on one spelling rather than each reducing on its own.
 */
export function caldavAccountIdentity(username: string, baseUrl: string): string {
  return `${username.trim()} · ${baseUrl}`;
}
