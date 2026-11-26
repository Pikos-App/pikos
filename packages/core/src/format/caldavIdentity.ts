/**
 * One spelling for a CalDAV server, from whatever the user typed: `Caldav.fastmail.com`,
 * `caldav.fastmail.com` and `https://caldav.fastmail.com/` are one server. Left as typed, each
 * spelling became its own account: events synced twice and the first account's pages stayed
 * detached, since re-link is scoped by account.
 *
 * `URL` lowercases the scheme and host and gives every origin the same trailing slash. It leaves
 * the path's case alone, because a CalDAV path is case-sensitive. An unparseable string comes
 * back trimmed, not rejected: discovery decides whether a server is real.
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

/** The identity an account is matched by on reconnect: `username · base URL`. Takes the URL from
 * {@link caldavBaseUrl}, so identity and connection agree on one spelling. */
export function caldavAccountIdentity(username: string, baseUrl: string): string {
  return `${username.trim()} · ${baseUrl}`;
}
