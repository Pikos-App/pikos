import type { SyncAccount } from "../types";

/** `display_name` is the reconnect identity key: `find_account_by_identity` matches
 *  on provider plus this exact string, so a CalDAV account keeps its stored
 *  `"user@host · https://server"` form forever. Shortening the column would make
 *  two accounts at different servers with the same address collide and reconnect
 *  onto the wrong row. The UI therefore derives what it shows, and never rewrites
 *  what it stores. */
const IDENTITY_SEPARATOR = " · ";

/** Hosts worth naming. A CalDAV account is stored against a server URL, which
 *  says nothing to the person who typed their email into a box labelled Fastmail.
 *  Anything unlisted falls back to the generic protocol name rather than guessing
 *  a brand from a hostname. */
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

/** The address the person recognises: their email, without the server they had to
 *  type once and never need to see again. */
export function accountAddress(account: Pick<SyncAccount, "displayName">): string {
  const cut = account.displayName.indexOf(IDENTITY_SEPARATOR);
  return cut === -1 ? account.displayName : account.displayName.slice(0, cut);
}

/** The server half, for the one place it is load-bearing: editing the connection. */
export function accountServerUrl(account: Pick<SyncAccount, "displayName">): string | null {
  const cut = account.displayName.indexOf(IDENTITY_SEPARATOR);
  return cut === -1 ? null : account.displayName.slice(cut + IDENTITY_SEPARATOR.length);
}

/** What to call the service, given the account. Google accounts say Google; a
 *  CalDAV account says its host's brand when we know it, and "CalDAV" otherwise,
 *  which is true and beats naming a hostname at someone. */
export function accountProviderLabel(
  account: Pick<SyncAccount, "displayName" | "provider">
): string {
  if (account.provider === "google") return "Google";
  const url = accountServerUrl(account)?.toLowerCase() ?? "";
  const match = CALDAV_HOSTS.find(([host]) => url.includes(host));
  return match ? match[1] : "CalDAV";
}
