Fast at any size. Pikos now loads only what's on screen, so opening a page, searching, and switching views take the same time with fifty pages or half a million. The numbers, and how to check them on your own machine, are on the speed page at pikos.app/speed.

### Faster

- **Large workspaces.** Opening a page, searching, switching views, completing a task, and paging through the calendar each take under a tenth of a second, from fifty pages to half a million.
- **No more stalled saves.** Now and then a save used to take ten to twenty times longer than usual. That work now happens in the background.
- **Clicks and searches respond at once.** A page you click opens straight away, and a search runs as soon as you pause typing.

### New

- **Right-click a calendar block** to open its details.
- **Esc goes to the calendar** from any page.
- **Meeting links are links.** A Google Meet or Zoom link in a synced event's description is clickable.

### Fixed

- **The current-time line moves.** It used to stay where it was when you opened the calendar.
- **Changes from the CLI show up on their own.** Add or edit a page with `pikos` and the open app picks it up, without losing your place in the list.
- **Old repeating meetings stay gone.** Calendar sync no longer brings in series that ended before you connected, and ones already synced are cleared.
- **Each meeting shows once.** A repeating meeting no longer shows twice, and one you've ticked through to its end stays done.
- **Google descriptions read as text**, not HTML, when they were written in Google Calendar on the web.

### CLI and MCP

An assistant pointed at `pikos mcp` can now get through a normal day's work.

- **Pages read and write as Markdown.** Editing a page from the CLI or MCP keeps its formatting.
- **More to change.** Move a page to another folder, edit its tags and subtitle, clear its schedule, and rename, trash or restore folders.
- **Repeating pages.** Tick off a calendar series, and skip, move or reopen one occurrence.
- **Better answers.** List pages by when they were created or completed, see tags and the trash, and search falls back to any matching word.
