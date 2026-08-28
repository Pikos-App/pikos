A beta of 0.4.0, cut from the calendar sync branch before its QA pass is finished. It is not the default download, and nobody on 0.3.1 will be offered it by the in-app updater.

**macOS 12 or later.** Big Sur can't run this build. The recurrence engine needs a WebAssembly permission its version of WebKit doesn't support.

**Read this before installing it next to an existing Pikos.** The beta upgrades your workspace to a newer schema, and that only goes one way. Once it has opened your data, 0.3.1 will refuse to open it again until you move to 0.4.0. Either back up `~/Library/Application Support/app.pikos.desktop` first, or install the beta on a machine that has no Pikos data yet.

### Added

- **External calendar sync.** Connect Google Calendar or a CalDAV server and your events show up beside your pages. Read-only by design: Pikos never writes back.
- Events from a connected calendar behave like pages you made yourself. Complete one occurrence, skip one, move one, set a reminder on one.
- One repeat model for everything. Native and synced recurring pages now share the same occurrence set, so completing or dismissing a single occurrence works the same wherever it came from.
- A reminder on a repeating page now fires for every occurrence, not just the first. Lead times go up to a day before, and an all-day page can remind you at 9:00 the morning before.
- **Focus sessions.** Time your work from the page header. The side panels clear while it runs, and you get the length when you stop.
- **Upcoming**, a seven-day view grouped by day, with a one-press move of everything overdue onto today.
- Month view in the calendar.
- **Trash.** Deleted pages are kept for 30 days, and you restore them from the sidebar. Until now, undoing a delete meant catching the toast before it went away.
- Search operators in the palette: filter by tag, folder, status, priority and due date. A chevron switches the palette to command mode.
- Calendar export. Your scheduled pages, written out as an `.ics`.
- **`pikos`, the command-line interface, published for the first time.** Beta, same as the app. It reads and writes the same local workspace, and it speaks MCP over stdio so an agent can use it too.

### Fixed

- A window that never painted. 0.4.0-beta.1 opened, drew nothing, and no part of the app ever ran.
- Quick Add lost the repeat cadence if you hit enter before the preview caught up.
