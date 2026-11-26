import type { SyncAccount } from "../types";

/** `display_name` is the reconnect identity key: `find_account_by_identity` matches on provider
 *  plus this exact string, so a CalDAV account keeps its stored `"user@host · https://server"`
 *  form. Shortening it would make two accounts at different servers with one address collide and
 *  reconnect onto the wrong row. The UI derives what it shows and never rewrites what it stores. */
const IDENTITY_SEPARATOR = " · ";

/** Hosts worth naming, since a CalDAV account is stored against a server URL, which means nothing
 *  to someone who typed their email into a box labelled Fastmail. Unlisted hosts get the generic
 *  protocol name, not a brand guessed from a hostname. */
const CALDAV_HOSTS: readonly (readonly [string, string])[] = [
  ["caldav.fastmail.com", "Fastmail"],
  ["caldav.icloud.com", "iCloud"],
  ["p.icloud.com", "iCloud"],
  ["apidata.googleusercontent.com", "Google"],
  ["nextcloud", "Nextcloud"],
  ["posteo.de", "Posteo"],
  ["mailbox.org", "mailbox.org"],
  ["zoho.com", "Zoho"],
  ["fruux.com", "fruux"],
  ["baikal", "Baïkal"],
  ["radicale", "Radicale"],
];

/** The email, without the server the person typed once and never needs to see again. */
export function accountAddress(account: Pick<SyncAccount, "displayName">): string {
  const cut = account.displayName.indexOf(IDENTITY_SEPARATOR);
  return cut === -1 ? account.displayName : account.displayName.slice(0, cut);
}

/** The server half, for editing the connection. */
export function accountServerUrl(account: Pick<SyncAccount, "displayName">): string | null {
  const cut = account.displayName.indexOf(IDENTITY_SEPARATOR);
  return cut === -1 ? null : account.displayName.slice(cut + IDENTITY_SEPARATOR.length);
}

/** Google accounts say Google; CalDAV says its host's brand when known, else "CalDAV". */
export function accountProviderLabel(
  account: Pick<SyncAccount, "displayName" | "provider">
): string {
  if (account.provider === "google") return "Google";
  const url = accountServerUrl(account)?.toLowerCase() ?? "";
  const match = CALDAV_HOSTS.find(([host]) => url.includes(host));
  return match ? match[1] : "CalDAV";
}
