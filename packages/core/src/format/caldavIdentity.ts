/**
 * The identity a CalDAV account is matched by on reconnect: `username · base URL`,
 * with the URL reduced to one spelling first.
 *
 * A server has many spellings and a person uses whichever they remember.
 * `Caldav.fastmail.com`, `caldav.fastmail.com` and `https://caldav.fastmail.com/`
 * are one server — case is not significant in a hostname, and the field already
 * prepends a scheme to a bare host. Matched literally, each spelling became its own
 * account: the events synced twice and the first account's pages stayed detached,
 * because re-link is scoped by account.
 *
 * The connection still uses the URL as it was typed. Only the identity is reduced,
 * so nothing changes about what is sent to the server.
 *
 * `URL` does the reduction: it lowercases the host, keeps the path's case, and gives
 * every origin the same trailing slash. A URL it cannot parse is passed through
 * rather than rejected — discovery is what decides whether a server is real, and it
 * says so better than this can.
 */
export function caldavAccountIdentity(username: string, baseUrl: string): string {
  return `${username.trim()} · ${canonicalBaseUrl(baseUrl)}`;
}

function canonicalBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).href;
  } catch {
    return baseUrl.trim();
  }
}
