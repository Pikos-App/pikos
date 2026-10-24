// The pieces the add-account and reconnect dialogs share: field styling, the
// app-password help page, and the providers adding an account can start from.

export const APP_PASSWORD_HELP = "https://pikos.app/calendar-sync#app-password";

export const FORM_INPUT =
  "w-full rounded border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-text-tertiary focus-visible:border-ring focus-visible:outline-none";

/** A CalDAV provider the picker names, so its user doesn't have to look up a server URL.
 *  Only providers with a real-account connect and sync pass belong here. The generic
 *  CalDAV row stays beside them, because any compliant server connects and this list
 *  must not read as the set that works. */
export interface CaldavPreset {
  name: string;
  url: string;
  usernameHint: string;
  passwordHint: string;
  helpUrl: string;
}

export const CALDAV_PRESETS: readonly CaldavPreset[] = [
  {
    helpUrl: "https://pikos.app/calendar-sync/icloud",
    name: "iCloud",
    passwordHint:
      "iCloud won't take your Apple password here. Make an app-specific password at account.apple.com, under Sign-In and Security.",
    url: "https://caldav.icloud.com",
    usernameHint: "Your Apple Account email",
  },
  {
    helpUrl: "https://pikos.app/calendar-sync/fastmail",
    name: "Fastmail",
    passwordHint:
      "Fastmail won't take your login password here. Make an app password in Settings, under Privacy & Security, with calendar access.",
    url: "https://caldav.fastmail.com",
    usernameHint: "Your full Fastmail address",
  },
];
